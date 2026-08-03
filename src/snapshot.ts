import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export const SNAPSHOT_DIR = resolve(process.cwd(), '.driftcheck');

/** One snapshot per config, so backends never overwrite each other's baseline. */
export function snapshotPath(configPath: string): string {
  const name = basename(configPath, '.json');
  return resolve(SNAPSHOT_DIR, name === 'driftcheck.config' ? 'snapshot.json' : `${name}.snapshot.json`);
}

export function readSnapshot(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read snapshot at ${path}: ${err instanceof Error ? err.message : err}`);
  }
}

export function writeSnapshot(path: string, spec: unknown): void {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(spec, null, 2));
}
