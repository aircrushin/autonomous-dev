#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['src', 'apps'];
const maxBytes = 1024 * 1024;
const maxFiles = 5000;
let files = 0;
const findings = [];
const dangerousName = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519))$/i;
const contentRules = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key material'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD)\s*[:=]\s*["'][^"'\n]{8,}["']/, 'credential-like assignment'],
];

async function inspect(path) {
  if (++files > maxFiles) { findings.push(`scan limit exceeded: more than ${maxFiles} files`); return; }
  const name = basename(path);
  if (dangerousName.test(name)) findings.push(`${relative(process.cwd(), path)}: dangerous file name`);
  const info = await stat(path);
  if (info.size > maxBytes) { findings.push(`${relative(process.cwd(), path)}: file exceeds ${maxBytes} byte limit`); return; }
  const data = await readFile(path);
  if (data.includes(0)) return;
  const text = data.toString('utf8');
  for (const [pattern, message] of contentRules) {
    const match = pattern.exec(text);
    if (match) {
      const line = text.slice(0, match.index).split('\n').length;
      findings.push(`${relative(process.cwd(), path)}:${line}: ${message}`);
    }
  }
}

async function walk(path) {
  let info;
  try { info = await stat(path); } catch { findings.push(`${path}: path does not exist`); return; }
  if (info.isFile()) { await inspect(path); return; }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'tests' || entry.name === 'scripts' || entry.name === '.git') continue;
    await walk(join(path, entry.name));
  }
}

for (const root of roots) await walk(root);
if (findings.length) {
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`secret scan ok (${files} files)`);
}
