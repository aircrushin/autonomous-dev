import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const run = (script: string, path: string) => spawnSync(process.execPath, [join(root, 'scripts', script), path], { cwd: root, encoding: 'utf8' });

test('lint gate passes safe source and reports forbidden constructs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-lint-'));
  try {
    writeFileSync(join(dir, 'safe.ts'), 'export const answer = 42;\n');
    const safe = run('lint.mjs', dir);
    assert.equal(safe.status, 0, safe.stderr);
    writeFileSync(join(dir, 'unsafe.ts'), 'debugger;\nconst value = eval("1");\n// @ts-ignore\nvalue;\n');
    const unsafe = run('lint.mjs', dir);
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /debugger statement/);
    assert.match(unsafe.stderr, /eval is forbidden/);
    assert.match(unsafe.stderr, /TypeScript suppression directive/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('secret scan detects dangerous names/content, ignores binary, and handles missing paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-secrets-'));
  try {
    writeFileSync(join(dir, 'safe.ts'), 'export const value = 1;\n');
    const safe = run('scan-secrets.mjs', dir);
    assert.equal(safe.status, 0, safe.stderr);
    writeFileSync(join(dir, '.env'), 'TOKEN="this-is-a-secret-token"\n');
    const bad = run('scan-secrets.mjs', dir);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /dangerous file name/);
    assert.match(bad.stderr, /credential-like assignment/);
    writeFileSync(join(dir, 'image.bin'), Buffer.from([0, 1, 2, 3, 4]));
    rmSync(join(dir, '.env'));
    const binaryOnly = run('scan-secrets.mjs', dir);
    assert.equal(binaryOnly.status, 0, binaryOnly.stderr);
    const missing = run('scan-secrets.mjs', join(dir, 'missing'));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /path does not exist/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('secret scan bounds oversized files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-size-'));
  try {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
    const result = run('scan-secrets.mjs', dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exceeds 1048576 byte limit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
