import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAuthorized } from '../../src/policy/authorization.js';

test('授权策略拒绝未授权动作和显式拒绝动作', () => {
  assertAuthorized({ allowedActions: ['review'] }, 'review');
  assert.throws(() => assertAuthorized({ allowedActions: ['review'] }, 'deploy'), /not authorized/);
  assert.throws(() => assertAuthorized({ allowedActions: ['deploy'], deniedActions: ['deploy'] }, 'deploy'), /denied/);
});
