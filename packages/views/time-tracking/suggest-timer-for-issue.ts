"use client";

import type { Issue } from "@multica/core/types";
import { api } from "@multica/core/api";
import { useTimerStore } from "@multica/core/time-entries/timer-store";
import { toast } from "sonner";

/**
 * Shows a toast suggesting to start the timer for the given issue, provided
 * no timer is currently running. Uses a stable Sonner toast id to prevent
 * duplicate toasts for the same issue from appearing simultaneously.
 */
export function suggestTimerForIssue(issue: Issue) {
  if (useTimerStore.getState().activeTimer) return;

  toast("Start tracking time?", {
    id: `timer-suggest-${issue.id}`,
    description: `${issue.identifier} is now in progress`,
    action: {
      label: "Start timer",
      onClick: () => {
        if (useTimerStore.getState().activeTimer) return;
        api.startTimer(issue.id).then((resp) => {
          useTimerStore.getState().setTimerFromResponse(resp);
          toast.success(`Timer started for ${issue.identifier}`);
        }).catch(() => {
          toast.error("Failed to start timer");
        });
      },
    },
    duration: 8000,
  });
}
