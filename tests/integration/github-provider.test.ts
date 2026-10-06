import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubProviders, GitHubApiError, GitHubPushProvider } from '../../src/delivery/github.js';

const revision = 'a'.repeat(40);
const options = (fetch: typeof globalThis.fetch) => ({ apiBaseUrl: 'https://api.example.test/', owner: 'octo', repository: 'repo', token: 'secret-token', baseBranch: 'main', fetch });
function response(body: unknown, status = 200): Response { return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('GitHub push 使用稳定分支、认证头和读回幂等', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let refExists = false;
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if ((init?.method ?? 'GET') === 'GET') return refExists ? response({ object: { sha: revision } }) : response({ message: 'missing' }, 404);
    refExists = true;
    return response({ ref: 'refs/heads/x' }, 201);
  }) as typeof globalThis.fetch;
  const provider = new GitHubPushProvider(options(fetch));
  const first = await provider.push({ idempotencyKey: 'same-key', revision });
  const second = await provider.push({ idempotencyKey: 'same-key', revision });
  assert.equal(first.revision, revision);
  assert.deepEqual(second, first);
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
  assert.match(calls[1].url, /\/git\/refs$/);
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, 'Bearer secret-token');
  assert.match(String(calls[1].init.body), /refs\/heads\/autonomous-dev\//);
});

test('GitHub PR 和 merge 复用同一幂等分支并校验 revision', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let pullExists = false;
  const pull = { number: 42, html_url: 'https://github.test/pr/42', state: 'open', head: { sha: revision }, merged_at: null as string | null };
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const method = init?.method ?? 'GET';
    if (method === 'GET') return pullExists ? response([pull]) : response([]);
    if (method === 'POST') { pullExists = true; return response(pull, 201); }
    pull.state = 'closed';
    pull.merged_at = '2026-10-06T00:00:00Z';
    return response({ merged: true, sha: revision });
  }) as typeof globalThis.fetch;
  const providers = createGitHubProviders(options(fetch));
  const created = await providers.pr.create({ idempotencyKey: 'pr-key', headRevision: revision, title: 'title', body: 'body' });
  const repeated = await providers.pr.create({ idempotencyKey: 'pr-key', headRevision: revision, title: 'title', body: 'body' });
  const merged = await providers.merge.merge({ idempotencyKey: 'pr-key', revision });
  assert.equal(created.id, '42');
  assert.deepEqual(repeated, created);
  assert.equal(merged.status, 'merged');
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
  assert.equal(calls.filter(call => call.init.method === 'PUT').length, 1);
  await assert.rejects(() => providers.merge.merge({ idempotencyKey: 'pr-key', revision: 'b'.repeat(40) }), /different revision/);
});

test('GitHub CI 将 check-runs 映射到确定性状态', async () => {
  for (const [conclusions, expected] of [
    [['success', 'success'], 'PASS'],
    [['success', 'skipped'], 'FAIL'],
    [['neutral'], 'FAIL'],
    [['timed_out'], 'FAIL'],
    [['future_terminal'], 'FAIL'],
    [[null], 'PENDING'],
    [['success', null], 'PENDING'],
    [[], 'PENDING'],
  ] as const) {
    const fetch = (async () => response({ check_runs: conclusions.map(conclusion => ({ conclusion })) })) as typeof globalThis.fetch;
    assert.equal((await createGitHubProviders(options(fetch)).ci.getStatus(revision)).state, expected, JSON.stringify(conclusions));
  }
});

test('GitHub provider 不接受无效配置、revision 或远端错误', async () => {
  const noOpFetch = (async () => response({}, 500)) as typeof globalThis.fetch;
  assert.throws(() => new GitHubPushProvider({ ...options(noOpFetch), token: '' }), /token is required/);
  assert.throws(() => new GitHubPushProvider({ ...options(noOpFetch), apiBaseUrl: 'relative' }), /absolute HTTP/);
  assert.throws(() => new GitHubPushProvider({ ...options(noOpFetch), owner: 'octo\nowner' }), /invalid characters/);
  assert.throws(() => new GitHubPushProvider({ ...options(noOpFetch), token: 'secret\0token' }), /invalid characters/);
  const fetch = (async () => response({ message: 'denied' }, 403)) as typeof globalThis.fetch;
  const provider = new GitHubPushProvider(options(fetch));
  await assert.rejects(() => provider.push({ idempotencyKey: 'x', revision: 'short' }), /full Git object id/);
  await assert.rejects(() => provider.findByIdempotency('x'), (error) => error instanceof GitHubApiError && error.status === 403);
});

test('GitHub transport 超时或抛错映射为不泄露 token 的稳定错误', async () => {
  const transport = (async (_url: string | URL, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('secret-token should not escape')));
  })) as typeof globalThis.fetch;
  const provider = new GitHubPushProvider({ ...options(transport), timeoutMs: 1 });
  await assert.rejects(() => provider.findByIdempotency('timeout'), (error) => {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.status, 0);
    assert.doesNotMatch(error.message, /secret-token/);
    assert.ok(error.cause);
    return true;
  });
});
