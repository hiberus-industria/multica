"use client";

import { useCallback } from "react";
import { useWSEvent } from "@multica/core/realtime";
import { toast } from "sonner";

function formatDurationShort(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Headless guard component. Listens to timer:stopped events emitted by the
 * backend when an issue moves to a final state (done / cancelled) and shows a
 * toast to inform the user. The realtime sync layer already clears the local
 * timer store when this event arrives.
 */
export function TimerFinalStateGuard() {
  const handleTimerStopped = useCallback((payload: unknown) => {
    const { time_entry } = payload as {
      time_entry?: { duration_minutes?: number };
      user_id?: string;
    };
    const minutes = time_entry?.duration_minutes;
    if (minutes !== undefined) {
      toast.info(
        `Timer auto-stopped by backend. Logged ${formatDurationShort(minutes)}.`,
      );
    }
  }, []);

  useWSEvent("timer:stopped", handleTimerStopped);

  return null;
}
