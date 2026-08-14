import { bold, cyan, dim, green, red } from './color.js';
import { backendKey, listConfigs, loadConfig, NO_SPEC_URL } from './config.js';
import { fetchSpec } from './fetchSpec.js';
import { githubToken, parseRepo, type Repo } from './github.js';
import { type Finding, verify } from './verify.js';

/**
 * The loop: run `verify` against every backend, then make the repo's open issues match the findings.
 *
 * This is only correct because `verify` is stateless. A finding is a disagreement with the spec as it
 * stands, so the same disagreement produces the same `key` on every run, on every machine — an issue
 * can be looked up by it, and its disappearance genuinely means "resolved", not "we already reported
 * that one". `check` could never drive this: it reports each change once, and never re-reports it once
 * the snapshot moves on.
 */

/** Every issue seam opens carries this label, and seam only ever touches labelled ones. */
export const LABEL = 'seam';

/** ponytail: breaking only. `relevant` (a deprecated header, a field gone optional) is real but does
 * not deserve to be an open ticket — widen this when someone asks for the deprecation warnings. */
const REPORTED = 'breaking';

export type Issue = { number: number; title: string; body: string };

/** An issue that should exist. `marker` is the identity; the rest is what a human reads. */
export type Desired = { marker: string; title: string; body: string };

/**
 * Identity lives in the body, not the title or a label. Titles get edited, and labels cap at 50
 * characters — a marker like `response-field-missing:GET /users/{id}:profile.email` is neither.
 * Prefixed with the backend because two backends can serve the same route.
 */
const markerOf = (backend: string, finding: Finding) => `<!-- seam:${backend}:${finding.key} -->`;

/** The backend segment of a marker, or null for a body seam did not write. */
export function backendOf(body: string): string | null {
  return /<!-- seam:([^:]+):/.exec(body)?.[1] ?? null;
}

// GitHub rejects a title over 256 characters with a 422, which would fail the whole run over one long
// field name.
const title = (finding: Finding) => {
  const full = `[seam] ${finding.method} ${finding.path} — ${finding.reason}`;
  return full.length > 200 ? `${full.slice(0, 199)}…` : full;
};

const body = (backend: string, configPath: string, specUrl: string, finding: Finding) =>
  [
    `**${finding.method} ${finding.path}** — ${finding.reason}`,
    '',
    `| | |`,
    `|---|---|`,
    `| backend | \`${backend}\` |`,
    `| config | \`${configPath}\` |`,
    `| spec | ${specUrl} |`,
    finding.subject ? `| subject | \`${finding.subject}\` |` : '',
    '',
    'Opened by seam. It closes itself on the next run after `seam verify` stops reporting this.',
    '',
    markerOf(backend, finding),
  ]
    .filter((line) => line !== '')
    .join('\n');

/**
 * What to open and what to close. Pure set arithmetic on markers, so it is testable without a network.
 *
 * `verified` is the load-bearing argument: an unreachable spec produces zero findings, which is
 * indistinguishable from "everything is fixed". Closing on that would wipe out every real issue for a
 * backend the moment its dev environment went down, so a backend that did not complete has its issues
 * left exactly where they are.
 */
export function reconcile(
  desired: Desired[],
  issues: Issue[],
  verified: Set<string>,
): { open: Desired[]; close: Issue[] } {
  const has = (marker: string) => issues.some((i) => i.body.includes(marker));

  return {
    open: desired.filter((d) => !has(d.marker)),
    close: issues.filter((i) => {
      const backend = backendOf(i.body);
      // Not ours, or from a backend that did not run this time. Either way: hands off.
      if (backend === null || !verified.has(backend)) return false;
      return !desired.some((d) => i.body.includes(d.marker));
    }),
  };
}

async function api(repo: Repo, path: string, token: string, init?: RequestInit): Promise<unknown> {
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'seam',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const hint =
      res.status === 403 || res.status === 401
        ? " — the token cannot write issues here (a workflow needs `permissions: issues: write`)."
        : res.status === 404
          ? ' — no such repo, or the token cannot see it.'
          : '';
    throw new Error(`GitHub ${init?.method ?? 'GET'} ${path} failed: HTTP ${res.status}${hint}`);
  }
  return res.status === 204 ? null : await res.json();
}

