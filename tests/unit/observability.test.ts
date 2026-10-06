import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTimeline } from '../../src/observability/timeline.js';

test('事件时间线提供事件计数和最新时间', () => {
  const summary = summarizeTimeline([{ sequence: 2, entity_type: 'human_request', entity_id: 'h', event_type: 'HUMAN_REQUEST_ANSWERED', payload_json: '{}', occurred_at: '2026-01-01T00:01:00Z' }, { sequence: 1, entity_type: 'goal', entity_id: 'g', event_type: 'EVIDENCE_RECORDED', payload_json: '{"status":"FAIL"}', occurred_at: '2026-01-01T00:00:00Z' }, { sequence: 3, entity_type: 'human_request', entity_id: 'h', event_type: 'HUMAN_REQUEST_CREATED', payload_json: '{}', occurred_at: '2026-01-01T00:02:00Z' }]);
  assert.equal(summary.counts.EVIDENCE_RECORDED, 1);
  assert.equal(summary.failureCount, 1);
  assert.equal(summary.humanRequestCount, 1);
  assert.equal(summary.lastEventAt, '2026-01-01T00:02:00Z');
});
