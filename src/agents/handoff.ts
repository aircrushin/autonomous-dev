import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Handoff } from './types.js';

export async function saveHandoff(path: string, handoff: Handoff): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(handoff, null, 2) + '\n', 'utf8');
}
