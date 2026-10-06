#!/usr/bin/env node
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist/scripts', { recursive: true });
await cp('scripts/lint.mjs', 'dist/scripts/lint.mjs');
await cp('scripts/scan-secrets.mjs', 'dist/scripts/scan-secrets.mjs');
