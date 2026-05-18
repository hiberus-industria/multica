-- name: UpsertActiveTimer :one
INSERT INTO active_timer (workspace_id, issue_id, user_id, started_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (workspace_id, user_id)
DO UPDATE SET issue_id = EXCLUDED.issue_id, started_at = EXCLUDED.started_at
RETURNING *;

-- name: GetActiveTimer :one
SELECT * FROM active_timer
WHERE workspace_id = $1 AND user_id = $2;

-- name: DeleteActiveTimer :exec
DELETE FROM active_timer
WHERE workspace_id = $1 AND user_id = $2;

-- name: GetActiveTimersByIssue :many
SELECT * FROM active_timer
WHERE issue_id = $1;

-- name: DeleteActiveTimersByIssue :many
DELETE FROM active_timer
WHERE issue_id = $1
RETURNING *;
