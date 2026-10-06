import test from 'node:test';
import assert from 'node:assert/strict';
import type { Command, CommandExecutor, ExecResult } from '../../src/environments/types.js';
import { SshWorkspaceEnvironment } from '../../src/environments/remote-workspace.js';

class FakeExecutor implements CommandExecutor {
  readonly commands: Command[] = [];
  private index = 0;
  constructor(private readonly results: ExecResult[]) {}
  async exec(command: Command): Promise<ExecResult> {
    this.commands.push(command);
    return this.results[Math.min(this.index++, this.results.length - 1)] ?? { argv: command.argv, exitCode: 0, stdout: '', stderr: '', timedOut: false };
  }
}

const ok = (stdout = ''): ExecResult => ({ argv: [], exitCode: 0, stdout, stderr: '', timedOut: false });

test('SshWorkspaceEnvironment creates, snapshots, and destroys a bounded remote workspace', async () => {
  const fake = new FakeExecutor([ok(), ok(), ok(), ok(), ok('abc123\n'), ok('abc123\n'), ok(' M src/index.ts\n?? notes.txt\n'), ok()]);
  const env = new SshWorkspaceEnvironment({ target: 'builder@example.test', workspaceRoot: '/var/tmp/murex', executor: fake });
  const handle = await env.create({ id: 'ws-1', repository: 'https://example.test/repo.git', root: '/var/tmp/murex', baseRevision: 'main' });
  assert.deepEqual(handle, { id: 'ws-1', path: '/var/tmp/murex/ws-1', baseRevision: 'abc123' });
  const snapshot = await env.snapshot(handle);
  assert.deepEqual(snapshot, { revision: 'abc123', changedPaths: ['src/index.ts', 'notes.txt'] });
  await env.destroy(handle);
  assert.deepEqual(fake.commands.map(command => command.argv), [
    ['mkdir', '-p', '--', '/var/tmp/murex'],
    ['mkdir', '--', '/var/tmp/murex/ws-1'],
    ['git', 'clone', '--', 'https://example.test/repo.git', '/var/tmp/murex/ws-1'],
    ['git', 'checkout', '--detach', '--', 'main'],
    ['git', 'rev-parse', 'HEAD'],
    ['git', 'rev-parse', 'HEAD'],
    ['git', 'status', '--porcelain=v1'],
    ['rm', '-rf', '--', '/var/tmp/murex/ws-1']
  ]);
  assert.equal(fake.commands[3]?.cwd, '/var/tmp/murex/ws-1');
});

test('SshWorkspaceEnvironment rejects forged handles and cwd escapes', async () => {
  const fake = new FakeExecutor([ok()]);
  const env = new SshWorkspaceEnvironment({ target: 'builder@example.test', workspaceRoot: '/var/tmp/murex', executor: fake });
  const handle = { id: 'ws-1', path: '/var/tmp/murex/ws-1', baseRevision: 'abc123' };
  const result = await env.exec(handle, { argv: ['true'], cwd: '/var/tmp/murex/ws-1/../outside' });
  assert.equal(result.exitCode, 126);
  assert.match(result.stderr, /outside workspace/);
  await assert.rejects(() => env.snapshot({ ...handle, path: '/tmp/elsewhere' }), /outside workspaceRoot/);
  await assert.rejects(() => env.destroy({ ...handle, id: '../escape' }), /invalid workspace id/);
  assert.equal(fake.commands.length, 0);
});

test('SshWorkspaceEnvironment cleans up after clone or revision failure', async () => {
  const fake = new FakeExecutor([
    ok(),
    ok(),
    { ...ok(), exitCode: 128, stderr: 'clone failed' },
    ok()
  ]);
  const env = new SshWorkspaceEnvironment({ target: 'builder@example.test', workspaceRoot: '/var/tmp/murex', executor: fake });
  await assert.rejects(() => env.create({ id: 'ws-fail', repository: 'repo', root: '/var/tmp/murex' }), /clone repository failed/);
  assert.deepEqual(fake.commands.map(command => command.argv), [
    ['mkdir', '-p', '--', '/var/tmp/murex'],
    ['mkdir', '--', '/var/tmp/murex/ws-fail'],
    ['git', 'clone', '--', 'repo', '/var/tmp/murex/ws-fail'],
    ['rm', '-rf', '--', '/var/tmp/murex/ws-fail']
  ]);
});

test('SshWorkspaceEnvironment never destroys a pre-existing or unreserved workspace path', async () => {
  const occupied = new FakeExecutor([ok(), { ...ok(), exitCode: 1, stderr: 'file exists' }, ok()]);
  const env = new SshWorkspaceEnvironment({ target: 'builder@example.test', workspaceRoot: '/var/tmp/murex', executor: occupied });
  await assert.rejects(() => env.create({ id: 'already-there', repository: 'repo', root: '/var/tmp/murex' }), /reserve workspace path failed/);
  assert.deepEqual(occupied.commands.map(command => command.argv), [
    ['mkdir', '-p', '--', '/var/tmp/murex'],
    ['mkdir', '--', '/var/tmp/murex/already-there']
  ]);

  const rootFailure = new FakeExecutor([{ ...ok(), exitCode: 1, stderr: 'root denied' }, ok()]);
  const env2 = new SshWorkspaceEnvironment({ target: 'builder@example.test', workspaceRoot: '/var/tmp/murex', executor: rootFailure });
  await assert.rejects(() => env2.create({ id: 'not-owned', repository: 'repo', root: '/var/tmp/murex' }), /create workspace root failed/);
  assert.deepEqual(rootFailure.commands.map(command => command.argv), [['mkdir', '-p', '--', '/var/tmp/murex']]);
});

test('SshWorkspaceEnvironment validates root, repository, and workspace tokens', async () => {
  assert.throws(() => new SshWorkspaceEnvironment({ target: 'builder', workspaceRoot: '/' }), /filesystem root/);
  const env = new SshWorkspaceEnvironment({ target: 'builder', workspaceRoot: '/var/tmp/murex', executor: new FakeExecutor([]) });
  await assert.rejects(() => env.create({ id: '../bad', repository: 'repo', root: '/var/tmp/murex' }), /invalid workspace id/);
  await assert.rejects(() => env.create({ id: 'ok', repository: 'repo', root: '/tmp/other' }), /does not match/);
});
