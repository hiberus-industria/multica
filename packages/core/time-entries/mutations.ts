import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { timeEntryKeys } from "./queries";
import type { CreateTimeEntryRequest, UpdateTimeEntryRequest } from "../types";

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
