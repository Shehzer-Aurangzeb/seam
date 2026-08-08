// Run: pnpm dev:test  (node --import tsx src/multiBackend.test.ts)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { backendKey, loadConfig, resolveConfigPath } from './config.js';
import {
  clusterBackends,
  importSpecifiers,
  isTestFile,
  isValidRef,
  normalizeRef,
  resolveImport,
  signalScore,
  slug,
} from './init.js';
import { snapshotPath } from './snapshot.js';

// isTestFile: tests and mocks out, production in
for (const f of [
  '/a/x.test.ts',
  '/a/x.test.tsx',
  '/a/x.spec.js',
  '/a/x.spec.jsx',
  '/a/__tests__/x.ts',
  '/a/__mocks__/x.ts',
])
  assert.equal(isTestFile(f), true, f);
for (const f of ['/a/route.ts', '/a/latest.ts', '/a/testUtils.ts', '/a/contest.ts', '/a/spec-helper.ts'])
  assert.equal(isTestFile(f), false, f);

// normalizeRef: strip whatever accessor the codebase reads env through
assert.equal(normalizeRef('envServer.PLATFORM_SERVICE_URL'), 'PLATFORM_SERVICE_URL');
assert.equal(normalizeRef('process.env.API_URL'), 'API_URL');
assert.equal(normalizeRef('config.env.AUTH0_URL'), 'AUTH0_URL');
assert.equal(normalizeRef('apiClient'), 'apiClient');
assert.equal(normalizeRef('https://auth0.test'), 'https://auth0.test'); // not an identifier — left alone, then rejected

// isValidRef: env vars and client instances only
for (const ok of ['API_URL', 'PLATFORM_SERVICE_URL', 'apiClient', 'auth0Client', 'usersApi', 'billingService'])
  assert.equal(isValidRef(ok), true, ok);
for (const bad of [
  'Auth0 endpoints (hardcoded)',
  'https://auth0.test',
  'identity-provider service',
  'queryIdp',
  'getPlatformUsersByIds',
  'User service endpoint',
  '',
])
  assert.equal(isValidRef(bad), false, bad);

// clusterBackends: accessor variants merge, prose folds into the LARGEST valid group
{
  const { groups, folded } = clusterBackends([
    { ref: 'envServer.PLATFORM_SERVICE_URL', consumes: [{ method: 'GET', path: '/a' }] },
    { ref: 'process.env.PLATFORM_SERVICE_URL', consumes: [{ method: 'GET', path: '/a' }, { method: 'GET', path: '/b' }] },
    { ref: 'AUTH0_API_DOMAIN', consumes: [{ method: 'GET', path: '/z' }] },
    { ref: 'identity-provider service', consumes: [{ method: 'POST', path: '/users/query' }] },
  ]);
  assert.deepEqual(
    groups.map((g) => g.ref),
    ['PLATFORM_SERVICE_URL', 'AUTH0_API_DOMAIN'],
  );
  assert.deepEqual(folded, ['identity-provider service']);
  // /a deduped across the two accessor spellings; the prose group's route landed in the largest
  assert.deepEqual(groups[0].consumes.map((r) => r.path), ['/a', '/b', '/users/query']);
  assert.equal(groups[1].consumes.length, 1, 'smaller valid group untouched');
}

