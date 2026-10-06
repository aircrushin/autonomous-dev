import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, failureFingerprint, LeaseManager, reconcileOperation, RetryController } from '../../src/recovery/index.js';

test('失败分类和无进展重试门禁', () => {
  assert.equal(classifyFailure({ status: 'FAIL', stderr: 'assert failed' }), 'TEST_FAILURE');
  assert.equal(classifyFailure({ status: 'ERROR', stderr: 'module not found' }), 'DEPENDENCY');
  const retry = new RetryController(2);
  assert.deepEqual(retry.next(failureFingerprint('a')), { retry: true, reason: 'RETRY' });
  assert.deepEqual(retry.next(failureFingerprint('a')), { retry: false, reason: 'NO_PROGRESS' });
});

test('租约拒绝旧写入者，外部操作先对账', async () => {
  const leases = new LeaseManager();
  leases.acquire('w1', 'new', 1000);
  assert.throws(() => leases.assertWriter('w1', 'old'), /not owned/);
  let executions = 0;
  const api = { async getByIdempotency() { return executions ? { idempotencyKey: 'k', externalId: 'e1', status: 'created' } : undefined; }, async execute(key: string) { executions += 1; return { idempotencyKey: key, externalId: 'e1', status: 'created' }; } };
  assert.equal((await reconcileOperation(api, 'k')).executed, true);
  assert.equal((await reconcileOperation(api, 'k')).executed, false);
  assert.equal(executions, 1);
  executions = 0;
  const concurrentApi = { async getByIdempotency() { await new Promise(resolve => setTimeout(resolve, 5)); return undefined; }, async execute(key: string) { executions += 1; await new Promise(resolve => setTimeout(resolve, 5)); return { idempotencyKey: key, externalId: 'e2', status: 'created' }; } };
  await Promise.all([reconcileOperation(concurrentApi, 'concurrent'), reconcileOperation(concurrentApi, 'concurrent')]);
  assert.equal(executions, 1);
});
