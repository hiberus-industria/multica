"use client";

import { useState, useCallback, useMemo } from "react";
import {
  ChevronRight,
  Play,
  Plus,
  Trash2,
  Pencil,
  RefreshCw,
} from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import {
  issueTimeEntriesOptions,
  redmineActivitiesOptions,
} from "@multica/core/time-entries/queries";
import { issueIntegrationLinksOptions } from "@multica/core/integrations/queries";
import {
  useCreateTimeEntry,
  useDeleteTimeEntry,
  useUpdateTimeEntry,
  useBulkRetrySyncFailed,
} from "@multica/core/time-entries/mutations";
import { useTimerStore } from "@multica/core/time-entries/timer-store";
import { useAuthStore } from "@multica/core/auth";
import type { TimeEntry } from "@multica/core/types";
import { timeAgo } from "@multica/core/utils";
import { toast } from "sonner";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { ActorAvatar } from "../../common/actor-avatar";

// Mask gradient that fades text into transparency at the right edge,
// consistent with the Execution log section row pattern.
const ENTRY_MASK_STYLE: React.CSSProperties = {
  maskImage: "linear-gradient(to right, black calc(100% - 12px), transparent)",
  WebkitMaskImage:
    "linear-gradient(to right, black calc(100% - 12px), transparent)",
};

