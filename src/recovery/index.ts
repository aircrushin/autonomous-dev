import { createHash } from 'node:crypto';

export type FailureKind = 'TEST_FAILURE' | 'TIMEOUT' | 'DEPENDENCY' | 'RUNNER_ERROR' | 'UNKNOWN';
export function classifyFailure(input: { status: string; stderr?: string; timedOut?: boolean }): FailureKind {
  if (input.timedOut || /timeout|timed out/i.test(input.stderr ?? '')) return 'TIMEOUT';
  if (/module not found|依赖|dependency|lockfile/i.test(input.stderr ?? '')) return 'DEPENDENCY';
  if (input.status === 'FAIL' || /assert|test failed/i.test(input.stderr ?? '')) return 'TEST_FAILURE';
  if (input.status === 'ERROR') return 'RUNNER_ERROR';
  return 'UNKNOWN';
}

export class RetryController {
  private attempts = 0;
  private lastFingerprint?: string;
  constructor(private readonly maxAttempts: number) {}
  next(fingerprint: string): { retry: boolean; reason: 'RETRY' | 'NO_PROGRESS' | 'BUDGET_EXHAUSTED' } {
    if (this.lastFingerprint === fingerprint) return { retry: false, reason: 'NO_PROGRESS' };
    this.lastFingerprint = fingerprint;
    this.attempts += 1;
    return this.attempts <= this.maxAttempts ? { retry: true, reason: 'RETRY' } : { retry: false, reason: 'BUDGET_EXHAUSTED' };
  }
  get attemptCount(): number { return this.attempts; }
}

export const failureFingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface Lease { id: string; owner: string; expiresAt: number; revoked: boolean; }
export class LeaseManager {
  private readonly leases = new Map<string, Lease>();
  acquire(id: string, owner: string, ttlMs: number, now = Date.now()): Lease {
    const existing = this.leases.get(id);
    if (existing && !existing.revoked && existing.expiresAt > now && existing.owner !== owner) throw new Error('lease held by another owner');
    const lease = { id, owner, expiresAt: now + ttlMs, revoked: false };
    this.leases.set(id, lease);
    return lease;
  }
  revoke(id: string, owner: string): void { const lease = this.require(id, owner); lease.revoked = true; }
  assertWriter(id: string, owner: string, now = Date.now()): void {
    const lease = this.require(id, owner);
    if (lease.revoked || lease.expiresAt <= now) throw new Error('lease is not writable');
  }
  private require(id: string, owner: string): Lease { const lease = this.leases.get(id); if (!lease || lease.owner !== owner) throw new Error('lease not owned'); return lease; }
}

export interface ExternalReceipt { idempotencyKey: string; externalId: string; status: string; }
export interface ExternalLookup { getByIdempotency(key: string): Promise<ExternalReceipt | undefined>; execute(key: string): Promise<ExternalReceipt>; }
const reconciliationLocks = new Map<string, Promise<{ receipt: ExternalReceipt; executed: boolean }>>();
export async function reconcileOperation(api: ExternalLookup, idempotencyKey: string): Promise<{ receipt: ExternalReceipt; executed: boolean }> {
  const running = reconciliationLocks.get(idempotencyKey);
  if (running) return running;
  const operation = (async () => {
    const existing = await api.getByIdempotency(idempotencyKey);
    if (existing) return { receipt: existing, executed: false };
    return { receipt: await api.execute(idempotencyKey), executed: true };
  })();
  reconciliationLocks.set(idempotencyKey, operation);
  try { return await operation; } finally { reconciliationLocks.delete(idempotencyKey); }
}
