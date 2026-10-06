#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['src', 'apps'];
const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const findings = [];

async function walk(path) {
  let info;
  try { info = await stat(path); } catch { findings.push(`${path}: path does not exist`); return; }
  if (info.isFile()) return extensions.has(path.slice(path.lastIndexOf('.'))) ? check(path) : undefined;
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'tests' || entry.name === 'scripts' || entry.name.startsWith('.')) continue;
    await walk(join(path, entry.name));
  }
}

async function check(path) {
  const text = await readFile(path, 'utf8');
  const rules = [
    [/\bdebugger\s*;?/, 'debugger statement'],
    [/\beval\s*\(/, 'eval is forbidden'],
    [/@ts-(?:ignore|nocheck|expect-error)\b/, 'TypeScript suppression directive'],
  ];
  for (const [pattern, message] of rules) {
    const lines = text.split('\n');
    lines.forEach((line, index) => { if (pattern.test(line)) findings.push(`${relative(process.cwd(), path)}:${index + 1}: ${message}`); });
  }
}

for (const root of roots) await walk(root);
if (findings.length) {
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`lint ok (${roots.join(', ')})`);
}
