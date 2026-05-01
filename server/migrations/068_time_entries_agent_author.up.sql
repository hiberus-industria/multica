-- Make user_id nullable (agents don't have a user_id)
ALTER TABLE time_entry ALTER COLUMN user_id DROP NOT NULL;

-- Add agent author fields
ALTER TABLE time_entry ADD COLUMN author_type TEXT NOT NULL DEFAULT 'user'
    CHECK (author_type IN ('user', 'agent'));
ALTER TABLE time_entry ADD COLUMN agent_id UUID REFERENCES agent(id) ON DELETE CASCADE;
ALTER TABLE time_entry ADD COLUMN agent_task_id UUID REFERENCES agent_task_queue(id) ON DELETE SET NULL;

-- Relax minimum duration to allow 1 minute
ALTER TABLE time_entry DROP CONSTRAINT time_entry_duration_minutes_check;
ALTER TABLE time_entry ADD CONSTRAINT time_entry_duration_minutes_check CHECK (duration_minutes >= 1);

-- Author integrity constraint
ALTER TABLE time_entry ADD CONSTRAINT time_entry_author_check
    CHECK (
        (author_type = 'user' AND user_id IS NOT NULL AND agent_id IS NULL)
        OR (author_type = 'agent' AND agent_id IS NOT NULL AND user_id IS NULL)
    );

-- Unique index for idempotency: one auto-logged entry per task
CREATE UNIQUE INDEX idx_time_entry_agent_task_id_unique ON time_entry (agent_task_id) WHERE agent_task_id IS NOT NULL;

CREATE INDEX idx_time_entry_agent_id ON time_entry (agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_time_entry_agent_task_id ON time_entry (agent_task_id) WHERE agent_task_id IS NOT NULL;
