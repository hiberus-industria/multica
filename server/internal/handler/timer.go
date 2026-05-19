package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ---- Response types ----

type ActiveTimerResponse struct {
	IssueID         string `json:"issue_id"`
	IssueNumber     int32  `json:"issue_number"`
	IssueIdentifier string `json:"issue_identifier"`
	IssueTitle      string `json:"issue_title"`
	StartedAt       string `json:"started_at"`
}

// ---- Handlers ----

// GetActiveTimer returns the caller's current active timer in this workspace,
// or 404 if none exists.
func (h *Handler) GetActiveTimer(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)

	timer, err := h.Queries.GetActiveTimer(r.Context(), db.GetActiveTimerParams{
		WorkspaceID: parseUUID(workspaceID),
		UserID:      parseUUID(userID),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusOK, nil)
			return
		}
		slog.Error("failed to get active timer", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to get active timer")
		return
	}

	issue, err := h.Queries.GetIssue(r.Context(), timer.IssueID)
	if err != nil {
		slog.Error("failed to get issue for active timer", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to get timer issue")
		return
	}

	writeJSON(w, http.StatusOK, ActiveTimerResponse{
		IssueID:         uuidToString(timer.IssueID),
		IssueNumber:     issue.Number,
		IssueIdentifier: fmt.Sprintf("%s-%d", h.getIssuePrefix(r.Context(), issue.WorkspaceID), issue.Number),
		IssueTitle:      issue.Title,
		StartedAt:       timestampToString(timer.StartedAt),
	})
}

