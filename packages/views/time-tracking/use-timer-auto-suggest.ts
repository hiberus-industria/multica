"use client";

import { useEffect, useRef } from "react";
import type { Issue } from "@multica/core/types";
import { useTimerStore } from "@multica/core/time-entries/timer-store";
import { toast } from "sonner";

/**
 * Watches an issue's status. When it transitions to "in_progress" and no timer
 * is currently running, shows a toast suggesting to start the timer.
 */
export function useTimerAutoSuggest(issue: Issue | undefined) {
  const prevStatus = useRef(issue?.status);

  useEffect(() => {
    if (!issue) return;
    const prev = prevStatus.current;
    prevStatus.current = issue.status;

    // Only trigger on transitions *to* in_progress (not initial load)
    if (prev && prev !== "in_progress" && issue.status === "in_progress") {
      const timer = useTimerStore.getState().activeTimer;
      if (timer) return; // Timer already running

      toast("Start tracking time?", {
        description: `${issue.identifier} is now in progress`,
        action: {
          label: "Start timer",
          onClick: () => {
            useTimerStore
              .getState()
              .startTimer(issue.id, issue.identifier, issue.title);
            toast.success(`Timer started for ${issue.identifier}`);
          },
        },
        duration: 8000,
      });
    }
  }, [issue?.status, issue?.id, issue?.identifier, issue?.title]);
}
