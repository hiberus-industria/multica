import { create } from "zustand";
import type { ActiveTimerResponse } from "../types";

export interface ActiveTimer {
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  startedAt: number; // epoch ms — elapsed computed from Date.now() - startedAt
  activityId?: number;
  activityName?: string;
}

export interface TimerState {
  activeTimer: ActiveTimer | null;

  // Sync local state from the backend response (called after start or on init).
  setTimerFromResponse: (resp: ActiveTimerResponse) => void;
  clearTimer: () => void;
  setActivity: (id: number, name: string) => void;
}

export const useTimerStore = create<TimerState>()((set, get) => ({
  activeTimer: null,

  setTimerFromResponse: (resp) => {
    set({
      activeTimer: {
        issueId: resp.issue_id,
        issueNumber: resp.issue_number,
        issueTitle: resp.issue_title,
        startedAt: new Date(resp.started_at).getTime(),
        // Preserve locally-selected activity if the same issue timer is running.
        activityId: get().activeTimer?.issueId === resp.issue_id
          ? get().activeTimer?.activityId
          : undefined,
        activityName: get().activeTimer?.issueId === resp.issue_id
          ? get().activeTimer?.activityName
          : undefined,
      },
    });
  },

  clearTimer: () => {
    set({ activeTimer: null });
  },

  setActivity: (id, name) => {
    const timer = get().activeTimer;
    if (!timer) return;
    set({ activeTimer: { ...timer, activityId: id, activityName: name } });
  },
}));
