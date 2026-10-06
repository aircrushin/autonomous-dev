import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckRegistry, mandatoryQualityChecks, verifyChecks } from '../../src/verification/runner.js';
import { decideGate } from '../../src/verification/gate.js';

test('验证器区分通过、失败和超时并绑定候选', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'verify-'));
  const results = await verifyChecks({ workspace, contractVersion: 'contract-1', candidateDigest: 'candidate-1', environmentFingerprint: 'env-1', inputDigest: 'input-1', checks: [
    { id: 'pass', command: ['node', '-e', 'process.stdout.write("ok")'], required: true },
    { id: 'fail', command: ['node', '-e', 'process.exit(3)'], required: true },
    { id: 'timeout', command: ['node', '-e', 'setTimeout(()=>{},1000)'], timeoutMs: 10, required: true }
  ] });
  assert.deepEqual(results.map(r => r.status), ['PASS', 'FAIL', 'INCONCLUSIVE']);
  assert.equal(decideGate(results).result, 'COLLECT');
  assert.ok(results.every(r => r.contractVersion === 'contract-1' && r.candidateDigest === 'candidate-1' && r.checkDefinitionDigest && Array.isArray(r.rawArtifactRefs)));
  const registry = new CheckRegistry();
  registry.register({ id: 'pass', command: ['true'], required: true });
  assert.throws(() => registry.get('missing'), /not registered/);
  rmSync(workspace, { recursive: true, force: true });
});

test('注入执行器绑定检查命令并区分中断、输出截断和 transport 错误', async () => {
  const outcomes = [
    { exitCode: 0, stderr: '' },
    { exitCode: 3, stderr: 'assertion failed' },
    { exitCode: 0, stderr: '', timedOut: true },
    { exitCode: 0, stderr: '', outputLimitExceeded: true },
    { exitCode: 0, stderr: '', error: 'transport unavailable' },
    { exitCode: 0, stderr: 'warning' },
    { exitCode: 0, stderr: 'warning' }
  ];
  let calls = 0;
  const results = await verifyChecks({ workspace: '/isolated/workspace', contractVersion: 'v1', candidateDigest: 'candidate', environmentFingerprint: 'container-image', inputDigest: 'input',
    checks: outcomes.map((_, i) => ({ id: String(i), command: ['only-available-in-environment', String(i)], required: i !== 6, ...(i === 0 ? { timeoutMs: 25 } : {}) })),
    executor: { async exec(command) {
      assert.equal(command.cwd, '/isolated/workspace');
      assert.equal(command.timeoutMs, calls === 0 ? 25 : 120_000);
      assert.equal(command.maxOutputBytes, 16 * 1024 * 1024);
      assert.deepEqual(command.argv, ['only-available-in-environment', String(calls)]);
      return { argv: command.argv, stdout: 'captured', timedOut: false, ...outcomes[calls++] };
    } }
  });
  assert.equal(calls, outcomes.length);
  assert.deepEqual(results.map(result => result.status), ['PASS', 'FAIL', 'INCONCLUSIVE', 'ERROR', 'ERROR', 'PASS', 'INCONCLUSIVE']);
  assert.match(results[3].stderr, /output limit/);
  assert.match(results[4].stderr, /transport unavailable/);
  assert.ok(results.every(result => result.candidateDigest === 'candidate' && result.environmentFingerprint === 'container-image' && result.stdout === 'captured'));
});

test('执行器拒绝时记录 ERROR 并继续后续检查，不回退到本机', async () => {
  let calls = 0;
  const results = await verifyChecks({ workspace: '/remote', contractVersion: 'v1', candidateDigest: 'candidate', environmentFingerprint: 'ssh', inputDigest: 'input', checks: [
    { id: 'reject', command: ['true'], required: true },
    { id: 'next', command: ['true'], required: true }
  ], executor: { async exec(command) {
    if (calls++ === 0) throw Object.assign(new Error('executor rejected'), { code: 2 });
    return { argv: command.argv, stdout: 'remote', stderr: '', exitCode: 0, timedOut: false };
  } } });
  assert.deepEqual(results.map(result => result.status), ['ERROR', 'PASS']);
  assert.match(results[0].stderr, /executor rejected/);
  assert.equal(results[1].stdout, 'remote');
});

