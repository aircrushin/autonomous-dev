import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Store, ProviderLease } from '../storage/database.js';

const run = promisify(execFile);
export interface CandidateSnapshot { revision: string; changedPaths: string[]; artifactDigest: string; }
export async function snapshotCandidate(workspace: string): Promise<CandidateSnapshot> {
  const revision = (await run('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim();
  const status = (await run('git', ['status', '--porcelain=v1'], { cwd: workspace })).stdout;
  const changedPaths = status.split('\n').filter(Boolean).map(line => line.slice(3));
  const paths = (await run('git', ['ls-files', '-co', '--exclude-standard'], { cwd: workspace })).stdout.split('\n').filter(Boolean).sort();
  const hash = createHash('sha256').update(revision + '\n');
  for (const path of paths) hash.update(path + '\0').update(await readFile(`${workspace}/${path}`));
  const artifactDigest = hash.digest('hex');
  return { revision, changedPaths, artifactDigest };
}

export interface PullRequestReceipt { id: string; url: string; headRevision: string; status: string; }
const providerScopes = new WeakMap<object, number>();
let nextProviderScope = 1;
function providerScope(provider: object): number {
  const existing = providerScopes.get(provider);
  if (existing !== undefined) return existing;
  const scope = nextProviderScope++;
  providerScopes.set(provider, scope);
  return scope;
}
const pullRequestLocks = new Map<string, { headRevision: string; promise: Promise<PullRequestReceipt> }>();
export async function assertTargetRevision(repository: string, target: string, expectedRevision: string): Promise<void> {
  const current = (await run('git', ['rev-parse', target], { cwd: repository })).stdout.trim();
  if (current !== expectedRevision) throw new Error(`target branch moved from ${expectedRevision} to ${current}`);
}
export async function currentBranch(repository: string): Promise<string> {
  return (await run('git', ['branch', '--show-current'], { cwd: repository })).stdout.trim();
}

export async function commitCandidate(workspace: string, message: string, paths: string[] = ['.']): Promise<string> {
  if (!message.trim()) throw new Error('commit message is required');
  await run('git', ['add', '--', ...paths], { cwd: workspace });
  await run('git', ['-c', 'user.name=autonomous-dev', '-c', 'user.email=autonomous-dev@localhost', 'commit', '-m', message], { cwd: workspace });
  return (await run('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim();
}

export interface CiStatus { revision: string; state: 'PENDING' | 'PASS' | 'FAIL' | 'UNKNOWN'; details?: unknown; }
export interface CiProvider { getStatus(revision: string): Promise<CiStatus>; }
export async function readCiStatus(provider: CiProvider, revision: string): Promise<CiStatus> {
  const status = await provider.getStatus(revision);
  if (status.revision !== revision) throw new Error('CI status belongs to a different revision');
  return status;
}
export class ExternalWaitError extends Error { readonly code = 'WAITING_EXTERNAL'; constructor(readonly status: CiStatus) { super(`CI is not final: ${status.state}`); } }
export async function waitForCi(provider: CiProvider, revision: string, options: { maxPolls?: number; intervalMs?: number } = {}): Promise<CiStatus> {
  const maxPolls = options.maxPolls ?? 10;
  const intervalMs = options.intervalMs ?? 1000;
  if (!Number.isInteger(maxPolls) || maxPolls < 1) throw new Error('maxPolls must be a positive integer');
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('intervalMs must be a finite non-negative number');
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const status = await readCiStatus(provider, revision);
    if (status.state === 'PASS' || status.state === 'FAIL') return status;
    if (poll + 1 < maxPolls) await new Promise(resolve => setTimeout(resolve, intervalMs));
    if (poll + 1 === maxPolls) throw new ExternalWaitError(status);
  }
  throw new Error('unreachable');
}
export interface PushReceipt { id: string; revision: string; }
export interface PushProvider { findByIdempotency(key: string): Promise<PushReceipt | undefined>; push(input: { idempotencyKey: string; revision: string }): Promise<PushReceipt>; }
export interface ProviderLeaseOptions { store: Store; resourceKey: string; owner?: string; ttlMs?: number; }

/** Run one external-provider side effect under a SQLite-backed fencing lease. */
export async function withProviderLease<T>(options: ProviderLeaseOptions, operation: (lease: ProviderLease) => Promise<T>): Promise<T> {
  const owner = options.owner ?? `provider:${randomUUID()}`;
  const ttlMs = options.ttlMs ?? 30_000;
  const lease = options.store.acquireProviderLease(options.resourceKey, owner, ttlMs);
  let lost = false;
  const heartbeat = setInterval(() => {
    try { options.store.renewProviderLease(options.resourceKey, lease.token, ttlMs); }
    catch { lost = true; }
  }, Math.max(10, Math.floor(ttlMs / 3)));
  heartbeat.unref?.();
  try {
    const result = await operation(lease);
    if (lost) throw new Error('provider lease was fenced during operation');
    options.store.assertProviderLease(options.resourceKey, lease.token);
    return result;
  } finally {
    clearInterval(heartbeat);
    try { options.store.releaseProviderLease(options.resourceKey, lease.token); } catch { /* an expired/fenced lease is already unusable */ }
  }
}
const pushLocks = new Map<string, { revision: string; promise: Promise<PushReceipt> }>();
export async function pushCandidate(provider: PushProvider, input: { idempotencyKey: string; revision: string }, leaseOptions?: ProviderLeaseOptions): Promise<PushReceipt> {
  const lockKey = `${providerScope(provider)}:${input.idempotencyKey}`;
  const running = pushLocks.get(lockKey);
  if (running) {
    if (running.revision !== input.revision) throw new Error('in-flight push points to a different revision');
    return running.promise;
  }
  const body = async () => {
  const existing = await provider.findByIdempotency(input.idempotencyKey);
  if (existing) {
    if (existing.revision !== input.revision) throw new Error('existing push points to a different revision');
    return existing;
  }
  const pushed = await provider.push(input);
  if (pushed.revision !== input.revision) throw new Error('push returned a different revision');
  return pushed;
  };
  const operation = leaseOptions ? withProviderLease(leaseOptions, body) : body();
  pushLocks.set(lockKey, { revision: input.revision, promise: operation });
  try { return await operation; } finally { pushLocks.delete(lockKey); }
}
export interface PullRequestProvider { findByIdempotency(key: string): Promise<PullRequestReceipt | undefined>; create(input: { idempotencyKey: string; headRevision: string; title: string; body: string }): Promise<PullRequestReceipt>; }
export async function reconcilePullRequest(provider: PullRequestProvider, input: { idempotencyKey: string; headRevision: string; title: string; body: string }, leaseOptions?: ProviderLeaseOptions): Promise<PullRequestReceipt> {
  const lockKey = `${providerScope(provider)}:${input.idempotencyKey}`;
  const running = pullRequestLocks.get(lockKey);
  if (running) {
    if (running.headRevision !== input.headRevision) throw new Error('in-flight PR request points to a different revision');
    return running.promise;
  }
  const body = async () => {
    const existing = await provider.findByIdempotency(input.idempotencyKey);
    if (existing) {
      if (existing.headRevision !== input.headRevision) throw new Error('existing PR points to a different revision');
      return existing;
    }
    const created = await provider.create(input);
    if (created.headRevision !== input.headRevision) throw new Error('PR returned a different revision');
    return created;
  };
  const operation = leaseOptions ? withProviderLease(leaseOptions, body) : body();
  pullRequestLocks.set(lockKey, { headRevision: input.headRevision, promise: operation });
  try { return await operation; } finally { pullRequestLocks.delete(lockKey); }
}

export interface MergeReceipt { id: string; revision: string; status: string; }
export interface MergeProvider { findByIdempotency(key: string): Promise<MergeReceipt | undefined>; merge(input: { idempotencyKey: string; revision: string }): Promise<MergeReceipt>; }
const mergeLocks = new Map<string, { revision: string; promise: Promise<MergeReceipt> }>();
export async function reconcileMerge(provider: MergeProvider, input: { idempotencyKey: string; revision: string }, leaseOptions?: ProviderLeaseOptions): Promise<MergeReceipt> {
  const lockKey = `${providerScope(provider)}:${input.idempotencyKey}`;
  const running = mergeLocks.get(lockKey);
  if (running) {
    if (running.revision !== input.revision) throw new Error('in-flight merge points to a different revision');
    return running.promise;
  }
  const body = async () => {
    const existing = await provider.findByIdempotency(input.idempotencyKey);
    if (existing) {
      if (existing.revision !== input.revision) throw new Error('existing merge points to a different revision');
      if (existing.status !== 'merged') throw new Error(`existing merge is not successful: ${existing.status}`);
      return existing;
    }
    const merged = await provider.merge(input);
    if (merged.revision !== input.revision) throw new Error('merge returned a different revision');
    if (merged.status !== 'merged') throw new Error(`merge did not succeed: ${merged.status}`);
    return merged;
  };
  const operation = leaseOptions ? withProviderLease(leaseOptions, body) : body();
  mergeLocks.set(lockKey, { revision: input.revision, promise: operation });
  try { return await operation; } finally { mergeLocks.delete(lockKey); }
}