// Smart duration parser: "2h", "30m", "1h30m", "1.5h", "90m", "1:30"
function parseDuration(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  // "1:30" format
  const colonMatch = trimmed.match(/^(\d+):(\d{1,2})$/);
  if (colonMatch) {
    return Number(colonMatch[1]) * 60 + Number(colonMatch[2]);
  }

  // "1h30m" or "1h 30m"
  const hhmm = trimmed.match(/^(\d+(?:\.\d+)?)\s*h\s*(?:(\d+)\s*m)?$/);
  if (hhmm) {
    return Math.round(Number(hhmm[1]) * 60) + (hhmm[2] ? Number(hhmm[2]) : 0);
  }

  // "30m"
  const mOnly = trimmed.match(/^(\d+)\s*m$/);
  if (mOnly) return Number(mOnly[1]);

  // Plain number → minutes
  const plain = Number(trimmed);
  if (!isNaN(plain) && plain > 0) return Math.round(plain);

  return null;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

interface IssueTimeSectionProps {
  wsId: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
}

export function IssueTimeSection({
  wsId,
  issueId,
  issueIdentifier,
  issueTitle,
}: IssueTimeSectionProps) {
  const [open, setOpen] = useState(true);
  const [showEntries, setShowEntries] = useState(true);
  const [quickLogOpen, setQuickLogOpen] = useState(false);
  const [duration, setDuration] = useState("");
  const [logComment, setLogComment] = useState("");
  const [logActivityId, setLogActivityId] = useState<number | undefined>();
  const [logDate, setLogDate] = useState(
    () => new Date().toISOString().split("T")[0]!,
  );

  const currentUser = useAuthStore((s) => s.user);
  const activeTimer = useTimerStore((s) => s.activeTimer);
  const startTimer = useTimerStore((s) => s.startTimer);
  const { t } = useT("time-tracking");

  const { data } = useQuery(issueTimeEntriesOptions(wsId, issueId));
  const entries = data?.time_entries ?? [];
  const totalMinutes = data?.total_minutes ?? 0;
  // Use aggregated total across all Multica issues linked to the same Redmine task (when available).
  const redmineTaskTotalMinutes =
    data?.redmine_task_total_minutes ?? totalMinutes;

  const { data: activitiesData } = useQuery({
    ...redmineActivitiesOptions(wsId),
    enabled: !!wsId,
  });
  const activities = useMemo(
    () => activitiesData?.activities ?? [],
    [activitiesData?.activities],
  );

  const { data: linksData } = useQuery(
    issueIntegrationLinksOptions(wsId, issueId),
  );
  const estimatedHours = linksData?.links?.find(
    (l: { provider: string; estimated_hours: number | null }) =>
      l.provider === "redmine" && l.estimated_hours != null,
  )?.estimated_hours;
  const estimatedMinutes =
    estimatedHours != null ? Math.round(estimatedHours * 60) : null;

  const createEntry = useCreateTimeEntry();
  const deleteEntry = useDeleteTimeEntry();
  const updateEntry = useUpdateTimeEntry();
  const bulkRetry = useBulkRetrySyncFailed();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDuration, setEditDuration] = useState("");
  const [editComment, setEditComment] = useState("");
  const [editActivityId, setEditActivityId] = useState<number | undefined>();
  const [editDate, setEditDate] = useState("");

  const isTimerOnThisIssue = activeTimer?.issueId === issueId;
  const isTimerRunning = !!activeTimer;

  const handleStartTimer = useCallback(() => {
    if (isTimerOnThisIssue) return;
    if (isTimerRunning) {
      // Another issue's timer is running — for now just warn
      toast.info(
        `Timer already running on ${activeTimer!.issueIdentifier}. Stop it first.`,
      );
      return;
    }
    startTimer(issueId, issueIdentifier, issueTitle);
    toast.success(`Timer started for ${issueIdentifier}`);
  }, [
    issueId,
    issueIdentifier,
    issueTitle,
    isTimerOnThisIssue,
    isTimerRunning,
    activeTimer,
    startTimer,
  ]);

  const handleQuickLog = useCallback(() => {
    const minutes = parseDuration(duration);
    if (!minutes || minutes <= 0) {
      toast.error("Enter a valid duration (e.g. 2h, 30m, 1h30m)");
      return;
    }
    const activityName = activities.find((a) => a.id === logActivityId)?.name;
    createEntry.mutate(
      {
        issueId,
        data: {
          duration_minutes: minutes,
          redmine_activity_id: logActivityId,
          activity_name: activityName,
          comment: logComment || undefined,
          spent_on: logDate,
        },
      },
      {
        onSuccess: (entry) => {
          const syncLabel =
            entry.sync_status === "synced" ? " → synced to Redmine" : "";
          toast.success(`Logged ${formatMinutes(minutes)}${syncLabel}`);
          setDuration("");
          setLogComment("");
          setQuickLogOpen(false);
        },
        onError: () => toast.error("Failed to log time"),
      },
    );
  }, [
    duration,
    logComment,
    logActivityId,
    logDate,
    activities,
    issueId,
    createEntry,
  ]);

  const handleDelete = useCallback(
    (entry: TimeEntry) => {
      deleteEntry.mutate(
        { entryId: entry.id, issueId },
        {
          onSuccess: () => toast.success("Time entry deleted"),
          onError: () => toast.error("Failed to delete time entry"),
        },
      );
    },
    [issueId, deleteEntry],
  );

  const handleStartEdit = useCallback((entry: TimeEntry) => {
    setEditingId(entry.id);
    setEditDuration(formatMinutes(entry.duration_minutes));
    setEditComment(entry.comment || "");
    setEditActivityId(entry.redmine_activity_id ?? undefined);
    setEditDate(entry.spent_on);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (!editingId) return;
    const minutes = parseDuration(editDuration);
    if (!minutes || minutes <= 0) {
      toast.error("Enter a valid duration");
      return;
    }
    const activityName = activities.find((a) => a.id === editActivityId)?.name;
    updateEntry.mutate(
      {
        entryId: editingId,
        issueId,
        data: {
          duration_minutes: minutes,
          redmine_activity_id: editActivityId,
          activity_name: activityName,
          comment: editComment,
          spent_on: editDate,
        },
      },
      {
        onSuccess: () => {
          toast.success("Time entry updated");
          setEditingId(null);
        },
        onError: () => toast.error("Failed to update time entry"),
      },
    );
  }, [
    editingId,
    editDuration,
    editComment,
    editActivityId,
    editDate,
    activities,
    issueId,
    updateEntry,
  ]);

  const handleBulkRetry = useCallback(() => {
    bulkRetry.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(
          `Retried ${result.retried}: ${result.succeeded} synced, ${result.failed} still failed`,
        );
      },
      onError: () => toast.error("Bulk retry failed"),
    });
  }, [bulkRetry]);

  const failedCount = entries.filter((e) => e.sync_status === "failed").length;

  return (
    <div>
      {/* Collapsible header */}
      <button
        className={cn(
          "flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors mb-2 hover:bg-accent/70",
          !open && "text-muted-foreground hover:text-foreground",
        )}
        onClick={() => setOpen(!open)}
      >
        {t(($) => $.ts_header)}
        <ChevronRight
          className={cn(
            "!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>

      {open && (
        <div className="space-y-2 pl-2">
          {/* Action buttons */}
          <div className="flex gap-1.5">
            <Button
              variant={isTimerOnThisIssue ? "secondary" : "outline"}
              size="xs"
              className="flex-1 text-[11px]"
              onClick={handleStartTimer}
              disabled={isTimerOnThisIssue}
            >
              <Play className="size-3 mr-1" />
              {isTimerOnThisIssue
                ? t(($) => $.ts_timer_running)
                : t(($) => $.ts_start_timer)}
            </Button>
            <Button
              variant="outline"
              size="xs"
              className="flex-1 text-[11px]"
              onClick={() => setQuickLogOpen(!quickLogOpen)}
            >
              <Plus className="size-3 mr-1" />
              {t(($) => $.ts_quick_log)}
            </Button>
          </div>

          {/* Budget bar: estimated vs actual (aggregates hours across all Multica issues linked to the same Redmine task) */}
          {estimatedMinutes != null && estimatedMinutes > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>
                  {formatMinutes(redmineTaskTotalMinutes)} /{" "}
                  {formatMinutes(estimatedMinutes)}
                </span>
                <span>
                  {Math.round(
                    (redmineTaskTotalMinutes / estimatedMinutes) * 100,
                  )}
                  %
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-300",
                    redmineTaskTotalMinutes / estimatedMinutes > 1
                      ? "bg-destructive"
                      : redmineTaskTotalMinutes / estimatedMinutes > 0.8
                        ? "bg-yellow-500"
                        : "bg-emerald-500",
                  )}
                  style={{
                    width: `${Math.min((redmineTaskTotalMinutes / estimatedMinutes) * 100, 100)}%`,
                  }}
                />
              </div>
              {redmineTaskTotalMinutes > estimatedMinutes && (
                <p className="text-[10px] text-destructive">
                  {t(($) => $.ts_over_budget, {
                    amount: formatMinutes(
                      redmineTaskTotalMinutes - estimatedMinutes,
                    ),
                  })}
                </p>
              )}
            </div>
          )}

          {/* Quick log form */}
          {quickLogOpen && (
            <div className="animate-in slide-in-from-top-1 fade-in-0 duration-150 space-y-1.5 rounded-md border bg-muted/30 p-2">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  placeholder="Duration (2h, 30m...)"
                  className="flex-1 rounded-md border bg-background px-2 py-1 text-[11px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleQuickLog();
                  }}
                  autoFocus
                />
                <input
                  type="date"
                  className="w-28 rounded-md border bg-background px-1.5 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                  value={logDate}
                  onChange={(e) => setLogDate(e.target.value)}
                />
              </div>
              {activities.length > 0 && (
                <select
                  className="w-full rounded-md border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                  value={logActivityId ?? ""}
                  onChange={(e) =>
                    setLogActivityId(
                      e.target.value ? Number(e.target.value) : undefined,
                    )
                  }
                >
                  <option value="">Activity type...</option>
                  {activities.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              )}
              <input
                type="text"
                placeholder="Comment (optional)"
                className="w-full rounded-md border bg-background px-2 py-1 text-[11px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                value={logComment}
                onChange={(e) => setLogComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleQuickLog();
                }}
              />
              <div className="flex justify-end">
                <Button
                  size="xs"
                  className="text-[11px]"
                  onClick={handleQuickLog}
                  disabled={createEntry.isPending}
                >
                  {t(($) => $.ts_log_time)}
                </Button>
              </div>
            </div>
          )}

          {/* Retry failed button */}
          {failedCount > 0 && (
            <Button
              variant="outline"
              size="xs"
              className="w-full text-[11px] text-destructive"
              onClick={handleBulkRetry}
              disabled={bulkRetry.isPending}
            >
              <RefreshCw
                className={cn(
                  "size-3 mr-1",
                  bulkRetry.isPending && "animate-spin",
                )}
              />
              {t(($) => $.ts_retry_failed, { count: failedCount })}
            </Button>
          )}

          {/* Entries collapsible (mirrors Execution log "Hide past runs" pattern) */}
          {entries.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowEntries(!showEntries)}
                className="flex w-full items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                <ChevronRight
                  className={cn(
                    "!size-3 shrink-0 stroke-[2.5] transition-transform",
                    showEntries && "rotate-90",
                  )}
                />
                {showEntries
                  ? t(($) => $.ts_hide_entries, { count: entries.length })
                  : t(($) => $.ts_show_entries, { count: entries.length })}
                {totalMinutes > 0 && (
                  <span className="ml-auto text-[10px] font-normal tabular-nums">
                    {formatMinutes(totalMinutes)}
                  </span>
                )}
              </button>

              {showEntries && (
                <div className="mt-0.5 space-y-0.5">
                  {entries.map((entry) => {
                    const isOwn = entry.user_id === currentUser?.id;
                    const isEditing = editingId === entry.id;

                    if (isEditing) {
                      return (
                        <div
                          key={entry.id}
                          className="animate-in fade-in-0 duration-150 space-y-1.5 rounded-md border bg-muted/30 p-2"
                        >
                          <div className="flex gap-1.5">
                            <input
                              type="text"
                              placeholder="Duration"
                              className="flex-1 rounded-md border bg-background px-2 py-1 text-[11px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                              value={editDuration}
                              onChange={(e) => setEditDuration(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleSaveEdit();
                                if (e.key === "Escape") setEditingId(null);
                              }}
                              autoFocus
                            />
                            <input
                              type="date"
                              className="w-28 rounded-md border bg-background px-1.5 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                              value={editDate}
                              onChange={(e) => setEditDate(e.target.value)}
                            />
                          </div>
                          {activities.length > 0 && (
                            <select
                              className="w-full rounded-md border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
                              value={editActivityId ?? ""}
                              onChange={(e) =>
                                setEditActivityId(
                                  e.target.value
                                    ? Number(e.target.value)
                                    : undefined,
                                )
                              }
                            >
                              <option value="">Activity type...</option>
                              {activities.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                            </select>
                          )}
                          <input
                            type="text"
                            placeholder="Comment (optional)"
                            className="w-full rounded-md border bg-background px-2 py-1 text-[11px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                            value={editComment}
                            onChange={(e) => setEditComment(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSaveEdit();
                              if (e.key === "Escape") setEditingId(null);
                            }}
                          />
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="xs"
                              className="text-[11px]"
                              onClick={() => setEditingId(null)}
                            >
                              {t(($) => $.ts_cancel)}
                            </Button>
                            <Button
                              size="xs"
                              className="text-[11px]"
                              onClick={handleSaveEdit}
                              disabled={updateEntry.isPending}
                            >
                              {t(($) => $.ts_save)}
                            </Button>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <TimeEntryRow
                        key={entry.id}
                        entry={entry}
                        isOwn={isOwn}
                        onEdit={handleStartEdit}
                        onDelete={handleDelete}
                      />
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sync status visual config ─────────────────────────────────────────────

const SYNC_TONE: Record<string, string> = {
  synced: "text-emerald-500",
  pending: "text-muted-foreground",
  failed: "text-destructive",
  not_linked: "text-muted-foreground",
};

const SYNC_LABEL: Record<string, string> = {
  synced: "Synced",
  pending: "Syncing…",
  failed: "Sync failed",
  not_linked: "Not linked",
};

// ─── Time entry row ─────────────────────────────────────────────────────────

// Mirrors the RowShell / TriggerText / RowActions pattern from
// execution-log-section.tsx for visual consistency.
function TimeEntryRow({
  entry,
  isOwn,
  onEdit,
  onDelete,
}: {
  entry: TimeEntry;
  isOwn: boolean;
  onEdit: (entry: TimeEntry) => void;
  onDelete: (entry: TimeEntry) => void;
}) {
  const syncTone = SYNC_TONE[entry.sync_status] ?? SYNC_TONE.not_linked!;
  const syncLabel = SYNC_LABEL[entry.sync_status] ?? SYNC_LABEL.not_linked!;

  const description = [
    formatMinutes(entry.duration_minutes),
    entry.activity_name,
    entry.comment ? `"${entry.comment}"` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="group relative flex items-center gap-2 rounded px-1 py-1.5 transition-colors hover:bg-accent/40">
      <ActorAvatar actorType="member" actorId={entry.user_id} size={20} />
      <span
        className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-xs text-muted-foreground"
        style={ENTRY_MASK_STYLE}
      >
        {description}
      </span>
      <span className="shrink-0 whitespace-nowrap text-xs">
        <span className={syncTone}>{syncLabel}</span>
        <span className="text-muted-foreground">
          {" "}
          · {timeAgo(entry.created_at)}
        </span>
      </span>
      {isOwn && (
        <div
          className={[
            "pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 pl-6 opacity-0 transition-opacity",
            "bg-gradient-to-l from-accent/95 via-accent/80 to-transparent",
            "group-hover:pointer-events-auto group-hover:opacity-100",
            "group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          ].join(" ")}
        >
          <button
            type="button"
            className="flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            onClick={() => onEdit(entry)}
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onDelete(entry)}
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
