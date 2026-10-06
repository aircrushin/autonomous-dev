import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/storage/database.js';

test('授权策略持久化更新会自动递增版本并支持 CAS 防止旧授权覆盖新策略', () => {
  const store = new Store();
  store.createGoal({ id: 'policy-goal', userIntent: '实现功能', constraints: [], acceptanceContract: { version: 1 }, authorizationPolicy: { allowedActions: ['review'] }, budget: {} });
  assert.equal((store.getGoal('policy-goal')?.authorizationPolicy as { version: string }).version, 'v1');

  const updated = store.updateAuthorizationPolicy('policy-goal', { allowedActions: ['review', 'test'] }, { expectedVersion: 'v1', reason: '扩大低风险检查范围' });
  assert.deepEqual(updated.authorizationPolicy, { allowedActions: ['review', 'test'], version: 'v2' });
  assert.throws(() => store.updateAuthorizationPolicy('policy-goal', { allowedActions: ['deploy'] }, { expectedVersion: 'v1' }), /policy version changed/);
  assert.deepEqual(store.getGoal('policy-goal')?.authorizationPolicy, { allowedActions: ['review', 'test'], version: 'v2' });
  assert.equal(store.listEvents('policy-goal').at(-1)?.event_type, 'AUTHORIZATION_POLICY_UPDATED');
});

test('方向变更在同一事务内升级验收契约版本，并拒绝终态或旧 Goal 版本写入', () => {
  const store = new Store();
  store.createGoal({ id: 'direction-goal', userIntent: '实现功能', constraints: ['现有约束'], acceptanceContract: { version: 3, checks: ['build'] }, authorizationPolicy: {}, budget: {} });
  const before = store.getGoal('direction-goal')!;
  const updated = store.updateGoalDirection('direction-goal', { userIntent: '实现并发布功能', constraints: ['现有约束', '必须可回滚'], expectedGoalVersion: before.version, reason: '用户确认新方向' });
  assert.equal(updated.userIntent, '实现并发布功能');
  assert.deepEqual(updated.constraints, ['现有约束', '必须可回滚']);
  assert.deepEqual(updated.acceptanceContract, { version: 4, checks: ['build'] });
  assert.equal(store.listEvents('direction-goal').at(-1)?.event_type, 'GOAL_DIRECTION_UPDATED');
  assert.throws(() => store.updateGoalDirection('direction-goal', { userIntent: '过期写入', expectedGoalVersion: before.version }), /goal version changed/);

  store.transitionGoal('direction-goal', 'PLANNING');
  store.transitionGoal('direction-goal', 'RUNNING');
  store.transitionGoal('direction-goal', 'VERIFYING');
  store.transitionGoal('direction-goal', 'DELIVERING');
  store.transitionGoal('direction-goal', 'SUCCEEDED');
  assert.throws(() => store.updateGoalDirection('direction-goal', { userIntent: '终态写入' }), /cannot be updated/);
});

test('方向变更不接受空更新，并为无版本契约建立首个版本', () => {
  const store = new Store();
  store.createGoal({ id: 'direction-empty', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  assert.throws(() => store.updateGoalDirection('direction-empty', {}), /requires a change/);
  const updated = store.updateGoalDirection('direction-empty', { acceptanceContract: { checks: ['test'] } });
  assert.deepEqual(updated.acceptanceContract, { checks: ['test'], version: 1 });
});

test('策略和方向更新与审计事件处于同一事务，事件失败时完整回滚', () => {
  const policyStore = new Store();
  policyStore.createGoal({ id: 'policy-rollback', userIntent: 'x', constraints: [], acceptanceContract: { version: 1 }, authorizationPolicy: {}, budget: {} });
  policyStore.db.exec("CREATE TRIGGER fail_policy_event BEFORE INSERT ON events WHEN NEW.event_type = 'AUTHORIZATION_POLICY_UPDATED' BEGIN SELECT RAISE(ABORT, 'injected policy event failure'); END;");
  assert.throws(() => policyStore.updateAuthorizationPolicy('policy-rollback', { allowedActions: ['review'] }), /injected policy event failure/);
  assert.deepEqual(policyStore.getGoal('policy-rollback')?.authorizationPolicy, { version: 'v1' });
  policyStore.close();

  const directionStore = new Store();
  directionStore.createGoal({ id: 'direction-rollback', userIntent: 'x', constraints: [], acceptanceContract: { version: 1 }, authorizationPolicy: {}, budget: {} });
  directionStore.db.exec("CREATE TRIGGER fail_direction_event BEFORE INSERT ON events WHEN NEW.event_type = 'GOAL_DIRECTION_UPDATED' BEGIN SELECT RAISE(ABORT, 'injected direction event failure'); END;");
  assert.throws(() => directionStore.updateGoalDirection('direction-rollback', { userIntent: 'y' }), /injected direction event failure/);
  assert.equal(directionStore.getGoal('direction-rollback')?.userIntent, 'x');
  assert.deepEqual(directionStore.getGoal('direction-rollback')?.acceptanceContract, { version: 1 });
  directionStore.close();
});

test('绑定到工作项的旧契约证据会被拒绝并从 Goal 有效证据中排除', () => {
  const store = new Store();
  store.createGoal({ id: 'evidence-version', userIntent: 'x', constraints: [], acceptanceContract: { version: 2 }, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'evidence-work', goalId: 'evidence-version', description: 'x', dependencies: [] });
  assert.throws(() => store.recordEvidence({ id: 'evidence-work:old', workItemId: 'evidence-work', requirementId: 'r', contractVersion: '1', candidateDigest: 'old', checkDefinitionDigest: 'd', environmentFingerprint: 'e', inputDigest: 'i', status: 'PASS', rawArtifactRefs: [], observedAt: new Date().toISOString() }), /contract version changed/);
  store.recordEvidence({ id: 'evidence-work:new', workItemId: 'evidence-work', requirementId: 'r', contractVersion: '2', candidateDigest: 'new', checkDefinitionDigest: 'd', environmentFingerprint: 'e', inputDigest: 'i', status: 'PASS', rawArtifactRefs: [], observedAt: new Date().toISOString() });
  assert.deepEqual(store.listEvidenceForGoal('evidence-version').map(item => item.id), ['evidence-work:new']);
});
