import test from 'node:test';
import assert from 'node:assert/strict';
import type { Command, CommandExecutor, ExecResult } from '../../src/environments/types.js';
import { ContainerCommandExecutor } from '../../src/environments/container.js';

class FakeExecutor implements CommandExecutor {
  command?: Command;
  constructor(private readonly result: ExecResult = { argv: [], exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }) {}
  async exec(command: Command): Promise<ExecResult> { this.command = command; return this.result; }
}

test('ContainerCommandExecutor 构造无 shell 的 Docker argv 并显式挂载 workspace', async () => {
  const fake = new FakeExecutor();
  const executor = new ContainerCommandExecutor({
    runtime: 'podman',
    image: 'node:22',
    workspacePath: '/tmp/murex-workspace',
    containerWorkspacePath: '/workspace/project',
    readOnlyWorkspace: true,
    executor: fake
  });
  const result = await executor.exec({
    argv: ['node', '-e', 'process.stdout.write("ok")'],
    cwd: '/tmp/murex-workspace/src',
    env: { MUREX_MARKER: 'a b' },
    timeoutMs: 30,
    maxOutputBytes: 128
  });
  assert.deepEqual(result.argv, ['node', '-e', 'process.stdout.write("ok")']);
  assert.deepEqual(fake.command?.argv, [
    'podman', 'run', '--rm', '--init', '--network', 'none',
    '--workdir', '/workspace/project/src',
    '--mount', 'type=bind,src=/tmp/murex-workspace,dst=/workspace/project,readonly',
    '--env', 'MUREX_MARKER=a b', 'node:22', 'node', '-e', 'process.stdout.write("ok")'
  ]);
  assert.equal(fake.command?.timeoutMs, 30);
  assert.equal(fake.command?.maxOutputBytes, 128);
});

test('ContainerCommandExecutor 默认 workspace cwd，且保留 bounded executor 回执', async () => {
  const fake = new FakeExecutor({ argv: [], exitCode: 137, stdout: 'partial', stderr: 'timeout', timedOut: true, outputLimitExceeded: true, error: 'runtime error' });
  const executor = new ContainerCommandExecutor({ image: 'alpine:3.20', workspacePath: '/tmp/project', executor: fake });
  const result = await executor.exec({ argv: ['sh', '-c', 'ignored'] });
  assert.equal(fake.command?.argv[0], 'docker');
  assert.equal(fake.command?.argv[4], '--network');
  assert.equal(fake.command?.argv[6], '--workdir');
  assert.equal(fake.command?.argv[7], '/workspace');
  assert.equal(result.exitCode, 137);
  assert.equal(result.timedOut, true);
  assert.equal(result.outputLimitExceeded, true);
  assert.equal(result.error, 'runtime error');
  assert.deepEqual(result.argv, ['sh', '-c', 'ignored']);
});

test('ContainerCommandExecutor 拒绝缺失隔离边界或越界 cwd', async () => {
  assert.throws(() => new ContainerCommandExecutor({ image: 'alpine', workspacePath: 'relative' }), /workspacePath/);
  assert.throws(() => new ContainerCommandExecutor({ image: '-bad', workspacePath: '/tmp/project' }), /image/);
  assert.throws(() => new ContainerCommandExecutor({ image: 'alpine', workspacePath: '/tmp/project', containerWorkspacePath: 'workspace' }), /containerWorkspacePath/);
  const executor = new ContainerCommandExecutor({ image: 'alpine', workspacePath: '/tmp/project', executor: new FakeExecutor() });
  await assert.rejects(() => executor.exec({ argv: ['true'], cwd: '/tmp/project/../outside' }), /inside workspacePath/);
  await assert.rejects(() => executor.exec({ argv: ['true'], env: { 'BAD-NAME': 'x' } }), /environment variable/);
});
