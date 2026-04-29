"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { dashboardOptions } from "@multica/core/time-entries/queries";
import { useWorkspaceId } from "@multica/core/hooks";
import { Clock, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@multica/ui/components/ui/chart";
import { BarChart, Bar, XAxis, YAxis, PieChart, Pie, Cell } from "recharts";

function getWeekRange(offset: number): {
  start: string;
  end: string;
  label: string;
} {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday-based
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff + offset * 7);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const fmt = (d: Date) => d.toISOString().split("T")[0]!;
  const shortFmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return {
    start: fmt(monday),
    end: fmt(sunday),
    label:
      offset === 0
        ? "This week"
        : offset === -1
          ? "Last week"
          : `${shortFmt(monday)} – ${shortFmt(sunday)}`,
  };
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const CHART_COLOR_KEYS = [
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "chart-7",
  "chart-8",
] as const;

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const dailyChartConfig = {
  hours: { label: "Hours", color: "var(--color-chart-1)" },
} satisfies ChartConfig;

const issueChartConfig = {
  hours: { label: "Hours", color: "var(--color-chart-2)" },
} satisfies ChartConfig;

export function TimeTrackingDashboard() {
  const wsId = useWorkspaceId();
  const [weekOffset, setWeekOffset] = useState(0);

  const range = useMemo(() => getWeekRange(weekOffset), [weekOffset]);

  const { data, isLoading } = useQuery(
    dashboardOptions(wsId, range.start, range.end),
  );

  const dailyData = useMemo(() => {
    if (!data?.daily) return [];
    return data.daily.map((d) => {
      const date = new Date(d.date + "T00:00:00");
      const dayIdx = (date.getDay() + 6) % 7; // Mon=0 .. Sun=6
      return {
        name: DAY_NAMES[dayIdx],
        date: d.date,
        hours: +(d.total_minutes / 60).toFixed(2),
        minutes: d.total_minutes,
      };
    });
  }, [data?.daily]);

  const activityData = useMemo(() => {
    if (!data?.by_activity) return [];
    return data.by_activity.map((a, i) => ({
      name: a.activity || "No activity",
      key: `act-${i}`,
      value: a.total_minutes,
    }));
  }, [data?.by_activity]);

  const activityChartConfig = useMemo(() => {
    return Object.fromEntries(
      activityData.map((a, i) => [
        a.key,
        {
          label: a.name,
          color: `var(--color-${CHART_COLOR_KEYS[i % CHART_COLOR_KEYS.length]})`,
        },
      ]),
    ) satisfies ChartConfig;
  }, [activityData]);

  const issueData = useMemo(() => {
    if (!data?.by_issue) return [];
    return data.by_issue
      .sort((a, b) => b.total_minutes - a.total_minutes)
      .slice(0, 10)
      .map((i) => ({
        name: `#${i.issue_number}`,
        title: i.issue_title,
        hours: +(i.total_minutes / 60).toFixed(2),
        minutes: i.total_minutes,
      }));
  }, [data?.by_issue]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="size-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Time Tracking</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            onClick={() => setWeekOffset((w) => w - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs min-w-[100px] justify-center"
            onClick={() => setWeekOffset(0)}
          >
            {range.label}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            onClick={() => setWeekOffset((w) => w + 1)}
            disabled={weekOffset >= 0}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
          Loading dashboard…
        </div>
      ) : !data || data.total_minutes === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground text-sm gap-1">
          <Clock className="size-8 mb-2 opacity-40" />
          <p>No time entries for this period</p>
          <p className="text-xs">Start a timer or log time on an issue</p>
        </div>
      ) : (
        <>
          {/* Summary stat */}
          <div className="rounded-lg border bg-card p-4">
            <p className="text-xs text-muted-foreground mb-1">Total logged</p>
            <p className="text-2xl font-bold tabular-nums">
              {formatMinutes(data.total_minutes)}
            </p>
            <p className="text-xs text-muted-foreground">
              {range.start} → {range.end} · {data.entries.length} entries
            </p>
          </div>

          {/* Charts row */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* Daily bar chart */}
            <div className="rounded-lg border bg-card p-4">
              <h2 className="text-sm font-medium mb-3">Daily breakdown</h2>
              <ChartContainer
                config={dailyChartConfig}
                className="h-[200px] w-full"
              >
                <BarChart data={dailyData}>
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `${v}h`}
                    width={35}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value) =>
                          typeof value === "number"
                            ? `${value}h`
                            : String(value)
                        }
                      />
                    }
                  />
                  <Bar
                    dataKey="hours"
                    fill="var(--color-chart-1)"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={40}
                  />
                </BarChart>
              </ChartContainer>
            </div>

            {/* Activity pie chart */}
            {activityData.length > 0 && (
              <div className="rounded-lg border bg-card p-4">
                <h2 className="text-sm font-medium mb-3">By activity</h2>
                <ChartContainer
                  config={activityChartConfig}
                  className="mx-auto aspect-square max-h-[200px]"
                >
                  <PieChart>
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          formatter={(value) =>
                            typeof value === "number"
                              ? formatMinutes(value)
                              : String(value)
                          }
                          nameKey="name"
                        />
                      }
                    />
                    <Pie
                      data={activityData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={45}
                      outerRadius={75}
                      paddingAngle={2}
                    >
                      {activityData.map((_, idx) => (
                        <Cell
                          key={idx}
                          fill={`var(--color-${CHART_COLOR_KEYS[idx % CHART_COLOR_KEYS.length]})`}
                        />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                {/* Legend */}
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                  {activityData.map((a, i) => (
                    <div
                      key={a.key}
                      className="flex items-center gap-1 text-[11px]"
                    >
                      <span
                        className="size-2 rounded-full shrink-0"
                        style={{
                          backgroundColor: `var(--color-${CHART_COLOR_KEYS[i % CHART_COLOR_KEYS.length]})`,
                        }}
                      />
                      <span className="text-muted-foreground">{a.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* By issue horizontal bar */}
          {issueData.length > 0 && (
            <div className="rounded-lg border bg-card p-4">
              <h2 className="text-sm font-medium mb-3">Top issues</h2>
              <ChartContainer
                config={issueChartConfig}
                className="w-full"
                initialDimension={{
                  width: 600,
                  height: Math.max(issueData.length * 36, 100),
                }}
              >
                <BarChart
                  data={issueData}
                  layout="vertical"
                  margin={{ left: 10 }}
                >
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `${v}h`}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={55}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value, _name, item) =>
                          typeof value === "number"
                            ? `${value}h — ${(item as { payload: { title: string } }).payload.title}`
                            : String(value)
                        }
                      />
                    }
                  />
                  <Bar
                    dataKey="hours"
                    fill="var(--color-chart-2)"
                    radius={[0, 4, 4, 0]}
                    maxBarSize={24}
                  />
                </BarChart>
              </ChartContainer>
            </div>
          )}

          {/* Entries table */}
          <div className="rounded-lg border bg-card">
            <div className="border-b px-4 py-3">
              <h2 className="text-sm font-medium">All entries</h2>
            </div>
            <div className="divide-y max-h-[400px] overflow-y-auto">
              {data.entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 px-4 py-2 text-[12px]"
                >
                  <span className="font-medium tabular-nums shrink-0 w-14">
                    {formatMinutes(entry.duration_minutes)}
                  </span>
                  <span className="text-muted-foreground shrink-0 w-12">
                    {entry.spent_on}
                  </span>
                  <span className="truncate">
                    <span className="text-muted-foreground">
                      #{entry.issue_number}
                    </span>{" "}
                    {entry.issue_title}
                  </span>
                  {entry.activity_name && (
                    <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {entry.activity_name}
                    </span>
                  )}
                  <span
                    className={cn(
                      "size-1.5 rounded-full shrink-0",
                      entry.sync_status === "synced"
                        ? "bg-emerald-500"
                        : entry.sync_status === "failed"
                          ? "bg-destructive"
                          : "bg-muted-foreground",
                    )}
                    title={entry.sync_status}
                  />
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
