import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitWorktreeEnvironment } from '../../src/environments/git-worktree.js';

test('GitWorktreeEnvironment exec 不继承 Agent 环境凭据但保留显式 command.env', async () => {
  const previous = process.env.MUREX_SECRET;
  process.env.MUREX_SECRET = 'should-not-leak';
  try {
    const env = new GitWorktreeEnvironment();
    const handle = { id: 'workspace', path: process.cwd(), baseRevision: 'revision' };
    const hidden = await env.exec(handle, { argv: [process.execPath, '-e', 'process.stdout.write(process.env.MUREX_SECRET ?? "")'] });
    assert.equal(hidden.stdout, '');
    const explicit = await env.exec(handle, { argv: [process.execPath, '-e', 'process.stdout.write(process.env.MUREX_EXPLICIT ?? "")'], env: { MUREX_EXPLICIT: 'visible' } });
    assert.equal(explicit.stdout, 'visible');
  } finally {
    if (previous === undefined) delete process.env.MUREX_SECRET;
    else process.env.MUREX_SECRET = previous;
  }
});

test('Git worktree 隔离并记录命令与快照', async () => {
  const root = mkdtempSync(join(tmpdir(), 'autonomous-dev-'));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init']);
  const env = new GitWorktreeEnvironment();
  const handle = await env.create({ id: 'w1', repository: repo, root: join(root, 'worktrees') });
  const result = await env.exec(handle, { argv: ['node', '-e', "require('node:fs').writeFileSync('file.txt','changed\\n')"] });
  assert.equal(result.exitCode, 0);
  assert.deepEqual((await env.snapshot(handle)).changedPaths, ['file.txt']);
  await env.destroy(handle);
  rmSync(root, { recursive: true, force: true });
});

test('GitWorktreeEnvironment.exec 拒绝 symlink 外指并对不存在 cwd 返回受控失败', async () => {
  const root = mkdtempSync(join(tmpdir(), 'autonomous-dev-cwd-'));
  const repo = join(root, 'repo');
  const outside = join(root, 'outside');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init']);
  const env = new GitWorktreeEnvironment();
  const handle = await env.create({ id: 'w1', repository: repo, root: join(root, 'worktrees') });
  mkdirSync(outside);
  symlinkSync(outside, join(handle.path, 'escape'));
  const escaped = await env.exec(handle, { argv: [process.execPath, '-e', 'process.exit(99)'], cwd: join(handle.path, 'escape') });
  assert.equal(escaped.exitCode, 126);
  assert.match(escaped.stderr, /outside workspace/);
  const missing = await env.exec(handle, { argv: [process.execPath, '-e', 'process.exit(99)'], cwd: join(handle.path, 'missing') });
  assert.equal(missing.exitCode, 126);
  assert.match(missing.stderr, /unavailable/);
  const nested = join(handle.path, 'nested');
  mkdirSync(nested);
  const normal = await env.exec(handle, { argv: [process.execPath, '-e', 'process.stdout.write(process.cwd())'], cwd: nested });
  assert.equal(normal.exitCode, 0);
  assert.equal(normal.stdout, realpathSync(nested));
  assert.equal(existsSync(join(outside, 'created')), false);
  await env.destroy(handle);
  rmSync(root, { recursive: true, force: true });
});
