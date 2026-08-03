import { existsSync, globSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { BACKENDS_FILE, CONFIG_DIR, ConsumedRouteSchema, DEFAULT_CONFIG, backendKey, readRegistry } from './config.js';
import { bold, cyan, dim, green } from './color.js';
import { completeJson } from './llm.js';

// Bytes are the real budget; the file count is just a backstop. It used to be 40 because scoring was
// a word-count that let noise in — now that only genuine call sites score above zero, 40 was cutting
// the low-scoring downstream hooks where responseFields live while 58% of the byte budget went unused.
const MAX_FILES = 150;
const MAX_TOTAL_BYTES = 200_000;
/** A single file this large is generated or vendored, not hand-written API code. */
const MAX_FILE_BYTES = 60_000;
// Headers and response fields make the answer several times longer than v1's route list.
const MAX_TOKENS = 8192;

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo']);

// specUrl is best-effort at init time, so an empty string is valid here even though a run requires a URL.
const DraftConfigSchema = z.object({
  specUrl: z.union([z.url(), z.literal('')]),
  backends: z
    .array(
      z.object({
        ref: z.string().min(1),
        globalHeaders: z.array(z.string()).optional(),
        consumes: z.array(ConsumedRouteSchema).nonempty(),
      }),
    )
    .nonempty(),
});

const SYSTEM_PROMPT = `You are reading a frontend codebase to work out which backend HTTP operations it consumes.

Do NOT assume any particular convention. The codebase might call its backend through a BFF/route handler, a fetch or axios wrapper, generated clients, TanStack Query hooks, a service layer, or something else entirely. Work out what THIS codebase actually does, then extract the operations.

A frontend sometimes talks to MORE THAN ONE backend (e.g. its own API plus an identity provider). Group the operations by which base URL each call goes through, and report that grouping in "backends".

The only reliable signal is the base-URL REFERENCE in the code — the env var name or client instance the call uses (e.g. process.env.API_URL, AUTH0_URL, apiClient, auth0Client, a baseURL passed to axios.create). Report that reference verbatim as "ref"; it is a human-readable label, not a resolved URL. You cannot see what these resolve to. Do not try to resolve them, and do NEVER group by how the paths look — routes from different backends are often structurally identical, so path shape, naming, and versioning prefixes prove nothing.

A "ref" MUST be one of exactly two things:
1. an environment variable holding a base URL, or
2. an HTTP client instance configured with a base URL (apiClient, auth0Client, the result of axios.create({baseURL})).

For an environment variable, report the VARIABLE NAME ALONE — "PLATFORM_SERVICE_URL", never "process.env.PLATFORM_SERVICE_URL" or "envServer.PLATFORM_SERVICE_URL". Codebases read the same variable through different accessors (process.env.X in one file, a typed env object like envServer.X or config.env.X in another). Those are THE SAME BACKEND. Strip the accessor, keep the name, and put every route that uses that variable in ONE group. Never emit two groups whose variable names match.

A WRAPPER OR HELPER FUNCTION NAME IS NOT A BACKEND. Names like queryIdp, createIdp, queryPlatform, getPlatformUsersByIds, fetchUser, updateThing — anything that reads as a function you could call — must NEVER appear as a "ref". Such functions are layers on top of a backend, not backends. Several of them routinely share ONE base URL.
- When a route is called through a wrapper function, trace into that function's body and find the base URL it ultimately uses. Cluster on THAT env var or client instance, not on the function.
- Follow the chain as far as it goes: a hook calls a service, the service calls a wrapper, the wrapper reads process.env.X — the ref is process.env.X.
- If you CANNOT determine which base URL a wrapper function uses, do NOT create a group for it. Fold its routes into the single most likely existing base-URL group. Inventing a function-named backend is the worst outcome here — worse than putting a route in the wrong group, because it fabricates a backend that does not exist.
- Before returning, re-read every "ref": if one looks like a function, a hook, a component, a file, or a feature area rather than an env var or client instance, it is wrong. Delete that group and merge its routes into a real base-URL group.
- A "ref" is NEVER a prose description. "Auth0 endpoints (hardcoded)", "internal API", "third-party services" are not refs. If you are reaching for a phrase, you have not found the reference — merge those routes into the base-URL group that most likely serves them.

TEST FILES ARE NOT EVIDENCE OF A BACKEND. Files like *.test.ts, *.spec.ts, __mocks__ and __tests__ hardcode fake base URLs (https://auth0.test, https://api.example.com) and mock fetch calls. Those URLs are fixtures, not backends, and a route that appears ONLY in a test is not proof the frontend consumes it.
- Determine base URLs from production code only. Never create a group for a URL that appears only in tests.
- If a test hardcodes a URL for a route whose production code reads an env var, the ref is the ENV VAR from the production code.
- Only report an operation you can see in production code. Do not invent routes and do not extrapolate a family of routes from one example.

Be CONSERVATIVE. Splitting when you should not have scatters the user's config and is worse than not splitting at all.
- Return ONE group unless you can point at a clear, visible difference in base-URL reference between calls.
- WHEN UNSURE, RETURN ONE GROUP. Prefer merging over splitting, always. Never invent a split from path shape, from a route's subject matter, from a wrapper's name, or from a guess about which third party might serve it.
- Two references you are not sure are genuinely different backends: use FEWER groups, not more.
- One group per distinct reference. Calls using the same reference always belong in the same group.
- If a call in PRODUCTION code has a hardcoded literal base URL rather than a reference, use the literal's origin as "ref" (e.g. https://example.com). This rule NEVER applies to a URL from a test file — the ignore-tests rule above wins. Hosts ending in .test or .local, localhost, 127.0.0.1, and example.com are mock hosts: never emit a group for them.

Extract every distinct BACKEND operation the frontend depends on, as {method, path}:
- method must be one of GET, POST, PUT, PATCH, DELETE.
- path is the backend route, starting with "/". Normalise dynamic segments to braces: /asset-records/\${id} or /asset-records/:id both become /asset-records/{id}.
- Prefer the backend route over an internal proxy route when the code shows both (e.g. a route handler that forwards to the real backend — report the backend path it forwards to).
- Deduplicate within each group. One entry per method+path.

Also record WHAT of each contract the frontend actually touches, so drift in the rest can be ignored later. Only report what you can SEE in the code — an omitted list means "monitor everything", which is the safe answer. A guessed list silences real breakage.

HEADERS — names only, NEVER values. A header value is a secret; a header name is not.
- "globalHeaders" (per backend): headers a shared layer puts on every call through that base URL — axios.create({headers}), instance.defaults.headers, a request interceptor, the default header object in a fetch wrapper, a hook that injects an auth token.
- "headers" (per route): what that specific call site adds on top of the global ones, e.g. X-Idempotency-Key, X-Request-Id, a per-call Content-Type.
- Write every header name in lowercase.

RESPONSE FIELDS — "responseFields" (per route) is every path the frontend READS off that response. Look in the calling code, the components and hooks that consume it, and the Zod schema or TypeScript type the response is parsed into.
- LOOK DOWNSTREAM OF THE FETCH. A BFF route handler usually forwards the whole response untouched (return Response.json(await upstream.json())) — that is passthrough, not consumption, and tells you nothing about which fields matter. The real reads live in the hooks, transform functions, components and response types that consume the handler's output. Trace from the route to those, and collect the field reads there.
- Strip the transport wrapper used to reach the payload: data.user.email -> "user.email", res.data.total -> "total", (await r.json()).id -> "id".
- Nested objects use dots: "profile.firstName".
- Arrays use []: data.items.map(i => i.id) -> "items[].id", items[0].sku -> "items[].sku".
- A whole object read without touching its fields is that object's path: setUser(data.user) -> "user".
- If a Zod schema or type describes the response, every field it declares counts as read.
- Worked example. Given: const r = await backend.get(\`/orders/\${id}\`); return { who: r.data.customer.email, skus: r.data.lines.map(l => l.sku) };
  emit on GET /orders/{id}: "responseFields": ["customer.email", "lines[].sku"].
- PARTIAL IS CORRECT, INVENTED IS NOT. You can only see what the code you were given shows, so a short list of genuinely observed reads is the right answer — never withhold it for being incomplete. What is forbidden is naming a field you did not see read. If a route's response is returned or forwarded wholesale and no downstream read is visible anywhere, omit "responseFields" for that route.

NEVER emit an empty array for any of these three lists. Leave the key out entirely instead. An omitted list means "monitor the whole contract"; an empty one reads as a deliberate "nothing here matters" and would hide real breakage.

For specUrl: return a URL ONLY if an OpenAPI/Swagger spec or API docs URL is plainly visible in the code you were given. Do not guess it from a base URL, do not construct it, do not infer it from environment variable names. If it is not plainly there, return an empty string.

Return JSON ONLY — no markdown fences, no commentary — matching exactly:
{"specUrl":"...","backends":[{"ref":"...","globalHeaders":["..."],"consumes":[{"method":"...","path":"...","headers":["..."],"responseFields":["..."]}]}]}`;

type SourceFile = { rel: string; text: string };

type Route = z.infer<typeof ConsumedRouteSchema>;
type Backend = { ref: string; globalHeaders?: string[]; consumes: Route[] };

/** Codebases read one variable through different accessors — process.env.X, envServer.X, config.env.X are all X. */
export function normalizeRef(ref: string): string {
  const trimmed = ref.trim();
  const dottedIdentifier = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;
  return dottedIdentifier.test(trimmed) ? trimmed.split('.').pop()! : trimmed;
}

const ENV_REF = /^[A-Z][A-Z0-9_]*$/;
const CLIENT_REF = /^[a-z_$][A-Za-z0-9_$]*(Client|Api|API|Service)$/;

/** A ref names a base URL or it names nothing. Prose, URLs and function names are all rejected here. */
export const isValidRef = (ref: string): boolean => ENV_REF.test(ref) || CLIENT_REF.test(ref);

const routeKey = (r: Route) => `${r.method} ${r.path}`;

/**
 * An empty list is dropped, never written. Absent means "not observed, so monitor everything";
 * models reach for `[]` when they mean to omit the key, and the two must not be confused.
 */
const some = (values?: string[]) => (values?.length ? values : undefined);

/** Header names are stored lowercase everywhere — the check engine compares them that way. */
const lower = (names?: string[]) =>
  some([...new Set((names ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean))]);

const union = (a?: string[], b?: string[]) => some([...new Set([...(a ?? []), ...(b ?? [])])]);

/**
 * The same method+path seen twice is one route — keep the union of what each sighting observed,
 * so a header spotted at one call site is not dropped by a duplicate that missed it.
 */
function absorb(into: Map<string, Route>, routes: Route[]): void {
  for (const route of routes) {
    const existing = into.get(routeKey(route));
    if (!existing) {
      into.set(routeKey(route), {
        ...route,
        headers: lower(route.headers),
        requestFields: some(route.requestFields),
        responseFields: some(route.responseFields),
      });
      continue;
    }
    existing.headers = union(existing.headers, lower(route.headers));
    existing.requestFields = union(existing.requestFields, route.requestFields);
    existing.responseFields = union(existing.responseFields, route.responseFields);
  }
}

/**
 * The prompt asks for base-URL refs; this guarantees them. Groups whose ref is not shaped like an
 * env var or client instance are folded into the largest real backend rather than becoming files.
 * An empty ref means "one unnamed config" — the caller writes the default filename for it.
 */
export function clusterBackends(raw: Backend[]): { groups: Backend[]; folded: string[] } {
  const byRef = new Map<string, Backend>();
  const routesByRef = new Map<string, Map<string, Route>>();
  for (const backend of raw) {
    const ref = normalizeRef(backend.ref);
    const group = byRef.get(ref) ?? { ref, consumes: [] };
    group.globalHeaders = union(group.globalHeaders, lower(backend.globalHeaders));
    const routes = routesByRef.get(ref) ?? new Map<string, Route>();
    absorb(routes, backend.consumes);
    group.consumes = [...routes.values()];
    routesByRef.set(ref, routes);
    byRef.set(ref, group);
  }

  const groups = [...byRef.values()];
  const valid = groups.filter((g) => isValidRef(g.ref));
  const invalid = groups.filter((g) => !isValidRef(g.ref));
  const folded = invalid.map((g) => g.ref);

  // Not one usable ref: everything goes in a single unnamed config rather than prose-named files.
  if (valid.length === 0) {
    const all = new Map<string, Route>();
    let headers: string[] | undefined;
    for (const group of groups) {
      absorb(all, group.consumes);
      headers = union(headers, group.globalHeaders);
    }
    return { groups: [{ ref: '', globalHeaders: headers, consumes: [...all.values()] }], folded };
  }

  // Largest valid group absorbs whatever could not be attributed to a real base URL.
  const target = valid.reduce((a, b) => (b.consumes.length > a.consumes.length ? b : a));
  const merged = routesByRef.get(target.ref)!;
  for (const group of invalid) absorb(merged, group.consumes);
  target.consumes = [...merged.values()];
  return { groups: valid, folded };
}

/** `process.env.AUTH0_URL` / `auth0Client` -> a filename-safe `auth0-url` / `auth0-client`. */
export function slug(ref: string): string {
  const out = ref
    .replace(/^(process\.env|import\.meta\.env)\.?/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'backend';
}

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (EXTENSIONS.has(extname(entry.name))) found.push(full);
  }
  return found;
}

