import test from 'node:test';
import assert from 'node:assert/strict';
import { exportDashboardJson, exportDashboardPrometheus, exportTimelineJson, exportTimelinePrometheus, stableJson } from '../../src/observability/export.js';

test('observability JSON export sorts object keys while preserving timeline order', () => {
  assert.equal(stableJson({ z: 1, a: { y: 2, x: 3 }, events: [{ sequence: 2 }, { sequence: 1 }] }), '{\n  "a": {\n    "x": 3,\n    "y": 2\n  },\n  "events": [\n    {\n      "sequence": 2\n    },\n    {\n      "sequence": 1\n    }\n  ],\n  "z": 1\n}');
  const summary = { events: [], counts: {}, failureCount: 0, humanRequestCount: 0 };
  assert.equal(exportTimelineJson(summary), stableJson(summary));
});

test('timeline Prometheus export is deterministic and escapes labels', () => {
  const summary = {
    events: [{ sequence: 1, entityType: 'goal', entityId: 'g', eventType: 'A', payload: {}, occurredAt: '2026-01-01T00:00:00Z' }],
    counts: { A: 1 }, failureCount: 0, humanRequestCount: 0, lastEventAt: '2026-01-01T00:00:00Z'
  };
  const output = exportTimelinePrometheus(summary, { goal_id: 'g"\\\n' });
  assert.match(output, /devctl_timeline_events_total\{goal_id="g\\"\\\\\\n"\} 1/);
  assert.match(output, /devctl_timeline_event_type_total\{event_type="A",goal_id="g\\"\\\\\\n"\} 1/);
  assert.equal(output, exportTimelinePrometheus(summary, { goal_id: 'g"\\\n' }));
});

test('dashboard Prometheus export reports goal, timeline, work item, operation, evidence and budget metrics', () => {
  const dashboard = {
    goalId: 'g', goalStatus: 'RUNNING' as const,
    timeline: { events: [], counts: {}, failureCount: 0, humanRequestCount: 0 },
    workItems: [{ id: 'w', goalId: 'g', description: 'x', dependencies: [], status: 'READY' as const, attemptCount: 0 }],
    currentWorkItems: [], recoverableAttempts: [],
    operations: [{ actionId: 'a', idempotencyKey: 'k', exactRevision: 'r', intendedTarget: 'pr', reconciliationStatus: 'PENDING' as const }],
    openHumanRequests: [], evidence: [{ id: 'e', requirementId: 'r', contractVersion: '1', candidateDigest: 'c', checkDefinitionDigest: 'd', environmentFingerprint: 'e', inputDigest: 'i', status: 'PASS' as const, rawArtifactRefs: [], observedAt: 'now' }],
    failureEvents: [], budget: { reserved: 2, limit: 10 }
  };
  const output = exportDashboardPrometheus(dashboard);
  assert.match(output, /devctl_goal_status\{goal_id="g",status="RUNNING"\} 1/);
  assert.match(output, /devctl_work_items\{goal_id="g",status="READY"\} 1/);
  assert.match(output, /devctl_operations\{goal_id="g",status="PENDING"\} 1/);
  assert.match(output, /devctl_evidence\{goal_id="g",status="PASS"\} 1/);
  assert.match(output, /devctl_goal_budget_reserved\{goal_id="g"\} 2/);
  assert.match(output, /devctl_goal_budget_limit\{goal_id="g"\} 10/);
  assert.equal(exportDashboardJson(dashboard), stableJson(dashboard));
  assert.equal((output.match(/^# HELP devctl_timeline_events_total /gm) ?? []).length, 1);
});

test('dashboard Prometheus export reports attempt outcomes, duration, retry and recovery counts', () => {
  const dashboard = {
    goalId: 'g-metrics', goalStatus: 'RUNNING' as const,
    timeline: { events: [{ sequence: 1, eventType: 'RETRY_DECISION', payload: {}, entityType: 'work_item', entityId: 'w', occurredAt: '2026-01-01T00:00:00.000Z' }, { sequence: 2, eventType: 'ATTEMPT_RECOVERED', payload: {}, entityType: 'attempt', entityId: 'a', occurredAt: '2026-01-01T00:00:01.000Z' }], counts: {}, failureCount: 0, humanRequestCount: 0 },
    workItems: [], currentWorkItems: [], recoverableAttempts: [], failureEvents: [], attempts: [
      { id: 'a1', workItemId: 'w', baseRevision: 'r', workspaceId: 'ws', agent: 'a', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:02.000Z', result: { result: 'SUCCEEDED' } },
      { id: 'a2', workItemId: 'w', baseRevision: 'r', workspaceId: 'ws', agent: 'a', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:03.000Z', result: { result: 'FAILED' } }
    ], operations: [], openHumanRequests: [], evidence: [], budget: { reserved: 0 }
  };
  const output = exportDashboardPrometheus(dashboard);
  assert.match(output, /devctl_attempts_total\{goal_id="g-metrics"\} 2/);
  assert.match(output, /devctl_attempt_duration_seconds_sum\{goal_id="g-metrics"\} 5/);
  assert.match(output, /devctl_retries_total\{goal_id="g-metrics"\} 1/);
  assert.match(output, /devctl_recoveries_total\{goal_id="g-metrics"\} 1/);
});
