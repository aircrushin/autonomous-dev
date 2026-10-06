import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandAgentAdapter } from '../../src/agents/command.js';
import { LocalProcessExecutor } from '../../src/environments/local-process.js';
import { GitWorktreeEnvironment } from '../../src/environments/git-worktree.js';
import { commitCandidate, snapshotCandidate } from '../../src/delivery/git.js';
import { verifyChecks } from '../../src/verification/runner.js';

test('Phase 2 real local loop edits a Git worktree, commits a candidate, and verifies it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'autonomous-dev-phase2-'));
  const environment = new GitWorktreeEnvironment();
  let handle: Awaited<ReturnType<GitWorktreeEnvironment['create']>> | undefined;
  try {
    const repository = join(root, 'repository');
    execFileSync('git', ['init', '-q', repository]);
    writeFileSync(join(repository, 'README.md'), 'base\n');
    execFileSync('git', ['-C', repository, 'add', '.']);
    execFileSync('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init']);

    handle = await environment.create({ id: 'phase2', repository, root: join(root, 'worktrees') });
    const executor = new LocalProcessExecutor({ inheritEnv: true });
    const agent = new CommandAgentAdapter(executor, join(root, 'agent.jsonl'));
    const agentResult = await agent.run({
      runId: 'phase2-run',
      goal: 'add feature',
      workItem: 'feature',
      workspace: handle.path,
      budget: { maxRuns: 1 },
      completionCriteria: ['feature-file'],
      command: [process.execPath, '-e', "require('node:fs').writeFileSync('feature.txt','done\\n')"]
    });
    assert.equal(agentResult.result, 'SUCCEEDED');
    assert.deepEqual((await environment.snapshot(handle)).changedPaths, ['feature.txt']);

    const candidateRevision = await commitCandidate(handle.path, 'feat: add feature');
    const candidate = await snapshotCandidate(handle.path);
    assert.equal(candidate.revision, candidateRevision);
    assert.deepEqual(candidate.changedPaths, []);
    assert.ok(candidate.artifactDigest);

    const verification = await verifyChecks({
      workspace: handle.path,
      contractVersion: 'phase2-v1',
      candidateDigest: candidate.artifactDigest,
      environmentFingerprint: 'local-process-test',
      inputDigest: 'phase2-input',
      checks: [{ id: 'feature-file', command: [process.execPath, '-e', "if (require('node:fs').readFileSync('feature.txt','utf8') !== 'done\\n') process.exit(1)"], required: true }],
      executor
    });
    assert.deepEqual(verification.map(result => result.status), ['PASS']);
  } finally {
    if (handle) {
      try { await environment.destroy(handle); } catch { /* cleanup is best effort after assertion failures */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
