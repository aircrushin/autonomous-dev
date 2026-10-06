import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGoalDashboard } from '../../src/observability/dashboard.js';

test('goal dashboard 汇总当前工作项、恢复 Attempt、Operation、人工请求和预算', () => {
  const goal = { id: 'g', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: { limit: 10 }, status: 'RUNNING' as const, version: 2 };
  const ready = { id: 'w1', goalId: 'g', description: 'ready', dependencies: [], status: 'READY' as const, attemptCount: 1 };
  const done = { id: 'w2', goalId: 'g', description: 'done', dependencies: [], status: 'SUCCEEDED' as const, attemptCount: 1 };
  const summary = buildGoalDashboard({ goal, timeline: { events: [], counts: {}, failureCount: 0, humanRequestCount: 0 }, workItems: [ready, done], recoverableAttempts: [{ id: 'a', workItemId: 'w1', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: 'now' }], operations: [{ actionId: 'op', idempotencyKey: 'k', exactRevision: 'r', intendedTarget: 'pr', targetRef: 'main', reconciliationStatus: 'PENDING' }], humanRequests: [{ id: 'h1', goalId: 'g', question: 'q', context: {}, requiredAuthority: 'review', status: 'OPEN' }, { id: 'h2', goalId: 'g', question: 'q', context: {}, requiredAuthority: 'review', status: 'ANSWERED' }], evidence: [{ id: 'w1:req:1', workItemId: 'w1', requirementId: 'r', contractVersion: '1', candidateDigest: 'c', checkDefinitionDigest: 'd', environmentFingerprint: 'e', inputDigest: 'i', status: 'PASS', rawArtifactRefs: [], observedAt: 'now' }, { id: 'other', workItemId: 'other-w', requirementId: 'r', contractVersion: '1', candidateDigest: 'c', checkDefinitionDigest: 'd', environmentFingerprint: 'e', inputDigest: 'i', status: 'PASS', rawArtifactRefs: [], observedAt: 'now' }], reservedBudget: 4 });
  assert.deepEqual(summary.currentWorkItems.map(item => item.id), ['w1']);
  assert.equal(summary.recoverableAttempts.length, 1);
  assert.equal(summary.openHumanRequests.length, 1);
  assert.deepEqual(summary.evidence.map(item => item.id), ['w1:req:1']);
  assert.deepEqual(summary.budget, { reserved: 4, limit: 10 });
});

test('goal dashboard 对空事件 payload 保持可读', () => {
  const goal = { id: 'g-null', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {}, status: 'RUNNING' as const, version: 1 };
  const summary = buildGoalDashboard({ goal, timeline: { events: [{ sequence: 1, entityType: 'goal', entityId: 'g-null', eventType: 'INFO', payload: null, occurredAt: 'now' }], counts: {}, failureCount: 0, humanRequestCount: 0 }, workItems: [], recoverableAttempts: [], operations: [], humanRequests: [], evidence: [], reservedBudget: 0 });
  assert.deepEqual(summary.failureEvents, []);
});

test('goal dashboard 与 timeline 一致识别不可达终态', () => {
  const goal = { id: 'g-closed', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {}, status: 'CLOSED_UNACHIEVABLE' as const, version: 1 };
  const event = { sequence: 1, entityType: 'goal', entityId: 'g-closed', eventType: 'GOAL_STATUS_CHANGED', payload: { from: 'FAILED', to: 'CLOSED_UNACHIEVABLE' }, occurredAt: 'now' };
  const summary = buildGoalDashboard({ goal, timeline: { events: [event], counts: {}, failureCount: 1, humanRequestCount: 0 }, workItems: [], recoverableAttempts: [], operations: [], humanRequests: [], evidence: [], reservedBudget: 0 });
  assert.equal(summary.failureEvents.length, 1);
});