// StartTimer starts (or replaces) the caller's active timer for the given issue.
// POST /api/issues/{id}/timer/start
func (h *Handler) StartTimer(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	issueID := chi.URLParam(r, "id")

	// Verify the issue belongs to this workspace.
	issue, err := h.Queries.GetIssue(r.Context(), parseUUID(issueID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "issue not found")
			return
		}
		slog.Error("timer: failed to get issue", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to get issue")
		return
	}
	if uuidToString(issue.WorkspaceID) != workspaceID {
		writeError(w, http.StatusForbidden, "issue not in workspace")
		return
	}

	now := time.Now().UTC()
	timer, err := h.Queries.UpsertActiveTimer(r.Context(), db.UpsertActiveTimerParams{
		WorkspaceID: parseUUID(workspaceID),
		IssueID:     parseUUID(issueID),
		UserID:      parseUUID(userID),
		StartedAt:   pgtype.Timestamptz{Time: now, Valid: true},
	})
	if err != nil {
		slog.Error("timer: failed to upsert active timer", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to start timer")
		return
	}

	resp := ActiveTimerResponse{
		IssueID:         uuidToString(timer.IssueID),
		IssueNumber:     issue.Number,
		IssueIdentifier: fmt.Sprintf("%s-%d", h.getIssuePrefix(r.Context(), issue.WorkspaceID), issue.Number),
		IssueTitle:      issue.Title,
		StartedAt:       timestampToString(timer.StartedAt),
	}

	h.publish(protocol.EventTimerStarted, workspaceID, "member", userID, map[string]any{
		"timer": resp,
	})

	writeJSON(w, http.StatusOK, resp)
}

// StopTimer stops the caller's active timer, creates a time entry, and returns it.
// POST /api/timer/stop
func (h *Handler) StopTimer(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)

	var req struct {
		Comment           *string `json:"comment"`
		ActivityName      *string `json:"activity_name"`
		RedmineActivityID *int32  `json:"redmine_activity_id"`
	}
	// Decode optional body — ignore errors so the call works with an empty body.
	_ = parseOptionalJSON(r, &req)

	timer, err := h.Queries.GetActiveTimer(r.Context(), db.GetActiveTimerParams{
		WorkspaceID: parseUUID(workspaceID),
		UserID:      parseUUID(userID),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "no active timer")
			return
		}
		slog.Error("timer stop: failed to get active timer", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to get active timer")
		return
	}

	now := time.Now().UTC()
	entry, err := h.createTimeEntryFromTimer(r, workspaceID, userID, timer, now, req.Comment, req.ActivityName, req.RedmineActivityID)
	if err != nil {
		slog.Error("timer stop: failed to create time entry", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to create time entry")
		return
	}

	// Delete the active timer row.
	if delErr := h.Queries.DeleteActiveTimer(r.Context(), db.DeleteActiveTimerParams{
		WorkspaceID: parseUUID(workspaceID),
		UserID:      parseUUID(userID),
	}); delErr != nil {
		slog.Error("timer stop: failed to delete active timer row", "error", delErr)
	}

	resp := timeEntryToResponse(entry)

	h.publish(protocol.EventTimerStopped, workspaceID, "member", userID, map[string]any{
		"issue_id":   uuidToString(timer.IssueID),
		"time_entry": resp,
	})
	h.publish(protocol.EventTimeEntryCreated, workspaceID, "member", userID, map[string]any{
		"issue_id":   uuidToString(timer.IssueID),
		"time_entry": resp,
	})

	writeJSON(w, http.StatusOK, resp)
}

// DiscardTimer deletes the caller's active timer without creating a time entry.
// DELETE /api/timer
func (h *Handler) DiscardTimer(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)

	timer, err := h.Queries.GetActiveTimer(r.Context(), db.GetActiveTimerParams{
		WorkspaceID: parseUUID(workspaceID),
		UserID:      parseUUID(userID),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		slog.Error("timer discard: failed to get active timer", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to get active timer")
		return
	}

	if delErr := h.Queries.DeleteActiveTimer(r.Context(), db.DeleteActiveTimerParams{
		WorkspaceID: parseUUID(workspaceID),
		UserID:      parseUUID(userID),
	}); delErr != nil {
		slog.Error("timer discard: failed to delete timer", "error", delErr)
		writeError(w, http.StatusInternalServerError, "failed to discard timer")
		return
	}

	h.publish(protocol.EventTimerDiscarded, workspaceID, "member", userID, map[string]any{
		"issue_id": uuidToString(timer.IssueID),
	})

	w.WriteHeader(http.StatusNoContent)
}

// StopTimersForIssue stops all active timers associated with an issue (e.g. when
// the issue moves to a final state). Creates a time entry for each stopped timer.
// Called internally — not a direct HTTP handler.
func (h *Handler) StopTimersForIssue(ctx context.Context, workspaceID string, issueID pgtype.UUID) {
	timers, err := h.Queries.DeleteActiveTimersByIssue(ctx, issueID)
	if err != nil {
		slog.Error("timer: failed to stop timers for issue", "issue_id", uuidToString(issueID), "error", err)
		return
	}

	now := time.Now().UTC()
	for _, t := range timers {
		entry, err := h.createTimeEntryFromTimer(nil, workspaceID, uuidToString(t.UserID), t, now, nil, nil, nil)
		if err != nil {
			slog.Error("timer: failed to create time entry on auto-stop",
				"issue_id", uuidToString(issueID),
				"user_id", uuidToString(t.UserID),
				"error", err)
			continue
		}
		resp := timeEntryToResponse(entry)
		h.publish(protocol.EventTimerStopped, workspaceID, "system", "", map[string]any{
			"issue_id":   uuidToString(t.IssueID),
			"user_id":    uuidToString(t.UserID),
			"time_entry": resp,
		})
		h.publish(protocol.EventTimeEntryCreated, workspaceID, "system", "", map[string]any{
			"issue_id":   uuidToString(t.IssueID),
			"time_entry": resp,
		})
	}
}

// createTimeEntryFromTimer is a helper that computes duration and inserts a
// time_entry row from an active_timer. r may be nil (auto-stop path).
func (h *Handler) createTimeEntryFromTimer(
	r *http.Request,
	workspaceID, userID string,
	timer db.ActiveTimer,
	stoppedAt time.Time,
	comment *string,
	activityName *string,
	redmineActivityID *int32,
) (db.TimeEntry, error) {
	elapsed := stoppedAt.Sub(timer.StartedAt.Time)
	durationMinutes := int32(math.Max(1, math.Round(elapsed.Minutes())))

	var ctx context.Context
	if r != nil {
		ctx = r.Context()
	} else {
		ctx = context.Background()
	}

	commentStr := ""
	if comment != nil {
		commentStr = *comment
	}

	var actName pgtype.Text
	if activityName != nil {
		actName = strToText(*activityName)
	}

	var actID pgtype.Int4
	if redmineActivityID != nil {
		actID = pgtype.Int4{Int32: *redmineActivityID, Valid: true}
	}

	entry, err := h.Queries.CreateTimeEntry(ctx, db.CreateTimeEntryParams{
		WorkspaceID:       parseUUID(workspaceID),
		IssueID:           timer.IssueID,
		UserID:            parseUUID(userID),
		DurationMinutes:   durationMinutes,
		ActivityName:      actName,
		RedmineActivityID: actID,
		Comment:           commentStr,
		SpentOn:           pgtype.Date{Time: stoppedAt, Valid: true},
		SyncStatus:        "pending",
		TimerStartedAt:    timer.StartedAt,
		TimerStoppedAt:    pgtype.Timestamptz{Time: stoppedAt, Valid: true},
	})
	if err != nil {
		return db.TimeEntry{}, err
	}

	// Best-effort Redmine sync (only when we have an HTTP request context).
	if r != nil {
		h.syncTimeEntryToRedmine(r, workspaceID, userID, uuidToString(timer.IssueID), entry)
		// Re-read to get updated sync_status.
		entry, _ = h.Queries.GetTimeEntry(ctx, db.GetTimeEntryParams{
			ID:          entry.ID,
			WorkspaceID: entry.WorkspaceID,
		})
	}

	return entry, nil
}

// parseOptionalJSON is a best-effort JSON decoder that ignores EOF (empty body).
func parseOptionalJSON(r *http.Request, v any) error {
	if r.Body == nil || r.ContentLength == 0 {
		return nil
	}
	return json.NewDecoder(r.Body).Decode(v)
}
