import type { GoalDashboard } from './dashboard.js';
import type { TimelineSummary } from './timeline.js';

/**
 * Serialize an observability value with deterministic object-key ordering.
 * Arrays keep their source order because timeline order is meaningful.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map(key => [key, sortJsonValue(source[key])]));
  }
  return value;
}

export function exportTimelineJson(summary: TimelineSummary): string {
  return stableJson(summary);
}

export function exportDashboardJson(dashboard: GoalDashboard): string {
  return stableJson(dashboard);
}

type Metric = { name: string; help: string; type: 'counter' | 'gauge'; labels?: Record<string, string>; value: number };

function labelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function metricLine(metric: Metric): string {
  const labels = metric.labels
    ? `{${Object.keys(metric.labels).sort().map(key => `${key}="${labelValue(metric.labels![key])}"`).join(',')}}`
    : '';
  return `${metric.name}${labels} ${Number.isFinite(metric.value) ? metric.value : 0}`;
}

function renderMetrics(metrics: Metric[]): string {
  const byName = new Map<string, Metric[]>();
  for (const metric of metrics) byName.set(metric.name, [...(byName.get(metric.name) ?? []), metric]);
  const lines: string[] = [];
  for (const name of [...byName.keys()].sort()) {
    const group = byName.get(name)!;
    lines.push(`# HELP ${name} ${group[0].help}`);
    lines.push(`# TYPE ${name} ${group[0].type}`);
    for (const metric of group.sort((a, b) => JSON.stringify(a.labels ?? {}).localeCompare(JSON.stringify(b.labels ?? {})))) {
      lines.push(metricLine(metric));
    }
  }
  return `${lines.join('\n')}\n`;
}

function timelineMetrics(summary: TimelineSummary, labels: Record<string, string>): Metric[] {
  const metrics: Metric[] = [
    { name: 'devctl_timeline_events_total', help: 'Total events in the selected timeline.', type: 'counter', labels, value: summary.events.length },
    { name: 'devctl_timeline_failures_total', help: 'Failure events in the selected timeline.', type: 'counter', labels, value: summary.failureCount },
    { name: 'devctl_timeline_human_requests_total', help: 'Human requests in the selected timeline.', type: 'counter', labels, value: summary.humanRequestCount }
  ];
  for (const [eventType, count] of Object.entries(summary.counts).sort(([a], [b]) => a.localeCompare(b))) {
    metrics.push({ name: 'devctl_timeline_event_type_total', help: 'Events by event type in the selected timeline.', type: 'counter', labels: { ...labels, event_type: eventType }, value: count });
  }
  if (summary.lastEventAt !== undefined) {
    const seconds = Date.parse(summary.lastEventAt) / 1000;
    if (Number.isFinite(seconds)) metrics.push({ name: 'devctl_timeline_last_event_timestamp_seconds', help: 'Unix timestamp of the last event in the selected timeline.', type: 'gauge', labels, value: seconds });
  }
  return metrics;
}

export function exportTimelinePrometheus(summary: TimelineSummary, labels: Record<string, string> = {}): string {
  return renderMetrics(timelineMetrics(summary, labels));
}

export function exportDashboardPrometheus(dashboard: GoalDashboard): string {
  const goal = { goal_id: dashboard.goalId };
  const metrics: Metric[] = [
    { name: 'devctl_attempts_total', help: 'Total persisted attempts for the selected goal.', type: 'counter', labels: goal, value: (dashboard.attempts ?? []).length },
    { name: 'devctl_attempts_succeeded_total', help: 'Successful persisted attempts for the selected goal.', type: 'counter', labels: goal, value: (dashboard.attempts ?? []).filter(attempt => (attempt.result as Record<string, unknown> | undefined)?.result === 'SUCCEEDED').length },
    { name: 'devctl_attempts_failed_total', help: 'Failed persisted attempts for the selected goal.', type: 'counter', labels: goal, value: (dashboard.attempts ?? []).filter(attempt => (attempt.result as Record<string, unknown> | undefined)?.result === 'FAILED').length },
    { name: 'devctl_attempt_duration_seconds_sum', help: 'Sum of completed attempt durations in seconds.', type: 'gauge', labels: goal, value: (dashboard.attempts ?? []).reduce((sum, attempt) => { const duration = attempt.endedAt ? (Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt)) / 1000 : 0; return sum + (Number.isFinite(duration) && duration >= 0 ? duration : 0); }, 0) },
    { name: 'devctl_retries_total', help: 'Persisted retry decisions for the selected goal.', type: 'counter', labels: goal, value: dashboard.timeline.events.filter(event => /RETRY/.test(event.eventType)).length },
    { name: 'devctl_recoveries_total', help: 'Recovery events for the selected goal.', type: 'counter', labels: goal, value: dashboard.timeline.events.filter(event => /RECOVER/.test(event.eventType)).length },
    { name: 'devctl_goal_status', help: 'Current status of the selected goal.', type: 'gauge', labels: { ...goal, status: dashboard.goalStatus }, value: 1 },
    { name: 'devctl_goal_budget_reserved', help: 'Reserved budget units for the selected goal.', type: 'gauge', labels: goal, value: dashboard.budget.reserved },
    { name: 'devctl_recoverable_attempts', help: 'Recoverable attempts for the selected goal.', type: 'gauge', labels: goal, value: dashboard.recoverableAttempts.length },
    { name: 'devctl_open_human_requests', help: 'Open human requests for the selected goal.', type: 'gauge', labels: goal, value: dashboard.openHumanRequests.length },
  ];
  for (const status of ['PENDING', 'READY', 'RUNNING', 'BLOCKED', 'SUCCEEDED', 'FAILED']) {
    metrics.push({ name: 'devctl_work_items', help: 'Work items by status for the selected goal.', type: 'gauge', labels: { ...goal, status }, value: dashboard.workItems.filter(item => item.status === status).length });
  }
  for (const status of ['PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN']) {
    metrics.push({ name: 'devctl_operations', help: 'Delivery operations by reconciliation status for the selected goal.', type: 'gauge', labels: { ...goal, status }, value: dashboard.operations.filter(operation => operation.reconciliationStatus === status).length });
  }
  for (const status of ['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR']) {
    metrics.push({ name: 'devctl_evidence', help: 'Current evidence by status for the selected goal.', type: 'gauge', labels: { ...goal, status }, value: dashboard.evidence.filter(evidence => evidence.status === status).length });
  }
  if (dashboard.budget.limit !== undefined) metrics.push({ name: 'devctl_goal_budget_limit', help: 'Configured budget limit for the selected goal.', type: 'gauge', labels: goal, value: dashboard.budget.limit });
  return renderMetrics([...timelineMetrics(dashboard.timeline, goal), ...metrics]);
}
