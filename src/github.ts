import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Reading a frontend seam does not have on disk. The app connects a repo, not a directory, so `init`
 * needs the source without a working copy.
 *
 * One tarball request rather than the Trees API plus a blob fetch per file: scoring is content-based,
 * so every candidate has to be read anyway, and 600 blob fetches is 600 round trips against a rate
 * limit. Extracting to a temp dir means the existing local scan runs over it completely unchanged.
 *
 * ponytail: shells out to `tar`, which is on macOS, every Linux CI image and the worker. It is not on
 * Windows before 10, and not in a scratch container. Bundle a tar parser if either ever matters.
 */

const REPO_SPEC = /^([\w.-]+)\/([\w.-]+?)(?:@(.+))?$/;

export type Repo = { owner: string; name: string; ref?: string };

/** `owner/name` or `owner/name@ref`, where ref is a branch, tag or commit sha. */
export function parseRepo(spec: string): Repo {
  const match = REPO_SPEC.exec(spec.trim());
  if (!match) {
    throw new Error(`Not a repo: '${spec}'. Expected owner/name or owner/name@branch.`);
  }
  const [, owner, name, ref] = match;
  return ref ? { owner, name, ref } : { owner, name };
}

/** GitHub's tarball redirects to codeload; fetch follows it, but the auth header must survive. */
const tarballUrl = ({ owner, name, ref }: Repo) =>
  `https://api.github.com/repos/${owner}/${name}/tarball${ref ? `/${encodeURIComponent(ref)}` : ''}`;

/**
 * Downloads a repo and returns the extracted directory plus a `dispose` that removes it. The caller
 * owns cleanup, because the scan reads from the directory long after this returns.
 */
export async function downloadRepo(
  repo: Repo,
  token: string,
): Promise<{ dir: string; dispose: () => void }> {
  const response = await fetch(tarballUrl(repo), {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'seam' },
  });

  if (!response.ok) {
    const where = `${repo.owner}/${repo.name}${repo.ref ? `@${repo.ref}` : ''}`;
    // 404 is what GitHub returns for "private and your token cannot see it" as well as "no such repo",
    // so never claim it does not exist.
    const hint =
      response.status === 404
        ? ' — either it does not exist, the ref is wrong, or the token cannot see it.'
        : response.status === 401 || response.status === 403
          ? ' — the token was rejected or is out of API quota.'
          : '';
    throw new Error(`Could not download ${where}: HTTP ${response.status}${hint}`);
  }

  const parent = mkdtempSync(join(tmpdir(), 'seam-repo-'));
  const dispose = () => rmSync(parent, { recursive: true, force: true });
  try {
    execFileSync('tar', ['-xz', '-C', parent], { input: Buffer.from(await response.arrayBuffer()) });
    // GitHub wraps everything in one `owner-name-sha` directory.
    const [root] = readdirSync(parent);
    if (!root) throw new Error('the archive was empty');
    return { dir: join(parent, root), dispose };
  } catch (err) {
    dispose();
    throw new Error(`Could not unpack ${repo.owner}/${repo.name}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * A token, or a clear message about how to get one. The app will pass an installation token;
 * a human running the CLI almost certainly has `gh` already logged in.
 */
export function githubToken(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) return token;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'No GitHub token — set GITHUB_TOKEN, or run `gh auth login` so seam can borrow one from the gh CLI.',
    );
  }
}
