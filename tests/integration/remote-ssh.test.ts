import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshCommandExecutor } from '../../src/environments/remote-ssh.js';

async function fakeSsh(): Promise<{ root: string; path: string; log: string }> {
  const root = await mkdtemp(join(tmpdir(), 'murex-ssh-'));
  const path = join(root, 'fake-ssh');
  const log = join(root, 'argv.json');
  await writeFile(path, `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
await appendFile(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const remote = args.at(-1) ?? '';
if (remote.includes('emit-output')) process.stdout.write('x'.repeat(100_000));
else if (remote.includes('sleep-forever')) setTimeout(() => {}, 10_000);
else if (remote.includes('fail-remote')) { process.stderr.write('remote failure'); process.exitCode = 17; }
else process.stdout.write(remote);
`);
  await chmod(path, 0o755);
  return { root, path, log };
}

test('SshCommandExecutor 以 argv 传输并安全编码 cwd/env/参数', async () => {
  const fake = await fakeSsh();
  try {
    const executor = new SshCommandExecutor({ target: 'builder@example.test', sshPath: fake.path, port: 2222, identityFile: '/tmp/key' });
    const result = await executor.exec({ argv: ['printf', 'hello world', "it's-safe"], cwd: '/srv/app dir', env: { MUREX_MARKER: 'a b' } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.argv[0], 'printf');
    assert.match(result.stdout, /cd '\/srv\/app dir'/);
    assert.match(result.stdout, /export MUREX_MARKER='a b'/);
    assert.match(result.stdout, /'it'\\''s-safe'/);
    const args = JSON.parse((await readFile(fake.log, 'utf8')).trim()) as string[];
    assert.deepEqual(args.slice(0, 5), ['-p', '2222', '-i', '/tmp/key', '--']);
    assert.equal(args[5], 'builder@example.test');
  } finally { await rm(fake.root, { recursive: true, force: true }); }
});

test('SshCommandExecutor 复用本地 transport 的输出上限和超时证据', async () => {
  const fake = await fakeSsh();
  try {
    const executor = new SshCommandExecutor({ target: 'builder@example.test', sshPath: fake.path });
    const limited = await executor.exec({ argv: ['emit-output'], maxOutputBytes: 128 });
    assert.equal(limited.outputLimitExceeded, true);
    assert.ok(Buffer.byteLength(limited.stdout) <= 128);
    const timed = await executor.exec({ argv: ['sleep-forever'], timeoutMs: 40 });
    assert.equal(timed.timedOut, true);
    assert.notEqual(timed.exitCode, 0);
  } finally { await rm(fake.root, { recursive: true, force: true }); }
});

test('SshCommandExecutor 保留远端非零退出和启动错误诊断', async () => {
  const fake = await fakeSsh();
  try {
    const failed = await new SshCommandExecutor({ target: 'builder@example.test', sshPath: fake.path }).exec({ argv: ['fail-remote'] });
    assert.equal(failed.exitCode, 17);
    assert.equal(failed.stderr, 'remote failure');
    const missing = await new SshCommandExecutor({ target: 'builder@example.test', sshPath: '/definitely/missing/murex-ssh' }).exec({ argv: ['true'] });
    assert.notEqual(missing.exitCode, 0);
    assert.match(missing.error ?? '', /ENOENT/);
  } finally { await rm(fake.root, { recursive: true, force: true }); }
});

test('SshCommandExecutor 拒绝危险 target、端口和参数', async () => {
  assert.throws(() => new SshCommandExecutor({ target: '-oProxyCommand=bad' }), /target/);
  assert.throws(() => new SshCommandExecutor({ target: 'host', port: 0 }), /port/);
  assert.throws(() => new SshCommandExecutor({ target: 'host', options: [''] }), /options/);
  const executor = new SshCommandExecutor({ target: 'host', sshPath: process.execPath });
  await assert.rejects(() => executor.exec({ argv: [''] }), /argv/);
  await assert.rejects(() => executor.exec({ argv: ['echo'], env: { 'BAD-NAME': 'x' } }), /environment variable/);
});
