"use client";

import { useCallback } from "react";
import { Play, Pause } from "lucide-react";
import { useTimerStore } from "@multica/core/time-entries/timer-store";
import { useStartTimer, useStopTimer } from "@multica/core/time-entries/mutations";
import { toast } from "sonner";
import { cn } from "@multica/ui/lib/utils";

interface TimerPlayButtonProps {
  issueId: string;
  issueIdentifier: string;
  className?: string;
}

export function TimerPlayButton({
  issueId,
  issueIdentifier,
  className,
}: TimerPlayButtonProps) {
  const activeTimer = useTimerStore((s) => s.activeTimer);
  const isActive = activeTimer?.issueId === issueId;
  const isOtherRunning = !!activeTimer && !isActive;

  const startTimer = useStartTimer();
  const stopTimer = useStopTimer();

  const handlePlay = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isOtherRunning) {
        toast.info(
          `Timer running on HIB-${activeTimer!.issueNumber}. Stop it first.`,
        );
        return;
      }
      startTimer.mutate(issueId, {
        onSuccess: () => toast.success(`Timer started for ${issueIdentifier}`),
        onError: () => toast.error("Failed to start timer"),
      });
    },
    [issueId, issueIdentifier, isOtherRunning, activeTimer, startTimer],
  );

  const handleStop = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const activityId = activeTimer?.activityId;
      const activityName = activeTimer?.activityName;
      stopTimer.mutate(
        {
          redmine_activity_id: activityId,
          activity_name: activityName,
        },
        {
          onSuccess: (entry) => {
            const syncLabel =
              entry.sync_status === "synced" ? " → synced to Redmine" : "";
            toast.success(
              `Logged ${formatDurationShort(entry.duration_minutes)}${syncLabel}`,
            );
          },
          onError: () => {
            toast.error("Failed to log time entry");
          },
        },
      );
    },
    [stopTimer, activeTimer],
  );

  // Prevent DnD-kit pointer listeners on parent cards from intercepting the click
  const stopPointerPropagation = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
  }, []);

  if (isActive) {
    return (
      <button
        className={cn(
          "inline-flex items-center justify-center rounded-full size-5 bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors",
          className,
        )}
        title="Stop timer"
        onClick={handleStop}
        onPointerDown={stopPointerPropagation}
        disabled={stopTimer.isPending}
      >
        <Pause className="size-2.5 fill-current" />
      </button>
    );
  }

  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-full size-5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
        className,
      )}
      onClick={handlePlay}
      onPointerDown={stopPointerPropagation}
      title="Start timer"
      disabled={startTimer.isPending}
    >
      <Play className="size-2.5 fill-current" />
    </button>
  );
}

function formatDurationShort(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

