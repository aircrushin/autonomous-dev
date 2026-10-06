import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalProcessExecutor } from '../../src/environments/local-process.js';

test('LocalProcessExecutor 校验默认 timeout/output 边界并执行合法默认值', async () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => new LocalProcessExecutor({ defaultTimeoutMs: value }), /defaultTimeoutMs must be a positive number/);
  }
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => new LocalProcessExecutor({ defaultMaxOutputBytes: value }), /defaultMaxOutputBytes must be a positive integer/);
  }
  const executor = new LocalProcessExecutor({ defaultTimeoutMs: 1_000, defaultMaxOutputBytes: 1_024 });
  const result = await executor.exec({ argv: [process.execPath, '-e', 'process.stdout.write("ok")'] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ok');
});

test('LocalProcessExecutor 默认不继承调用方环境且保留显式变量', async () => {
  const executor = new LocalProcessExecutor();
  const result = await executor.exec({
    argv: [process.execPath, '-e', "process.stdout.write(JSON.stringify({path: process.env.PATH, marker: process.env.MUREX_MARKER ?? null}))"],
    env: { MUREX_MARKER: 'explicit' }
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { path: process.env.PATH ?? '/usr/bin:/bin', marker: 'explicit' });
});

test('LocalProcessExecutor 超时会终止进程并返回超时证据', async () => {
  const executor = new LocalProcessExecutor();
  const result = await executor.exec({ argv: [process.execPath, '-e', 'setTimeout(() => {}, 10_000)'], timeoutMs: 40 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test('LocalProcessExecutor 对输出设置上限并终止失控进程', async () => {
  const executor = new LocalProcessExecutor();
  const result = await executor.exec({ argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(100_000))"], maxOutputBytes: 128 });
  assert.equal(result.outputLimitExceeded, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 128);
});

test('LocalProcessExecutor 对忽略 SIGTERM 的进程升级到 SIGKILL', async () => {
  const executor = new LocalProcessExecutor();
  const started = Date.now();
  const result = await executor.exec({ argv: [process.execPath, '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], timeoutMs: 40 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 2_000);
});

test('LocalProcessExecutor 保留启动错误诊断', async () => {
  const result = await new LocalProcessExecutor().exec({ argv: ['/definitely/missing/murex-command'] });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.error ?? '', /ENOENT/);
});

test('LocalProcessExecutor 拒绝空命令和非法环境名', async () => {
  const executor = new LocalProcessExecutor();
  await assert.rejects(() => executor.exec({ argv: [] }), /argv/);
  await assert.rejects(() => executor.exec({ argv: [process.execPath], env: { 'BAD-NAME': 'x' } }), /environment variable/);
});
