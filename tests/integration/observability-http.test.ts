import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Store } from '../../src/storage/database.js';
import { createObservabilityHandler } from '../../src/observability/http.js';

test('observability HTTP handler exposes read-only metrics and dashboard formats', async () => {
  const store = new Store();
  store.createGoal({ id: 'http-goal', userIntent: 'observe', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'http-item', goalId: 'http-goal', description: 'item', dependencies: [] });
  const server = createServer(createObservabilityHandler(store));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const metrics = await fetch(`${base}/metrics?goal_id=http-goal`);
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /devctl_timeline_events_total/);
    const dashboard = await fetch(`${base}/dashboard/http-goal`);
    assert.equal(dashboard.status, 200);
    assert.deepEqual((await dashboard.json() as { goalId: string }).goalId, 'http-goal');
    const prometheus = await fetch(`${base}/dashboard/http-goal?format=prometheus`);
    assert.equal(prometheus.status, 200);
    assert.match(await prometheus.text(), /devctl_goal_status/);
    assert.equal((await fetch(`${base}/metrics?goal_id=missing`)).status, 404);
    assert.equal((await fetch(`${base}/dashboard/%E0%A4%A`)).status, 400);
    assert.equal((await fetch(`${base}/metrics`, { method: 'POST' })).status, 405);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});

test('observability HTTP handler 可在读取状态前执行调用方授权钩子', async () => {
  const store = new Store();
  store.createGoal({ id: 'auth-goal', userIntent: 'auth', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  const server = createServer(createObservabilityHandler(store, { authorize: request => request.headers.authorization === 'Bearer test' }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/timeline`)).status, 401);
    const authorized = await fetch(`${base}/timeline`, { headers: { authorization: 'Bearer test' } });
    assert.equal(authorized.status, 200);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});

test('observability 授权钩子异常时 fail closed，不让异常逃出 HTTP listener', async () => {
  const store = new Store();
  const server = createServer(createObservabilityHandler(store, { authorize: () => { throw new Error('auth backend unavailable'); } }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/timeline`)).status, 401);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});
