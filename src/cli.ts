#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { isCancel, select } from '@clack/prompts';
import { bold, cyan, dim, green, red } from './color.js';
import { type Config, CONFIG_DIR, listConfigs, loadConfig, resolveConfigPath } from './config.js';
import { fetchSpec } from './fetchSpec.js';
import { classifyAll } from './classify.js';
import { diffSpecs } from './diff.js';
import { explainChanges } from './explain.js';
import { parseInitArgs, runInit } from './init.js';
import { printFindings, printReport } from './report.js';
import { readSnapshot, snapshotPath, writeSnapshot } from './snapshot.js';
import { runSync } from './sync.js';
import { verify } from './verify.js';

/** Exit 2, never 1: a caller has to tell "drift found" apart from "the tool broke". */
const DRIFT_EXIT = 2;

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

/** Which backend, and against what — the same four lines whether we are checking or verifying. */
function printConfigHeader(configPath: string, config: Config): void {
  console.log(`Config: ${bold(configPath)}`);
  console.log(`Spec URL: ${cyan(config.specUrl)}`);
  if (config.basePath) console.log(`Base path: ${cyan(config.basePath)}`);
  if (config.globalHeaders?.length) console.log(`Global headers: ${cyan(config.globalHeaders.join(', '))}`);
}

async function main() {
  try {
    const [subcommand, ...rest] = process.argv.slice(2);
    // `init <path>` scans a local directory; `init [path] --repo owner/name[@ref]` scans a repo seam
    // does not have on disk, where the path narrows to a subdirectory of it.
    if (subcommand === 'init') {
      const { path, repo } = parseInitArgs(rest);
      await runInit(path, repo);
      return;
    }

    // verify asks whether the frontend and the spec agree RIGHT NOW. One spec, no snapshot read and
    // none written — the answer must not depend on when it was last run.
    if (subcommand === 'verify') {
      const configPath = rest[0] ?? (await pickConfig());
      const config = loadConfig(configPath);
      printConfigHeader(configPath, config);
      const findings = verify(config, await fetchSpec(config.specUrl));
      printFindings(findings, config.consumes);
      if (findings.some((f) => f.severity === 'breaking')) process.exitCode = DRIFT_EXIT;
      return;
    }

    // sync runs verify across every backend and makes a repo's open issues match the findings. No
    // snapshot and no LLM call, which is what makes it cheap enough to run on a schedule.
    if (subcommand === 'sync') {
      const at = rest.indexOf('--repo');
      if (at !== -1 && !rest[at + 1]) throw new Error('--repo needs a value: --repo owner/name');
      await runSync({ repo: at === -1 ? undefined : rest[at + 1], dryRun: rest.includes('--dry-run') });
      return;
    }

    // `driftcheck [config]` and `driftcheck check [config]` both work; each config is one backend.
    // An explicit argument always runs directly — the picker is a no-arg convenience only.
    const explicit = subcommand === 'check' ? rest[0] : subcommand;
    const configPath = explicit ?? (await pickConfig());
    const config = loadConfig(configPath);
    printConfigHeader(configPath, config);
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
      // Set, not exit: the snapshot below must still be written, or the next run re-reports everything.
      if (classified.some((c) => c.severity === 'breaking')) process.exitCode = DRIFT_EXIT;

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
