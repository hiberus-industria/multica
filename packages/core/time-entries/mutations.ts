import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { timeEntryKeys } from "./queries";
import type { CreateTimeEntryRequest, StopTimerRequest, UpdateTimeEntryRequest } from "../types";
import { useTimerStore } from "./timer-store";

export function useCreateTimeEntry() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({
      issueId,
      data,
    }: {
      issueId: string;
      data: CreateTimeEntryRequest;
    }) => api.createTimeEntry(issueId, data),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({
        queryKey: timeEntryKeys.issueEntries(wsId, vars.issueId),
      });
    },
  });
}

export function useDeleteTimeEntry() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (vars: { entryId: string; issueId: string }) =>
      api.deleteTimeEntry(vars.entryId),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({
        queryKey: timeEntryKeys.issueEntries(wsId, vars.issueId),
      });
    },
  });
}

export function useUpdateTimeEntry() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (vars: {
      entryId: string;
      issueId: string;
      data: UpdateTimeEntryRequest;
    }) => api.updateTimeEntry(vars.entryId, vars.data),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({
        queryKey: timeEntryKeys.issueEntries(wsId, vars.issueId),
      });
    },
  });
}

export function useBulkRetrySyncFailed() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: () => api.bulkRetrySyncFailed(),
    onSettled: () => {
      // Invalidate all time entry caches since multiple issues may be affected
      qc.invalidateQueries({
        queryKey: ["time-entries", wsId],
      });
    },
  });
}

// ---- Backend-owned timer mutations ----

export const timerKeys = {
  active: (wsId: string) => ["timer", "active", wsId] as const,
};

export function useActiveTimer() {
  const wsId = useWorkspaceId();
  const setTimerFromResponse = useTimerStore((s) => s.setTimerFromResponse);
  const clearTimer = useTimerStore((s) => s.clearTimer);
  return useQuery({
    queryKey: timerKeys.active(wsId),
    queryFn: async () => {
      const resp = await api.getActiveTimer();
      if (resp) {
        setTimerFromResponse(resp);
      } else {
        clearTimer();
      }
      return resp;
    },
    staleTime: 30_000,
    enabled: !!wsId,
  });
}

export function useStartTimer() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  const setTimerFromResponse = useTimerStore((s) => s.setTimerFromResponse);
  return useMutation({
    mutationFn: (issueId: string) => api.startTimer(issueId),
    onSuccess: (resp) => {
      setTimerFromResponse(resp);
      qc.setQueryData(timerKeys.active(wsId), resp);
    },
  });
}

export function useStopTimer() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  const clearTimer = useTimerStore((s) => s.clearTimer);
  return useMutation({
    mutationFn: (data?: StopTimerRequest) => api.stopTimer(data),
    onSuccess: (entry) => {
      clearTimer();
      qc.setQueryData(timerKeys.active(wsId), null);
      // Invalidate time entries for the stopped issue.
      if (entry.issue_id) {
        qc.invalidateQueries({
          queryKey: timeEntryKeys.issueEntries(wsId, entry.issue_id),
        });
      }
    },
    onError: () => {
      // Re-sync timer state from backend on error.
      qc.invalidateQueries({ queryKey: timerKeys.active(wsId) });
    },
  });
}

export function useDiscardTimer() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  const clearTimer = useTimerStore((s) => s.clearTimer);
  return useMutation({
    mutationFn: () => api.discardTimer(),
    onSuccess: () => {
      clearTimer();
      qc.setQueryData(timerKeys.active(wsId), null);
    },
  });
}
