-- Add estimated_hours to issue_integration_link for Redmine budget tracking
ALTER TABLE issue_integration_link ADD COLUMN estimated_hours FLOAT;

-- Add UpdateTimeEntry query support
ALTER TABLE time_entry ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