test('验证器将 stdout/stderr 持久化并把引用绑定到结果', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-artifacts-'));
  try {
    const results = await verifyChecks({ workspace: root, contractVersion: 'v1', candidateDigest: 'candidate', environmentFingerprint: 'local', inputDigest: 'input', artifactDir: join(root, 'artifacts'), checks: [
      { id: 'artifact-check', command: ['node', '-e', "process.stdout.write('out'); process.stderr.write('err')"], required: true }
    ] });
    assert.equal(results[0]?.status, 'PASS');
    assert.equal(results[0]?.rawArtifactRefs.length, 2);
    assert.equal(readFileSync(results[0]!.rawArtifactRefs.find(ref => ref.endsWith('-stdout.log'))!, 'utf8'), 'out');
    assert.equal(readFileSync(results[0]!.rawArtifactRefs.find(ref => ref.endsWith('-stderr.log'))!, 'utf8'), 'err');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('重复验证不会覆盖旧产物引用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-artifact-replay-'));
  try {
    const input = { workspace: root, contractVersion: 'v1', candidateDigest: 'candidate', environmentFingerprint: 'local', inputDigest: 'input', artifactDir: join(root, 'artifacts'), checks: [{ id: 'same-check', command: ['node', '-e', "process.stdout.write('out')"], required: true }] };
    const first = await verifyChecks(input);
    const second = await verifyChecks(input);
    assert.notEqual(first[0]?.rawArtifactRefs[0], second[0]?.rawArtifactRefs[0]);
    assert.equal(readFileSync(first[0]!.rawArtifactRefs.find(ref => ref.endsWith('-stdout.log'))!, 'utf8'), 'out');
    assert.equal(readFileSync(second[0]!.rawArtifactRefs.find(ref => ref.endsWith('-stdout.log'))!, 'utf8'), 'out');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('产物写入失败会将当前检查标为 ERROR 并继续后续检查', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-artifact-failure-'));
  try {
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'file');
    const results = await verifyChecks({ workspace: root, contractVersion: 'v1', candidateDigest: 'candidate', environmentFingerprint: 'local', inputDigest: 'input', artifactDir: blocked, checks: [
      { id: 'first', command: ['node', '-e', "process.stdout.write('one')"], required: true },
      { id: 'second', command: ['node', '-e', "process.stdout.write('two')"], required: true }
    ] });
    assert.deepEqual(results.map(result => result.status), ['ERROR', 'ERROR']);
    assert.match(results[0]!.stderr, /artifact persistence failed/);
    assert.equal(results[1]!.stdout, 'two');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mandatory quality profile 要求 lint/secret checks 且扫描候选 workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-quality-'));
  try {
    await assert.rejects(() => verifyChecks({ workspace: root, contractVersion: 'v1', candidateDigest: 'candidate', environmentFingerprint: 'local', inputDigest: 'input', checks: [{ id: 'custom', command: ['true'], required: true }], qualityProfile: 'mandatory' }), /mandatory quality check missing: quality-lint/);
    const checks = mandatoryQualityChecks(root);
    let results = await verifyChecks({ workspace: root, contractVersion: 'v1', candidateDigest: 'candidate', environmentFingerprint: 'local', inputDigest: 'input', checks: checks.map(check => ({ ...check, command: [check.command[0], check.command[1], root] })), qualityProfile: 'mandatory' });
    assert.deepEqual(results.map(result => result.status), ['PASS', 'PASS']);
    writeFileSync(join(root, 'bad.ts'), 'debugger; eval("x");\n');
    writeFileSync(join(root, '.env'), 'TOKEN="credential-value"\n');
    results = await verifyChecks({ workspace: root, contractVersion: 'v1', candidateDigest: 'candidate', environmentFingerprint: 'local', inputDigest: 'input', checks: mandatoryQualityChecks(root), qualityProfile: 'mandatory' });
    assert.deepEqual(results.map(result => result.status), ['FAIL', 'FAIL']);
    await assert.rejects(() => verifyChecks({ workspace: root, contractVersion: 'v1', candidateDigest: 'candidate', environmentFingerprint: 'local', inputDigest: 'input', checks: [{ id: 'quality-lint', command: ['true'], required: true }, { id: 'quality-secrets', command: ['true'], required: true }], qualityProfile: 'mandatory' }), /command mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
