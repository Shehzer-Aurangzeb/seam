import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEFAULT_TRIGGER, type Project } from './projects.js';

/**
 * The two decisions a webhook receiver makes before any work happens: is this really from GitHub,
 * and does it mean a backend just changed. Both are pure functions so they can be tested without a
 * server, an App, or a network — the hosting around them is glue.
 */

/** The usual integration branches, used when a push-triggered project names none of its own. */
const DEFAULT_BRANCHES = ['main', 'master', 'dev', 'develop'];

/**
 * GitHub signs every delivery with the webhook secret. Without this check the endpoint is a public
 * button anyone can press to file issues in someone else's repo.
 *
 * Compared with `timingSafeEqual`, not `===`: a byte-by-byte comparison leaks how much of a forged
 * signature was correct, which is enough to reconstruct one.
 */
export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  // timingSafeEqual throws on a length mismatch, which is itself a rejection.
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Decision =
  | { run: true; reason: string; awaitSpecChange: boolean }
  | { run: false; reason: string };

const branchOf = (ref: unknown): string | null =>
  typeof ref === 'string' && ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;

/**
 * Whether this delivery means "a backend this project depends on just changed".
 *
 * Deliberately conservative: anything unrecognised is a no-run. A webhook endpoint receives every
 * event type the App is subscribed to, and acting on an unexpected shape would file issues from,
 * say, a branch deletion.
 */
export function decideRun(event: string, payload: unknown, project: Project): Decision {
  const trigger = project.trigger ?? DEFAULT_TRIGGER;
  const body = (payload ?? {}) as Record<string, unknown>;

  if (trigger.on === 'deployment') {
    if (event !== 'deployment_status') return { run: false, reason: `ignored event '${event}'` };
    const status = (body.deployment_status ?? {}) as Record<string, unknown>;
    if (status.state !== 'success') return { run: false, reason: `deployment state '${status.state}'` };
    const environment = (body.deployment as Record<string, unknown> | undefined)?.environment;
    if (trigger.environment !== undefined && environment !== trigger.environment) {
      return { run: false, reason: `environment '${environment}' is not '${trigger.environment}'` };
    }
    // The spec is already being served by the deploy that just succeeded, so there is nothing to wait for.
    return { run: true, reason: `deployment to '${environment}' succeeded`, awaitSpecChange: false };
  }

  if (event !== 'push') return { run: false, reason: `ignored event '${event}'` };
  if (body.deleted === true) return { run: false, reason: 'branch deleted' };
  const branch = branchOf(body.ref);
  if (branch === null) return { run: false, reason: `ref '${body.ref}' is not a branch` };
  const branches = trigger.branches ?? DEFAULT_BRANCHES;
  if (!branches.includes(branch)) return { run: false, reason: `branch '${branch}' is not watched` };

  // A push lands before the deploy it causes, so the spec being served is still the old one. The
  // caller waits for it to change rather than reporting against a spec that has not moved yet.
  return { run: true, reason: `push to '${branch}'`, awaitSpecChange: true };
}
