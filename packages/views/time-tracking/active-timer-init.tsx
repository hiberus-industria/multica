"use client";

import { useActiveTimer } from "@multica/core/time-entries/mutations";

/**
 * Headless component that hydrates the local timer store from the backend
 * on app load. Mount once in the dashboard layout.
 */
export function ActiveTimerInit() {
  useActiveTimer();
  return null;
}
