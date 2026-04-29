import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const timeEntryKeys = {
  issueEntries: (wsId: string, issueId: string) =>
    ["time-entries", wsId, "issue", issueId] as const,
  redmineActivities: (wsId: string) =>
    ["time-entries", wsId, "redmine-activities"] as const,
  dashboard: (wsId: string, start: string, end: string) =>
    ["time-entries", wsId, "dashboard", start, end] as const,
};

export function issueTimeEntriesOptions(wsId: string, issueId: string) {
  return queryOptions({
    queryKey: timeEntryKeys.issueEntries(wsId, issueId),
    queryFn: () => api.listTimeEntries(issueId),
    enabled: !!wsId && !!issueId,
  });
}

export function redmineActivitiesOptions(wsId: string) {
  return queryOptions({
    queryKey: timeEntryKeys.redmineActivities(wsId),
    queryFn: () => api.listRedmineActivities(),
    enabled: !!wsId,
    staleTime: 1000 * 60 * 30, // activities rarely change — 30 min
  });
}

export function dashboardOptions(wsId: string, start: string, end: string) {
  return queryOptions({
    queryKey: timeEntryKeys.dashboard(wsId, start, end),
    queryFn: () => api.getTimeTrackingDashboard(start, end),
    enabled: !!wsId,
  });
}
