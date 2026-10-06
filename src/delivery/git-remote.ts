import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PushProvider, PushReceipt } from './git.js';

const run = promisify(execFile);

export interface GitRemotePushOptions {
  repository: string;
  remote: string;
  branchPrefix?: string;
}

/** Git remote-backed push adapter. The remote ref is the durable idempotency receipt. */
export class GitRemotePushProvider implements PushProvider {
  private readonly repository: string;
  private readonly remote: string;
  private readonly branchPrefix: string;

  constructor(options: GitRemotePushOptions) {
    if (!options.repository || !options.remote) throw new Error('repository and remote are required');
    if (options.remote.startsWith('-')) throw new Error('remote must not start with -');
    this.repository = options.repository;
    this.remote = options.remote;
    this.branchPrefix = options.branchPrefix ?? 'autonomous-dev';
    const components = this.branchPrefix.split('/');
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(this.branchPrefix) || this.branchPrefix.includes('..') || this.branchPrefix.includes('//') || this.branchPrefix.endsWith('/') || components.some((component) => component.endsWith('.') || component.endsWith('.lock') || component === '@')) throw new Error('invalid branch prefix');
  }

  private branchFor(key: string): string {
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 24);
    return `${this.branchPrefix}/${digest}`;
  }

  async findByIdempotency(key: string): Promise<PushReceipt | undefined> {
    const branch = this.branchFor(key);
    const result = await run('git', ['ls-remote', this.remote, `refs/heads/${branch}`], { cwd: this.repository });
    const revision = result.stdout.trim().split(/\s+/)[0];
    return revision ? { id: `${this.remote}/${branch}`, revision } : undefined;
  }

  async push(input: { idempotencyKey: string; revision: string }): Promise<PushReceipt> {
    if (!/^[0-9a-f]{40,64}$/.test(input.revision)) throw new Error('revision must be a full Git object id');
    await run('git', ['cat-file', '-e', `${input.revision}^{commit}`], { cwd: this.repository });
    const branch = this.branchFor(input.idempotencyKey);
    const existing = await this.findByIdempotency(input.idempotencyKey);
    if (existing) {
      if (existing.revision !== input.revision) throw new Error('existing remote push points to a different revision');
      return existing;
    }
    const emptyRevision = '0'.repeat(40);
    try {
      await run('git', ['push', `--force-with-lease=refs/heads/${branch}:${emptyRevision}`, this.remote, `${input.revision}:refs/heads/${branch}`], { cwd: this.repository });
    } catch (error) {
      const raced = await this.findByIdempotency(input.idempotencyKey);
      if (raced?.revision === input.revision) return raced;
      throw error;
    }
    const pushed = await this.findByIdempotency(input.idempotencyKey);
    if (!pushed || pushed.revision !== input.revision) throw new Error('remote push readback revision mismatch');
    return pushed;
  }
}
