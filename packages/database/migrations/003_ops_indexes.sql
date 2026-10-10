CREATE INDEX IF NOT EXISTS outbox_payload_event_idx ON outbox ((payload->>'id'));
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (organization_id, created_at) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS usage_events_recent_idx ON usage_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS processed_events_event_idx ON processed_events (event_id);
