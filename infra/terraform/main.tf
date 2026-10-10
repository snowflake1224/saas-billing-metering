terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}
variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "europe-west1"
}
variable "api_image" { type = string }
variable "worker_image" { type = string }
provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "apis" {
  for_each           = toset(["run.googleapis.com", "sqladmin.googleapis.com", "redis.googleapis.com", "secretmanager.googleapis.com", "vpcaccess.googleapis.com"])
  service            = each.value
  disable_on_destroy = false
}
resource "google_compute_network" "main" {
  name                    = "fb3-network"
  auto_create_subnetworks = true
}
resource "google_vpc_access_connector" "serverless" {
  name          = "fb3-serverless"
  region        = var.region
  network       = google_compute_network.main.name
  ip_cidr_range = "10.8.0.0/28"
  depends_on    = [google_project_service.apis]
}
resource "google_sql_database_instance" "postgres" {
  name                = "fb3-postgres"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = true
  settings {
    tier              = "db-custom-2-7680"
    availability_type = "REGIONAL"
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
    ip_configuration { ipv4_enabled = true }
  }
  depends_on = [google_project_service.apis]
}
resource "google_sql_database" "app" {
  name     = "fb3"
  instance = google_sql_database_instance.postgres.name
}
resource "google_redis_instance" "cache" {
  name                    = "fb3-redis"
  tier                    = "STANDARD_HA"
  memory_size_gb          = 2
  region                  = var.region
  redis_version           = "REDIS_7_2"
  authorized_network      = google_compute_network.main.id
  transit_encryption_mode = "SERVER_AUTHENTICATION"
  depends_on              = [google_project_service.apis]
}
resource "google_secret_manager_secret" "app" {
  for_each  = toset(["database-url", "jwt-access-secret", "jwt-refresh-secret", "stripe-secret-key", "stripe-webhook-secret"])
  secret_id = "fb3-${each.key}"
  replication {
    auto {}
  }
}
resource "google_service_account" "runtime" {
  account_id   = "fb3-runtime"
  display_name = "FB3 runtime"
}
resource "google_project_iam_member" "runtime_roles" {
  for_each = toset(["roles/cloudsql.client", "roles/secretmanager.secretAccessor", "roles/logging.logWriter", "roles/monitoring.metricWriter"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_cloud_run_v2_service" "api" {
  name     = "fb3-api"
  location = var.region
  template {
    service_account = google_service_account.runtime.email
    vpc_access {
      connector = google_vpc_access_connector.serverless.id
      egress    = "PRIVATE_RANGES_ONLY"
    }
    scaling {
      min_instance_count = 1
      max_instance_count = 20
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance { instances = [google_sql_database_instance.postgres.connection_name] }
    }
    containers {
      image = var.api_image
      ports { container_port = 4000 }
      resources { limits = { cpu = "2", memory = "1Gi" } }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "REDIS_URL"
        value = "rediss://${google_redis_instance.cache.host}:${google_redis_instance.cache.port}"
      }
      dynamic "env" {
        for_each = toset(["database-url", "jwt-access-secret", "jwt-refresh-secret", "stripe-secret-key", "stripe-webhook-secret"])
        content {
          name = upper(replace(env.value, "-", "_"))
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_project_iam_member.runtime_roles]
}
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
resource "google_cloud_run_v2_service" "worker" {
  name     = "fb3-worker"
  location = var.region
  template {
    service_account = google_service_account.runtime.email
    vpc_access {
      connector = google_vpc_access_connector.serverless.id
      egress    = "PRIVATE_RANGES_ONLY"
    }
    scaling {
      min_instance_count = 1
      max_instance_count = 10
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance { instances = [google_sql_database_instance.postgres.connection_name] }
    }
    containers {
      image = var.worker_image
      ports { container_port = 4001 }
      resources { limits = { cpu = "2", memory = "1Gi" } }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "REDIS_URL"
        value = "rediss://${google_redis_instance.cache.host}:${google_redis_instance.cache.port}"
      }
      dynamic "env" {
        for_each = toset(["database-url"])
        content {
          name = upper(replace(env.value, "-", "_"))
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_project_iam_member.runtime_roles]
}
output "api_url" { value = google_cloud_run_v2_service.api.uri }
# Web is deployed from apps/web to Vercel; set NEXT_PUBLIC_API_URL to api_url.
