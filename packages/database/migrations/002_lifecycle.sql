ALTER TABLE invitations ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_event_created timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;
ALTER TABLE subscriptions ALTER COLUMN status DROP DEFAULT;
ALTER TABLE subscriptions ALTER COLUMN status TYPE text USING status::text;
ALTER TABLE subscriptions ALTER COLUMN status SET DEFAULT 'active';

CREATE TABLE IF NOT EXISTS invoices (
  id text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL,
  status text NOT NULL,
  currency text NOT NULL,
  amount_due bigint NOT NULL,
  amount_paid bigint NOT NULL,
  hosted_invoice_url text,
  period_start timestamptz,
  period_end timestamptz,
  stripe_event_created timestamptz NOT NULL
);
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON invoices;
CREATE POLICY tenant_isolation ON invoices
  USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_invite_per_email
  ON invitations(organization_id,lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS unique_team_name ON teams(organization_id,lower(name));
CREATE INDEX IF NOT EXISTS usage_events_period ON usage_events(organization_id,metric,occurred_at);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox(created_at) WHERE published_at IS NULL;
