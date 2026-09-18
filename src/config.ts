import { readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/** Every config lives here — init writes it, check reads it. */
export const CONFIG_DIR = 'config';
export const DEFAULT_CONFIG = 'driftcheck.config.json';
/** specUrl + basePath for every backend, in one place. Not a `.config.json`, so `listConfigs` skips it. */
export const BACKENDS_FILE = 'backends.json';
/** `loadConfig` error code for "this backend has no spec to check" — a skip, not a failure. */
export const NO_SPEC_URL = 'NO_SPEC_URL';

// v2 fields are all optional and all mean the same thing when absent: "we never looked, so monitor
// everything". A v1 config keeps v1's conservative behaviour without being touched.
export const ConsumedRouteSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().regex(/^\/.+/, 'path must start with "/"'),
  /** Headers this call site adds on top of `globalHeaders`. Lowercase. */
  headers: z.array(z.string()).optional(),
  /** Request paths the frontend sends: `filters.status`, `items[].sku`. */
  requestFields: z.array(z.string()).optional(),
  /** Response paths the frontend actually reads: `profile.firstName`, `items[].sku`. */
  responseFields: z.array(z.string()).optional(),
  /**
   * This frontend serves the same path from its own API handler (a Next.js BFF route). Set by init
   * from the file tree, never by the model. It only means "absence from a backend spec proves
   * nothing here" — every other check still applies, because the path is usually a real backend route
   * that the handler forwards to unchanged.
   */
  served: z.boolean().optional(),
});

export type ConsumedRoute = z.infer<typeof ConsumedRouteSchema>;

export const ConfigSchema = z.object({
  specUrl: z.url(),
  /** Shared prefix the spec carries but the frontend's base URL hides, e.g. `/api/v1`. Empty = none. */
  basePath: z
    .string()
    .refine((value) => value === '' || value.startsWith('/'), 'basePath must start with "/"')
    .refine((value) => value === '' || !value.endsWith('/'), 'basePath must not end with "/"')
    .optional(),
  /** Headers the shared API client puts on every call. Lowercase. */
  globalHeaders: z.array(z.string()).optional(),
  consumes: z.array(ConsumedRouteSchema).nonempty(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The backend a config file belongs to, as a key into `backends.json`. Derived from the filename,
 * which init builds from the base-URL env var (`PLATFORM_SERVICE_URL` -> `platform-service-url`) —
 * so it stays the same every time the config is regenerated. Drafts resolve to the same backend.
 */
export function backendKey(configPath: string): string {
  const name = basename(configPath);
  if (name === DEFAULT_CONFIG || name.startsWith('driftcheck.config.')) return 'default';
  return name
    .replace(/^driftcheck\./, '')
    .replace(/\.config(\.draft)?\.json$/, '')
    .replace(/\.json$/, '');
}

const RegistrySchema = z.record(
  z.string(),
  z.object({
    specUrl: z.union([z.url(), z.literal('')]).optional(),
    basePath: z.string().optional(),
  }),
);

export type Registry = z.infer<typeof RegistrySchema>;

/**
 * `config/backends.json` — the one place specUrl and basePath are typed in. Generated configs carry
 * neither, so deleting and re-running init never loses them. Missing file is normal (v1 layout);
 * a malformed one is loud, because silently ignoring it would check the wrong spec.
 */
export function readRegistry(dir = CONFIG_DIR): Registry {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), dir, BACKENDS_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Could not read ${dir}/${BACKENDS_FILE}: ${err instanceof Error ? err.message : err}`);
  }
  try {
    return RegistrySchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new Error(`${dir}/${BACKENDS_FILE} is not valid: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * A bare filename means "in the config directory"; anything with a path separator is taken as given.
 * `dir` is how one seam process serves several projects — each has its own directory of configs, and
 * nothing else about a run changes.
 */
export function resolveConfigPath(arg: string, dir = CONFIG_DIR): string {
  const inConfigDir = !isAbsolute(arg) && !arg.includes('/');
  return resolve(process.cwd(), inConfigDir ? `${dir}/${arg}` : arg);
}

/** Config files in the config directory, sorted. Empty if the folder does not exist. */
export function listConfigs(dir = CONFIG_DIR): string[] {
  try {
    return readdirSync(resolve(process.cwd(), dir))
      .filter((f) => f.endsWith('.config.json'))
      .sort();
  } catch {
    return [];
  }
}

export function loadConfig(path = DEFAULT_CONFIG, dir = CONFIG_DIR): Config {
  const full = resolveConfigPath(path, dir);
  let raw: string;
  try {
    raw = readFileSync(full, 'utf8');
  } catch {
    throw new Error(`No config found at ${full} — run \`driftcheck init <path>\` to create one.`);
  }
  const parsed = JSON.parse(raw);
  const key = backendKey(full);
  const shared = readRegistry(dir)[key] ?? {};
  // The config file wins only when it carries a real value. `''` is init's placeholder and cannot be
  // told apart from a deliberate "no prefix", so the registry beats it — otherwise the shared entry
  // would be dead weight on every generated file.
  const merged = {
    ...parsed,
    specUrl: parsed?.specUrl || shared.specUrl || '',
    basePath: parsed?.basePath || shared.basePath,
  };

  // init leaves specUrl blank on purpose, so say that plainly instead of failing as a URL validation error.
  if (!merged.specUrl) {
    // Tagged, not just worded: `sync` walks every config and must skip the ones that never had a spec
    // (Auth0, the admin frontend) while still failing loudly on a config that is genuinely broken.
    throw Object.assign(
      new Error(
        `specUrl not set for '${key}' — add it under "${key}" in ${dir}/${BACKENDS_FILE} ` +
          `(or directly in ${path}) before running.`,
      ),
      { code: NO_SPEC_URL },
    );
  }
  return ConfigSchema.parse(merged);
}
