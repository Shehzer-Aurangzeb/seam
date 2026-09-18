import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * One seam process, several projects. A project is a frontend repo, the directory holding its
 * backend configs, and the repos whose deploys should trigger a run.
 *
 * This file is the whole "multi-project" feature. There is no database because there is no state to
 * keep: `verify` is stateless and the open issues in each frontend repo are the only record of what
 * is currently broken.
 */
export const PROJECTS_FILE = 'projects.json';

const ProjectSchema = z.object({
  /** Where issues are filed — the frontend that breaks when a backend changes. */
  issuesRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'issuesRepo must be owner/name'),
  /** Directory holding this project's backends.json and *.config.json files. */
  configDir: z.string().min(1),
  /**
   * Repos whose deploys trigger this project. A run always verifies every backend in the project,
   * not just the one that fired: verifying the rest costs one HTTP request each and keeps the
   * "only a backend that completed may have its issues closed" rule intact.
   */
  watch: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'watch entries must be owner/name')),
});

export const ProjectsSchema = z.record(z.string(), ProjectSchema);

export type Project = z.infer<typeof ProjectSchema> & { name: string };

export function readProjects(file = PROJECTS_FILE): Record<string, Project> {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err instanceof Error ? err.message : err}`);
  }
  let parsed: z.infer<typeof ProjectsSchema>;
  try {
    parsed = ProjectsSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new Error(`${file} is not valid: ${err instanceof Error ? err.message : err}`);
  }
  return Object.fromEntries(Object.entries(parsed).map(([name, p]) => [name, { ...p, name }]));
}

export function projectByName(projects: Record<string, Project>, name: string): Project {
  const found = projects[name];
  if (!found) {
    throw new Error(`No project '${name}' — known: ${Object.keys(projects).join(', ') || '(none)'}.`);
  }
  return found;
}

/**
 * Which project a webhook belongs to, by the repo that fired it. Repo names are compared
 * case-insensitively because GitHub treats them that way and a payload's casing is not guaranteed
 * to match what someone typed into projects.json.
 */
export function projectByRepo(projects: Record<string, Project>, repo: string): Project | undefined {
  const needle = repo.toLowerCase();
  return Object.values(projects).find((p) => p.watch.some((w) => w.toLowerCase() === needle));
}
