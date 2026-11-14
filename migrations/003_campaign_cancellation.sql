-- 003: Campaign cancellation (additive).
-- Adds 'cancelled' to the notification_campaigns status CHECK constraint.
-- The original constraint in 001_initial_schema.sql is inline and auto-named
-- notification_campaigns_status_check.

ALTER TABLE notification_campaigns
  DROP CONSTRAINT IF EXISTS notification_campaigns_status_check;

ALTER TABLE notification_campaigns
  ADD CONSTRAINT notification_campaigns_status_check
  CHECK (status IN ('queued', 'scheduled', 'processing', 'delivered', 'partial_failure', 'failed', 'cancelled'));