function candidates(target: string): string[] {
  if (existsSync(target) && statSync(target).isDirectory()) return walk(target);
  // Not a directory — treat it as a glob.
  const matched = globSync(target).filter((f) => EXTENSIONS.has(extname(f)));
  if (matched.length === 0) throw new Error(`No source files found at ${target}.`);
  return matched.map((f) => resolve(f));
}

/**
 * A file is a candidate only if it shows a CONCRETE backend-call signal. The previous heuristic
 * counted bare words (`api`, `request`, `method`), which almost every React file contains — so
 * scoring never discriminated and the cap dropped real call sites in lib/ for noisy components.
 * Fixed and built in: these shapes are general across codebases, so nothing here needs configuring.
 */
const SIGNALS: { re: RegExp; weight: number }[] = [
  // A base-URL reference off any env object — envServer.X_URL, process.env.X_URL, import.meta.env.X_URL.
  // Worth the most: it is also the key the model clusters backends on.
  { re: /\b\w*[eE]nv\w*\s*\.\s*[A-Z][A-Z0-9_]*_(?:URL|URI|ENDPOINT|HOST|BASE)\b/, weight: 3 },
  // A fetch whose URL is BUILT rather than a literal — a route, not a static asset.
  { re: /\bfetch\s*\(\s*`/, weight: 2 },
  // client.get(`/path`) / api.post('/path'). The leading slash is what keeps `searchParams.get('q')`
  // and `headers.get('x')` out — those are the false positives that made a bare `.get(` useless.
  { re: /\.\s*(?:get|post|put|patch|delete)\s*\(\s*[`'"]\//, weight: 2 },
  { re: /\baxios\s*(?:\.\s*(?:get|post|put|patch|delete|request)\s*)?\(/, weight: 2 },
];

/** Zero means "no backend call here" and the file never reaches the model. */
export function signalScore(text: string): number {
  let total = 0;
  for (const signal of SIGNALS) if (signal.re.test(text)) total += signal.weight;
  // ponytail: "URLSearchParams near a fetch" read as "in the same file". On its own it means nothing,
  // so it only breaks ties between files that already showed a real call. Line-distance if it matters.
  if (total > 0 && /\bURLSearchParams\b/.test(text)) total += 1;
  return total;
}

/**
 * Tests hardcode mock base URLs and fake fetch calls, so they invent backends that do not exist.
 * They also score well on the signal scan — a mocked `fetch(\`${BASE}/x\`)` looks exactly like a real
 * one — so they are dropped before scoring rather than after, or they would crowd out real handlers.
 */
export const isTestFile = (file: string): boolean =>
  /\.(test|spec)\.[jt]sx?$/.test(file) || /(^|\/)(__tests__|__mocks__)\//.test(file);

export type ScanCounts = {
  /** Every source file under the root, before any filtering. */
  walked: number;
  tests: number;
  oversize: number;
  /** Files showing at least one backend-call signal — the candidates. */
  matched: number;
  sent: number;
  dropped: number;
};

function gather(root: string): { files: SourceFile[]; counts: ScanCounts } {
  const found = candidates(root);
  // Tests are dropped BEFORE scoring: they hardcode mock base URLs that score as real call sites.
  const production = found.filter((f) => !isTestFile(f));
  const readable = production
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    .filter((c) => c.text.length <= MAX_FILE_BYTES);
  // Rank first, cap second, so the strongest call sites survive the cap instead of arbitrary files.
  const scored = readable
    .map((c) => ({ ...c, score: signalScore(c.text) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  const files: SourceFile[] = [];
  let bytes = 0;
  for (const candidate of scored) {
    if (files.length >= MAX_FILES || bytes + candidate.text.length > MAX_TOTAL_BYTES) continue;
    files.push({ rel: relative(root, candidate.file) || basename(candidate.file), text: candidate.text });
    bytes += candidate.text.length;
  }

  return {
    files,
    counts: {
      walked: found.length,
      tests: found.length - production.length,
      oversize: production.length - readable.length,
      matched: scored.length,
      sent: files.length,
      dropped: scored.length - files.length,
    },
  };
}

export async function runInit(target: string | undefined): Promise<void> {
  if (!target) {
    throw new Error(
      'init needs a path: driftcheck init <dir-or-glob> — point it at the code that calls your backend (e.g. src/app/api). There is no default.',
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('init needs ANTHROPIC_API_KEY set — it reads your codebase with Claude to draft the config.');
  }

  const root = resolve(process.cwd(), target);
  const { files, counts } = gather(root);
  if (counts.walked === 0) throw new Error(`No .ts/.tsx/.js/.jsx files found under ${root}.`);
  if (counts.matched === 0) {
    throw new Error(
      `No backend calls found under ${root} — point init at the dir that contains your API calls. ` +
        `(walked ${counts.walked} source file(s); none showed a fetch, an API client call, or a base-URL env reference.)`,
    );
  }

  console.log(
    `Walked ${counts.walked} source file(s) under ${root} — ${counts.matched} with a backend-call signal, ` +
      `${counts.sent} sent to Claude, ${counts.dropped} dropped by cap.`,
  );
  const notes = [
    counts.tests > 0 && `${counts.tests} test file(s) excluded`,
    counts.oversize > 0 && `${counts.oversize} oversize file(s) skipped`,
  ].filter(Boolean);
  if (notes.length > 0) console.log(dim(`(${notes.join(', ')})`));

  // Only source files the caller pointed us at — never .env, never anything outside the path.
  const payload = files.map((f) => `=== ${f.rel} ===\n${f.text}`).join('\n\n');

  let text: string;
  try {
    text = await completeJson({ system: SYSTEM_PROMPT, user: payload, maxTokens: MAX_TOKENS });
  } catch (err) {
    throw new Error(`Claude request failed, nothing written: ${err instanceof Error ? err.message : err}`);
  }

  let draft: z.infer<typeof DraftConfigSchema>;
  try {
    draft = DraftConfigSchema.parse(JSON.parse(text));
  } catch {
    throw new Error('Claude did not return a valid driftcheck config — nothing written. Re-run to try again.');
  }

  const returned = draft.backends.filter((b) => b.consumes.length > 0);
  if (returned.length === 0) {
    throw new Error(
      `No backend operations found in the scanned files — nothing written. Point init at the directory where API calls live.`,
    );
  }

  const { groups: backends, folded } = clusterBackends(returned);
  if (folded.length > 0) {
    console.log(
      `\nIgnored ${folded.length} group(s) not named after a base URL (${folded.join(', ')}) — their routes were folded into the largest backend.`,
    );
  }

  const dir = resolve(process.cwd(), CONFIG_DIR);
  mkdirSync(dir, { recursive: true });

  /** Never overwrite: an existing file keeps its content and the new draft lands beside it. */
  function write(name: string, config: unknown): { file: string; drafted: boolean } {
    const primary = resolve(dir, name);
    const drafted = existsSync(primary);
    const outPath = drafted ? primary.replace(/\.json$/, '.draft.json') : primary;
    writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);
    return { file: basename(outPath), drafted };
  }

  /**
   * Adds a blank slot for each backend not already in `backends.json`, leaving every existing entry
   * exactly as it is — that is the whole point: a filled-in specUrl survives deleting and re-running
   * init. Returns the keys that are new, so the caller can tell the user what still needs typing in.
   */
  function registerBackends(entries: { key: string; specUrl?: string }[]): string[] {
    const registry = readRegistry();
    const added = entries.filter((e) => !(e.key in registry));
    if (added.length === 0) return [];
    for (const { key, specUrl } of added) registry[key] = { specUrl: specUrl ?? '', basePath: '' };
    writeFileSync(resolve(dir, BACKENDS_FILE), `${JSON.stringify(registry, null, 2)}\n`);
    return added.map((e) => e.key);
  }

  /** Omitted rather than emitted empty: an absent list means "monitor every header", empty means "none". */
  const headerField = (backend: { globalHeaders?: string[] }) =>
    backend.globalHeaders?.length ? { globalHeaders: backend.globalHeaders } : {};

  const describeRoute = (route: Route) => {
    const parts = [
      route.headers?.length && `${route.headers.length} header(s)`,
      route.responseFields?.length && `${route.responseFields.length} response field(s)`,
    ].filter(Boolean);
    return parts.length > 0 ? ` ${dim(`(${parts.join(', ')})`)}` : '';
  };

  if (backends.length === 1) {
    const only = backends[0];
    // specUrl and basePath live in backends.json, never here — that is what survives a re-init.
    const { file, drafted } = write(DEFAULT_CONFIG, {
      ...headerField(only),
      consumes: only.consumes,
    });
    const added = registerBackends([{ key: 'default', specUrl: draft.specUrl }]);

    console.log(`\nFound ${only.consumes.length} operation(s):`);
    for (const route of only.consumes) console.log(`  - ${route.method} ${route.path}${describeRoute(route)}`);
    if (only.globalHeaders?.length) console.log(`Global headers: ${cyan(only.globalHeaders.join(', '))}`);
    console.log(`\n${green('Wrote')} ${bold(`${CONFIG_DIR}/${file}`)}.`);
    if (added.length === 0) {
      console.log(dim(`Reused the existing 'default' entry in ${CONFIG_DIR}/${BACKENDS_FILE} — specUrl unchanged.`));
    } else if (draft.specUrl) {
      console.log(`specUrl: ${cyan(draft.specUrl)} ${dim(`(recorded in ${CONFIG_DIR}/${BACKENDS_FILE})`)}`);
    } else {
      console.log(
        `Fill in specUrl under 'default' in ${bold(`${CONFIG_DIR}/${BACKENDS_FILE}`)} before running — ` +
          'basePath too, if your spec paths carry a shared prefix like /api/v1.',
      );
    }
    if (drafted) {
      console.log(`An existing ${CONFIG_DIR}/${DEFAULT_CONFIG} was left untouched — review and merge the draft yourself.`);
    }
    console.log(dim('Review before running: driftcheck treats this config as the source of truth for what you consume.'));
    return;
  }

  console.log(`\n${bold(`${backends.length} backends detected`)} — one config file each, checked independently.`);
  const written: string[] = [];
  const keys: { key: string; specUrl?: string }[] = [];
  const taken = new Set<string>();
  for (const backend of backends) {
    let name = `driftcheck.${slug(backend.ref)}.config.json`;
    // Two refs can slug to the same name (API_URL / apiUrl) — never let one backend overwrite another.
    for (let i = 2; taken.has(name); i++) name = `driftcheck.${slug(backend.ref)}-${i}.config.json`;
    taken.add(name);
    // No specUrl here: a spec URL visible in the code can't be attributed to one of several backends,
    // and both it and basePath belong in backends.json, keyed off this filename.
    const { file, drafted } = write(name, {
      ...headerField(backend),
      consumes: backend.consumes,
    });
    written.push(file);
    keys.push({ key: backendKey(name) });

    console.log(`\n  ${cyan(backend.ref)} — ${backend.consumes.length} operation(s) -> ${bold(file)}`);
    if (backend.globalHeaders?.length) console.log(`    global headers: ${backend.globalHeaders.join(', ')}`);
    for (const route of backend.consumes) console.log(`    - ${route.method} ${route.path}${describeRoute(route)}`);
    if (drafted) console.log(`    ${name} already existed and was left untouched — review and merge the draft.`);
  }

  const added = registerBackends(keys);
  const reused = keys.length - added.length;

  console.log(`\n${green('Wrote')} ${written.length} file(s) to ${bold(`${CONFIG_DIR}/`)}.`);
  if (reused > 0) {
    console.log(
      dim(`${reused} backend(s) already in ${CONFIG_DIR}/${BACKENDS_FILE} — their specUrl and basePath were kept.`),
    );
  }
  if (added.length > 0) {
    console.log(`\nFill in specUrl for ${added.length} new backend(s) in ${bold(`${CONFIG_DIR}/${BACKENDS_FILE}`)}:`);
    for (const key of added) console.log(`  ${key}`);
    console.log(
      dim("  (basePath too, where the spec paths carry a shared prefix like /api/v1 that the frontend's base URL hides)"),
    );
  }
  console.log('\nThen check each backend separately:');
  for (const name of written) console.log(`  driftcheck check ${name}`);
  console.log(dim('\n(or run `driftcheck check` with no argument to pick one interactively)'));
  console.log(
    dim(
      '\nThese groupings are a best-effort guess from the base-URL references in your code (env vars and client instances) — driftcheck cannot resolve what they point at. Review the split before running; move routes between files if a call was placed with the wrong backend.',
    ),
  );
}
