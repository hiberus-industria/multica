-- Active timer state owned by the backend.
-- One timer per user per workspace. Stopping the timer creates a time_entry.
CREATE TABLE active_timer (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    issue_id     UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, user_id)
);

CREATE INDEX idx_active_timer_workspace_user ON active_timer (workspace_id, user_id);
CREATE INDEX idx_active_timer_issue ON active_timer (issue_id);
