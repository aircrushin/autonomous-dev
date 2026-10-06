import { createHash } from 'node:crypto';
import type { CiProvider, CiStatus, MergeProvider, MergeReceipt, PullRequestProvider, PullRequestReceipt, PushProvider, PushReceipt } from './git.js';

export interface GitHubProviderOptions {
  apiBaseUrl: string;
  owner: string;
  repository: string;
  token: string;
  baseBranch: string;
  branchPrefix?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export class GitHubApiError extends Error {
  constructor(readonly status: number, readonly details: unknown, options?: ErrorOptions) { super(`GitHub API request failed: ${status}`, options); }
}

function required(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${name} contains invalid characters`);
  return value.trim();
}

function isNotFound(error: unknown): boolean { return error instanceof GitHubApiError && error.status === 404; }
function branchFor(prefix: string, key: string): string { return `${prefix}/${createHash('sha256').update(key).digest('hex').slice(0, 24)}`; }

/** Shared authenticated REST transport; concrete providers keep the existing narrow interfaces. */
export class GitHubProviderBase {
  protected readonly owner: string;
  protected readonly repository: string;
  protected readonly baseBranch: string;
  protected readonly branchPrefix: string;
  private readonly apiBaseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly transport: typeof globalThis.fetch;
  private readonly signal?: AbortSignal;

  constructor(options: GitHubProviderOptions) {
    const apiBaseUrl = required(options.apiBaseUrl, 'apiBaseUrl');
    let parsed: URL;
    try { parsed = new URL(apiBaseUrl); } catch { throw new Error('apiBaseUrl must be an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error('apiBaseUrl must be an absolute HTTP(S) URL without credentials or fragment');
    this.apiBaseUrl = parsed.toString().replace(/\/$/, '');
    this.owner = required(options.owner, 'owner');
    this.repository = required(options.repository, 'repository');
    this.token = required(options.token, 'token');
    this.baseBranch = required(options.baseBranch, 'baseBranch');
    this.branchPrefix = required(options.branchPrefix ?? 'autonomous-dev', 'branchPrefix').replace(/^\/+|\/+$/g, '');
    if (this.branchPrefix.includes('..') || this.branchPrefix.includes('//')) throw new Error('invalid branchPrefix');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error('timeoutMs must be a positive integer');
    this.transport = options.fetch ?? globalThis.fetch;
    if (typeof this.transport !== 'function') throw new Error('fetch is required');
    this.signal = options.signal;
    if (this.branchPrefix.startsWith('.') || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(this.branchPrefix) || this.branchPrefix.endsWith('/')) throw new Error('invalid branchPrefix');
  }

  protected branch(key: string): string { return branchFor(this.branchPrefix, key); }
  protected async request(path: string, init: RequestInit = {}): Promise<any> {
    let response: Response;
    try {
      response = await this.transport(`${this.apiBaseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}${path}`, {
        ...init,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        signal: init.signal ?? (this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs))
      });
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      // Keep a cause for diagnostics, but do not retain transport text that may
      // echo Authorization headers or request URLs containing credentials.
      const safeCause = error instanceof Error ? new Error(error.name || 'transport failure') : new Error('transport failure');
      throw new GitHubApiError(0, { message: 'transport or timeout failure' }, { cause: safeCause });
    }
    const text = await response.text();
    let body: unknown = undefined;
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
    if (!response.ok) throw new GitHubApiError(response.status, body);
    return body;
  }
  protected async findPull(key: string): Promise<any | undefined> {
    const body = await this.request(`/pulls?head=${encodeURIComponent(`${this.owner}:${this.branch(key)}`)}&state=all&per_page=100`);
    if (!Array.isArray(body)) throw new Error('GitHub pull request response is not an array');
    return body[0];
  }
  protected pullReceipt(pull: any): { id: string; url: string; revision: string; status: string } {
    if (typeof pull?.number !== 'number' || typeof pull?.head?.sha !== 'string') throw new Error('GitHub pull request response is incomplete');
    return { id: String(pull.number), url: String(pull.html_url ?? ''), revision: pull.head.sha, status: pull.merged_at ? 'merged' : String(pull.state ?? 'unknown') };
  }
}

export class GitHubPushProvider extends GitHubProviderBase implements PushProvider {
  async findByIdempotency(key: string): Promise<PushReceipt | undefined> {
    try {
      const body = await this.request(`/git/ref/heads/${encodeURIComponent(this.branch(key))}`);
      if (typeof body?.object?.sha !== 'string') throw new Error('GitHub ref response has no revision');
      return { id: `refs/heads/${this.branch(key)}`, revision: body.object.sha };
    } catch (error) { if (isNotFound(error)) return undefined; throw error; }
  }
  async push(input: { idempotencyKey: string; revision: string }): Promise<PushReceipt> {
    if (!/^[0-9a-f]{40,64}$/.test(input.revision)) throw new Error('revision must be a full Git object id');
    const existing = await this.findByIdempotency(input.idempotencyKey);
    if (existing) { if (existing.revision !== input.revision) throw new Error('existing GitHub ref points to a different revision'); return existing; }
    const branch = this.branch(input.idempotencyKey);
    try { await this.request('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: input.revision }) }); }
    catch (error) { const raced = await this.findByIdempotency(input.idempotencyKey); if (raced?.revision === input.revision) return raced; throw error; }
    const pushed = await this.findByIdempotency(input.idempotencyKey);
    if (!pushed || pushed.revision !== input.revision) throw new Error('GitHub ref readback revision mismatch');
    return pushed;
  }
}

export class GitHubPullRequestProvider extends GitHubProviderBase implements PullRequestProvider {
  async findByIdempotency(key: string): Promise<PullRequestReceipt | undefined> {
    const pull = await this.findPull(key);
    if (!pull) return undefined;
    const receipt = this.pullReceipt(pull);
    return { id: receipt.id, url: receipt.url, headRevision: receipt.revision, status: receipt.status };
  }
  async create(input: { idempotencyKey: string; headRevision: string; title: string; body: string }): Promise<PullRequestReceipt> {
    const existing = await this.findByIdempotency(input.idempotencyKey);
    if (existing) { if (existing.headRevision !== input.headRevision) throw new Error('existing GitHub PR points to a different revision'); return existing; }
    try {
      await this.request('/pulls', { method: 'POST', body: JSON.stringify({ title: input.title, body: input.body, head: this.branch(input.idempotencyKey), base: this.baseBranch }) });
    } catch (error) {
      const raced = await this.findByIdempotency(input.idempotencyKey);
      if (raced?.headRevision === input.headRevision) return raced;
      throw error;
    }
    const receipt = await this.findByIdempotency(input.idempotencyKey);
    if (!receipt || receipt.headRevision !== input.headRevision) throw new Error('GitHub PR readback revision mismatch');
    return receipt;
  }
}

export class GitHubMergeProvider extends GitHubProviderBase implements MergeProvider {
  async findByIdempotency(key: string): Promise<MergeReceipt | undefined> {
    const pull = await this.findPull(key);
    if (!pull) return undefined;
    const receipt = this.pullReceipt(pull);
    return { id: receipt.id, revision: receipt.revision, status: receipt.status };
  }
  async merge(input: { idempotencyKey: string; revision: string }): Promise<MergeReceipt> {
    const existing = await this.findByIdempotency(input.idempotencyKey);
    if (!existing) throw new Error('GitHub PR does not exist');
    if (existing.revision !== input.revision) throw new Error('GitHub PR points to a different revision');
    if (existing.status === 'merged') return existing;
    const body = await this.request(`/pulls/${encodeURIComponent(existing.id)}/merge`, { method: 'PUT', body: JSON.stringify({ sha: input.revision, merge_method: 'squash' }) });
    if (body?.merged !== true) throw new Error(`GitHub merge did not succeed: ${String(body?.message ?? 'unknown')}`);
    const readback = await this.findByIdempotency(input.idempotencyKey);
    if (!readback || readback.revision !== input.revision || readback.status !== 'merged') throw new Error('GitHub merge readback mismatch');
    return readback;
  }
}

export class GitHubCiProvider extends GitHubProviderBase implements CiProvider {
  async getStatus(revision: string): Promise<CiStatus> {
    const body = await this.request(`/commits/${encodeURIComponent(revision)}/check-runs?per_page=100`);
    const runs = Array.isArray(body?.check_runs) ? body.check_runs : [];
    const conclusions: string[] = runs.map((run: any) => run.conclusion).filter((value: unknown): value is string => typeof value === 'string');
    const failure = conclusions.some(value => value !== 'success');
    const complete = runs.length > 0 && runs.length === conclusions.length;
    const state = failure ? 'FAIL' : complete && conclusions.every(value => value === 'success') ? 'PASS' : 'PENDING';
    return { revision, state, details: body };
  }
}

export function createGitHubProviders(options: GitHubProviderOptions): { push: GitHubPushProvider; pr: GitHubPullRequestProvider; merge: GitHubMergeProvider; ci: GitHubCiProvider } {
  return { push: new GitHubPushProvider(options), pr: new GitHubPullRequestProvider(options), merge: new GitHubMergeProvider(options), ci: new GitHubCiProvider(options) };
}
