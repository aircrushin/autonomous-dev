import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/storage/database.js';
import { runControllerLoop } from '../../src/controller/loop.js';
import { CommandAgentAdapter } from '../../src/agents/command.js';
import { LocalProcessExecutor } from '../../src/environments/local-process.js';
import { GitWorktreeEnvironment } from '../../src/environments/git-worktree.js';
import { snapshotCandidate } from '../../src/delivery/git.js';
import { deliverGoalCandidate } from '../../src/delivery/goal.js';
import type { GoalPlan } from '../../src/planner/index.js';

test('MVP full lifecycle: plan, worktree coding, verify, deliver, restart and idempotent retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mvp-lifecycle-'));
  let store: Store | undefined;
  let reopened: Store | undefined;
  let workspace: Awaited<ReturnType<GitWorktreeEnvironment['create']>> | undefined;
  try {
    const repository = join(root, 'repository');
    execFileSync('git', ['init', '-q', repository]);
    writeFileSync(join(repository, 'README.md'), 'base\n');
    execFileSync('git', ['-C', repository, 'add', '.']);
    execFileSync('git', ['-C', repository, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-qm', 'init']);
    const baseRevision = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const environment = new GitWorktreeEnvironment();
    workspace = await environment.create({ id: 'mvp', repository, root: join(root, 'worktrees') });
    const executor = new LocalProcessExecutor({ inheritEnv: true });
    const agentLog = join(root, 'agent.jsonl');
    const agent = new CommandAgentAdapter(executor, agentLog);
    const plan: GoalPlan = { contractVersion: 1, requirements: [{ id: 'feature', description: 'feature file is created', checks: [{ id: 'feature-check', command: [process.execPath, '-e', "if (require('node:fs').readFileSync('feature.txt','utf8') !== 'done\\n') process.exit(1)"], required: true }] }], workItems: [{ id: 'implement', description: 'implement feature', dependencies: [] }] };
    const dbPath = join(root, 'state.sqlite');
    store = new Store(dbPath);
    store.createGoalWithPlan({ id: 'mvp-goal', userIntent: 'add feature', constraints: [], authorizationPolicy: {}, budget: {}, plan });
    const initialDigest = 'before-agent';
    const loopResult = await runControllerLoop(store, {
      goalId: 'mvp-goal',
      configure: () => ({ workspace: workspace!.path, contractVersion: '1', candidateDigest: initialDigest, environmentFingerprint: 'local', inputDigest: 'mvp-input', resolveCandidateDigest: async () => (await snapshotCandidate(workspace!.path)).artifactDigest, verificationExecutor: executor, checks: plan.requirements[0]!.checks, budget: { maxRuns: 1 } }),
      agentFor: () => ({
        async run(input: Parameters<typeof agent.run>[0]) { return agent.run({ ...input, command: [process.execPath, '-e', "require('node:fs').writeFileSync('feature.txt','done\\n')"] }); },
        async cancel(runId: string) { return agent.cancel(runId); },
        async resume(runId: string, handoff: Parameters<typeof agent.resume>[1]) { return agent.resume(runId, handoff); }
      })
    });
    assert.deepEqual(loopResult.completed, ['implement']);
    assert.equal(store.getWorkItem('implement')?.status, 'SUCCEEDED');
    assert.equal(store.getGoal('mvp-goal')?.status, 'VERIFYING');
    const evidence = store.listEvidence()[0]!;
    assert.notEqual(evidence.candidateDigest, initialDigest);
    const candidate = await snapshotCandidate(workspace.path);
    assert.equal(evidence.candidateDigest, candidate.artifactDigest);

    let pushes = 0; let prs = 0;
    const providers = { ci: { async getStatus(revision: string) { return { revision, state: 'PASS' as const }; } }, push: { async findByIdempotency() { return undefined; }, async push(input: { revision: string }) { pushes++; return { id: 'push', revision: input.revision }; } }, pr: { async findByIdempotency() { return undefined; }, async create(input: { headRevision: string }) { prs++; return { id: 'pr', url: 'u', headRevision: input.headRevision, status: 'open' }; } } };
    const delivered = await deliverGoalCandidate(store, providers, { goalId: 'mvp-goal', repository: workspace.path, target: 'HEAD', expectedTargetRevision: baseRevision, commitMessage: 'feat: add feature', operation: { actionId: 'mvp-operation', idempotencyKey: 'mvp-delivery', intendedTarget: 'pr' }, title: 'Feature', body: 'Add feature' });
    assert.equal(store.getGoal('mvp-goal')?.status, 'SUCCEEDED');
    assert.equal((store.getOperation('mvp-operation')?.externalReceipt as { headRevision: string }).headRevision, delivered.revision);
    assert.equal(delivered.revision, execFileSync('git', ['-C', workspace!.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    store.close(); store = undefined;
    reopened = new Store(dbPath);
    const retry = await deliverGoalCandidate(reopened, { ci: providers.ci, push: { async findByIdempotency() { throw new Error('duplicate push'); }, async push() { throw new Error('duplicate push'); } }, pr: { async findByIdempotency() { throw new Error('duplicate PR'); }, async create() { throw new Error('duplicate PR'); } } }, { goalId: 'mvp-goal', repository: workspace.path, target: 'HEAD', expectedTargetRevision: delivered.revision, commitMessage: 'unused', operation: { actionId: 'mvp-operation', idempotencyKey: 'mvp-delivery', intendedTarget: 'pr' }, title: 'Feature', body: 'Add feature' });
    assert.equal(retry.revision, delivered.revision); assert.equal(pushes, 1); assert.equal(prs, 1);
  } finally {
    reopened?.close(); store?.close();
    if (workspace) { try { await new GitWorktreeEnvironment().destroy(workspace); } catch { /* cleanup */ } }
    rmSync(root, { recursive: true, force: true });
  }
});
