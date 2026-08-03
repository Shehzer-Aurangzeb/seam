#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { isCancel, select } from '@clack/prompts';
import { bold, cyan, dim, green, red } from './color.js';
import { CONFIG_DIR, listConfigs, loadConfig, resolveConfigPath } from './config.js';
import { fetchSpec } from './fetchSpec.js';
import { classifyAll } from './classify.js';
import { diffSpecs } from './diff.js';
import { explainChanges } from './explain.js';
import { runInit } from './init.js';
import { printReport } from './report.js';
import { readSnapshot, snapshotPath, writeSnapshot } from './snapshot.js';

function countPaths(spec: unknown): number {
  const paths = (spec as { paths?: unknown } | null)?.paths;
  return typeof paths === 'object' && paths !== null ? Object.keys(paths).length : 0;
}

/** Cheap hint for the picker, straight off the file — never fails a listing over a bad file. */
function summarize(file: string): string {
  try {
    const raw = JSON.parse(readFileSync(resolveConfigPath(file), 'utf8'));
    const routes = Array.isArray(raw?.consumes) ? raw.consumes.length : 0;
    return `${routes} route(s) · ${raw?.specUrl || 'specUrl not set'}`;
  } catch {
    return 'unreadable';
  }
}

/** No-arg check: run the only config, or let a human pick. Never prompts when it cannot. */
async function pickConfig(): Promise<string> {
  const files = listConfigs();
  if (files.length === 0) {
    throw new Error(`No config files in ${CONFIG_DIR}/ — run \`driftcheck init <path>\` first.`);
  }
  if (files.length === 1) return files[0];

  // Scripts and pipes must never block on a prompt.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `${files.length} configs in ${CONFIG_DIR}/ and no TTY to pick from — pass one explicitly: driftcheck check <file>`,
    );
  }

  const choice = await select({
    message: 'Which backend do you want to check?',
    options: files.map((file) => ({ value: file, label: file, hint: summarize(file) })),
  });
  if (isCancel(choice)) throw new Error('Cancelled — nothing checked.');
  return choice;
}

async function main() {
  try {
    const [subcommand, ...rest] = process.argv.slice(2);
    if (subcommand === 'init') {
      await runInit(rest[0]);
      return;
    }

    // `driftcheck [config]` and `driftcheck check [config]` both work; each config is one backend.
    // An explicit argument always runs directly — the picker is a no-arg convenience only.
    const explicit = subcommand === 'check' ? rest[0] : subcommand;
    const configPath = explicit ?? (await pickConfig());
    const config = loadConfig(configPath);
    console.log(`Config: ${bold(configPath)}`);
    console.log(`Spec URL: ${cyan(config.specUrl)}`);
    if (config.basePath) console.log(`Base path: ${cyan(config.basePath)}`);
    if (config.globalHeaders?.length) console.log(`Global headers: ${cyan(config.globalHeaders.join(', '))}`);
    console.log(`Consumed routes (${config.consumes.length}):`);
    for (const { method, path } of config.consumes) console.log(`  - ${method} ${path}`);

    const spec = await fetchSpec(config.specUrl);
    const n = countPaths(spec);

    const snapshot = snapshotPath(configPath);
    const previous = readSnapshot(snapshot);
    if (previous === null) {
      writeSnapshot(snapshot, spec);
      console.log(
        `Baseline snapshot captured (${n} paths). Nothing to compare yet — run again after the spec changes.`,
      );
      return;
    }

    console.log(`Previous snapshot found. Fetched current spec (${n} paths).`);
    const allChanges = diffSpecs(previous, spec);
    const classified = classifyAll(allChanges, config, previous, spec);

    if (allChanges.length === 0) {
      console.log(green('No changes to any operation since last snapshot.'));
    } else if (classified.length === 0) {
      console.log(green(`${allChanges.length} change(s) detected, but none affect consumed operations.`));
    } else {
      // The LLM only ever enriches what the deterministic engine already decided.
      const actionable = classified.filter((c) => c.severity !== 'ignore');
      const explanation = await explainChanges(actionable);

      printReport(classified, explanation, allChanges.length);

      if (!explanation && actionable.length > 0) {
        console.log(
          process.env.ANTHROPIC_API_KEY
            ? 'Plain-language explanations unavailable (LLM call or response validation failed).'
            : 'Plain-language explanations skipped (no ANTHROPIC_API_KEY set).',
        );
      }
    }

    writeSnapshot(snapshot, spec);
    console.log(dim('Snapshot updated.'));
  } catch (err) {
    console.error(red(`Error: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }
}

main();