// clusterBackends: no valid ref at all -> ONE unnamed group with every route, never a prose file
{
  const { groups, folded } = clusterBackends([
    { ref: 'Auth0 endpoints (hardcoded)', consumes: [{ method: 'POST', path: '/oauth/token' }] },
    { ref: 'https://auth.test', consumes: [{ method: 'POST', path: '/oauth/token' }, { method: 'GET', path: '/u' }] },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ref, '', 'unnamed -> caller writes the default filename');
  assert.deepEqual(groups[0].consumes.map((r) => r.path), ['/oauth/token', '/u']);
  assert.equal(folded.length, 2);
}

// resolveConfigPath: bare names live in config/, explicit paths are left alone
assert.equal(resolveConfigPath('driftcheck.config.json'), resolve(process.cwd(), 'config/driftcheck.config.json'));
assert.equal(resolveConfigPath('./other/x.json'), resolve(process.cwd(), 'other/x.json'));
assert.equal(resolveConfigPath('../up.json'), resolve(process.cwd(), '../up.json'));
assert.equal(resolveConfigPath('/abs/x.json'), '/abs/x.json');

// slug: filename-safe, distinct per ref, never empty
assert.equal(slug('API_URL'), 'api-url');
assert.equal(slug('process.env.AUTH0_URL'), 'auth0-url');
assert.equal(slug('import.meta.env.VITE_API_URL'), 'vite-api-url');
assert.equal(slug('AUTH0_URL'), 'auth0-url');
assert.equal(slug('auth0Client'), 'auth0-client');
assert.equal(slug('apiClient'), 'api-client');
assert.equal(slug('https://x.auth0.com'), 'https-x-auth0-com');
assert.equal(slug('___'), 'backend');
assert.match(slug('weird/ref name!'), /^[a-z0-9-]+$/);

// snapshotPath: legacy default preserved, everything else distinct
assert.equal(basename(snapshotPath('driftcheck.config.json')), 'snapshot.json');
assert.equal(
  basename(snapshotPath('driftcheck.auth0-url.config.json')),
  'driftcheck.auth0-url.config.snapshot.json',
);
const paths = [
  'driftcheck.config.json',
  'driftcheck.api-url.config.json',
  'driftcheck.auth0-url.config.json',
].map(snapshotPath);
assert.equal(new Set(paths).size, paths.length, 'backends must not share a snapshot');

// signalScore decides what the model ever sees, so a miss here is a route silently never detected.
{
  const scored = (text: string) => signalScore(text);

  // Real call shapes must all survive.
  assert.ok(scored('await fetch(`${envServer.PLATFORM_SERVICE_URL}/users/query`)') > 0, 'env base URL + template fetch');
  assert.ok(scored('const r = await api.get(`/asset-records/${id}`)') > 0, 'client call with a path');
  assert.ok(scored("axios.post('/files/upload', body)") > 0, 'axios call');
  assert.ok(scored('const { data } = await backend.get(`/reports/${id}`)') > 0, 'any client identifier');
  assert.ok(scored('fetch(`${process.env.IDP_SERVICE_URL}/roles/query`)') > 0, 'process.env base URL');

  // Noise must not. These are the false positives that made the old word-count ranker useless.
  assert.equal(scored('const q = searchParams.get("page")'), 0, 'searchParams.get is not an API call');
  assert.equal(scored('const v = headers.get("x-trace")'), 0, 'headers.get is not an API call');
  assert.equal(scored('export function useRequest() { return { method: "api", endpoint: 1 } }'), 0, 'bare API words');
  assert.equal(scored('export const Button = () => <button>go</button>'), 0, 'a plain component');

  // A base-URL reference outranks a lone call, so the cap keeps the file that names the backend.
  assert.ok(
    scored('fetch(`${envServer.PLATFORM_SERVICE_URL}/x`)') > scored("api.get('/x')"),
    'base-URL references rank highest',
  );
  // URLSearchParams only breaks ties — on its own it is not a backend call.
  assert.equal(scored('new URLSearchParams({ page: "1" })'), 0, 'query string alone is not a signal');
  assert.ok(
    scored('fetch(`${u}/x`); new URLSearchParams(p)') > scored('fetch(`${u}/x`)'),
    'query string beside a real call breaks the tie',
  );
}

// backendKey: the registry key must survive regeneration and drafts, or a filled-in specUrl is lost.
assert.equal(backendKey('driftcheck.config.json'), 'default');
assert.equal(backendKey('driftcheck.config.draft.json'), 'default');
assert.equal(backendKey('driftcheck.platform-service-url.config.json'), 'platform-service-url');
assert.equal(backendKey('driftcheck.platform-service-url.config.draft.json'), 'platform-service-url');
assert.equal(backendKey('/abs/config/driftcheck.auth0-api-domain.config.json'), 'auth0-api-domain');
assert.equal(backendKey('other.json'), 'other');

// loadConfig merges backends.json — the whole point is that a regenerated config carries neither field.
{
  const root = mkdtempSync(join(tmpdir(), 'driftcheck-'));
  mkdirSync(join(root, 'config'));
  const put = (name: string, body: unknown) =>
    writeFileSync(join(root, 'config', name), JSON.stringify(body, null, 2));
  const consumes = [{ method: 'GET', path: '/orders' }];

  put('backends.json', {
    'platform-service-url': { specUrl: 'https://platform.test/openapi.json', basePath: '/api/v1' },
    'own-url': { specUrl: 'https://registry.test/spec.json' },
  });
  put('driftcheck.platform-service-url.config.json', { globalHeaders: ['authorization'], consumes });
  // What init actually writes today: both fields present but blank. The registry must still win.
  put('driftcheck.own-url.config.json', { specUrl: '', basePath: '', consumes });
  put('driftcheck.override-url.config.json', { specUrl: 'https://inline.test/spec.json', consumes });
  put('driftcheck.missing-url.config.json', { consumes });

  const cwd = process.cwd();
  try {
    process.chdir(root);

    const merged = loadConfig('driftcheck.platform-service-url.config.json');
    assert.equal(merged.specUrl, 'https://platform.test/openapi.json', 'specUrl comes from the registry');
    assert.equal(merged.basePath, '/api/v1', 'basePath comes from the registry');
    assert.deepEqual(merged.globalHeaders, ['authorization'], 'the config file still owns what it consumes');

    assert.equal(
      loadConfig('driftcheck.own-url.config.json').specUrl,
      'https://registry.test/spec.json',
      "a blank specUrl in the file is a placeholder, not a value — it must not shadow the registry",
    );

    assert.equal(
      loadConfig('driftcheck.override-url.config.json').specUrl,
      'https://inline.test/spec.json',
      'a real value in the file still wins, so one backend can override the shared entry',
    );

    assert.throws(
      () => loadConfig('driftcheck.missing-url.config.json'),
      /specUrl not set for 'missing-url'.*backends\.json/s,
      'an unregistered backend must name itself and where to fix it',
    );
  } finally {
    process.chdir(cwd);
  }
}

// ---------- import following: the depth-1 context that carries responseFields ----------

assert.deepEqual(
  importSpecifiers(
    [
      "import { getSession } from '@/lib/session';",
      "import type { User } from './types';",
      "export { x } from '../shared';",
      "const mod = await import('@/lib/lazy');",
      "import 'server-only';",
    ].join('\n'),
  ),
  ['@/lib/session', './types', '../shared', '@/lib/lazy'],
  "static, re-export and dynamic imports are followed; a bare side-effect import is not a 'from'",
);

{
  const root = '/app/src';
  const known = new Set([
    '/app/src/lib/session.ts',
    '/app/src/lib/api/index.ts',
    '/app/src/components/Card.tsx',
  ]);
  const from = '/app/src/lib/platform.ts';
  const r = (spec: string) => resolveImport(spec, from, root, known);

  assert.equal(r('@/lib/session'), '/app/src/lib/session.ts', '@/ aliases the scan root');
  assert.equal(r('./session'), '/app/src/lib/session.ts', 'relative, extension inferred');
  assert.equal(r('@/lib/api'), '/app/src/lib/api/index.ts', 'a directory resolves to its index');
  assert.equal(r('../components/Card.tsx'), '/app/src/components/Card.tsx', 'explicit extension');
  assert.equal(r('next/navigation'), undefined, 'a package is never pulled in');
  assert.equal(r('@/lib/nope'), undefined, 'an unwalked file is never pulled in');
  assert.equal(r('@/styles.css'), undefined, 'a non-source import never resolves — the scan only walked source');
  assert.equal(r('../../../etc/passwd'), undefined, 'nothing outside the scanned set, ever');
}

console.log('ok');