/**
 * Open issues seam owns. `/issues` also returns pull requests, and closing someone's PR because it
 * carried the label would be a genuinely bad day.
 *
 * ponytail: one page. 100 simultaneously-open drift issues means something has gone very wrong long
 * before pagination does — add `page=` if that day comes.
 */
async function openIssues(repo: Repo, token: string): Promise<Issue[]> {
  const raw = (await api(repo, `/issues?state=open&labels=${LABEL}&per_page=100`, token)) as
    | (Issue & { pull_request?: unknown })[]
    | null;
  return (raw ?? []).filter((i) => !i.pull_request).map(({ number, title, body }) => ({ number, title, body: body ?? '' }));
}

export type SyncOptions = { repo?: string; dryRun?: boolean };

export async function runSync({ repo: repoSpec, dryRun = false }: SyncOptions): Promise<void> {
  // GITHUB_REPOSITORY is set for free inside Actions, which is where this normally runs.
  const spec = repoSpec ?? process.env.GITHUB_REPOSITORY;
  if (!spec) {
    throw new Error('sync needs a repo to file issues in: --repo owner/name (GITHUB_REPOSITORY is used when set).');
  }
  const repo = parseRepo(spec);

  const configs = listConfigs();
  if (configs.length === 0) throw new Error('No configs to verify — run `driftcheck init <path>` first.');

  const desired: Desired[] = [];
  const verified = new Set<string>();
  let failed = 0;

  for (const configPath of configs) {
    const backend = backendKey(configPath);
    try {
      const config = loadConfig(configPath);
      const findings = verify(config, await fetchSpec(config.specUrl));
      const reported = findings.filter((f) => f.severity === REPORTED);
      for (const finding of reported) {
        desired.push({
          marker: markerOf(backend, finding),
          title: title(finding),
          body: body(backend, configPath, config.specUrl, finding),
        });
      }
      // Only a completed run earns the right to close this backend's issues.
      verified.add(backend);
      console.log(`${green('verified')} ${bold(backend)} — ${config.consumes.length} route(s), ${reported.length} breaking`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((err as { code?: string }).code === NO_SPEC_URL) {
        console.log(dim(`skipped  ${backend} — no specUrl, nothing to verify against`));
        continue;
      }
      failed++;
      console.error(red(`failed   ${backend} — ${message}`));
    }
  }

  const token = githubToken();
  const { open, close } = reconcile(desired, await openIssues(repo, token), verified);
  const where = `${repo.owner}/${repo.name}`;

  console.log(`\n${bold(where)}: ${open.length} to open, ${close.length} to close (${desired.length} finding(s) total).`);

  for (const issue of open) {
    console.log(`  ${dryRun ? dim('would open ') : 'open  '} ${issue.title}`);
    if (dryRun) continue;
    const created = (await api(repo, '/issues', token, {
      method: 'POST',
      body: JSON.stringify({ title: issue.title, body: issue.body, labels: [LABEL] }),
    })) as { number: number };
    console.log(`          ${cyan(`#${created.number}`)}`);
  }

  for (const issue of close) {
    console.log(`  ${dryRun ? dim('would close') : 'close '} #${issue.number} ${issue.title}`);
    if (dryRun) continue;
    await api(repo, `/issues/${issue.number}/comments`, token, {
      method: 'POST',
      body: JSON.stringify({ body: 'Resolved — `seam verify` no longer reports this against the current spec.' }),
    });
    await api(repo, `/issues/${issue.number}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
    });
  }

  // Exit 1, not the drift code: drift is now an issue, not a failed run. A backend that could not be
  // reached IS a failed run, and a schedule that goes green forever while checking nothing is the one
  // outcome worth failing loudly for.
  if (failed > 0) {
    console.error(red(`\n${failed} backend(s) could not be verified — their issues were left untouched.`));
    process.exitCode = 1;
  }
}
