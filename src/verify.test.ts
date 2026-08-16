// Run: node --import tsx src/verify.test.ts
import assert from 'node:assert/strict';
import type { Config } from './config.js';
import { verify } from './verify.js';

const jsonBody = (schema: unknown) => ({ content: { 'application/json': { schema } } });

const spec = {
  components: {
    schemas: {
      Order: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          customer: {
            type: 'object',
            properties: { email: { type: 'string' } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  },
  security: [{ bearer: [] }],
  paths: {
    '/orders/{orderId}': {
      get: {
        parameters: [
          { name: 'X-Region', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'X-Legacy', in: 'header', required: false, deprecated: true, schema: { type: 'string' } },
          { name: 'X-Optional', in: 'header', required: false, schema: { type: 'string' } },
          { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': jsonBody({ $ref: '#/components/schemas/Order' }) },
      },
    },
    '/loose': { get: { responses: { '200': jsonBody({ type: 'object' }) } } },
    '/nobody': { post: { responses: { '204': {} } } },
  },
};

const config = (route: Partial<Config['consumes'][number]>, extra: Partial<Config> = {}): Config =>
  ({
    specUrl: 'https://x.test/spec.json',
    consumes: [{ method: 'GET', path: '/orders/{id}', ...route }],
    ...extra,
  }) as Config;

const codes = (c: Config) => verify(c, spec).map((f) => f.code);
const subjects = (c: Config) => verify(c, spec).map((f) => f.subject);

// A route whose config declares nothing produces nothing — same silence as check's v1 fallback.
assert.deepEqual(codes(config({})), [], 'no responseFields, no headers -> nothing to verify');

// Path parameter names are not identity: config says {id}, the spec says {orderId}.
assert.deepEqual(codes(config({ responseFields: ['total'] })), [], 'present field, and {id} matches {orderId}');
assert.deepEqual(codes(config({ responseFields: ['customer.email'] })), [], 'nested through a $ref');

// The finding verify exists to produce.
{
  const found = verify(config({ responseFields: ['total', 'customer.phone', 'shippedAt'] }), spec);
  assert.deepEqual(found.map((f) => f.subject), ['customer.phone', 'shippedAt']);
  assert.ok(found.every((f) => f.code === 'response-field-missing' && f.severity === 'breaking'));
  assert.match(found[0].reason, /customer\.phone/);
}

// Unprovable must stay silent. Each of these reported as breaking would be a fabricated alert.
assert.deepEqual(
  codes(config({ path: '/loose', responseFields: ['anything.at.all'] })),
  [],
  'free-form response object proves nothing',
);
assert.deepEqual(
  codes(config({ method: 'POST', path: '/nobody', responseFields: ['whatever'] })),
  [],
  'no declared success body proves nothing',
);

// Headers: only judged when the config recorded what the frontend sends.
assert.deepEqual(codes(config({ headers: ['x-region'] })), [], 'required header that IS sent');
assert.deepEqual(
  codes(config({ headers: ['x-other'] })),
  ['required-header-not-sent'],
  'required header that is not sent',
);
assert.deepEqual(subjects(config({ headers: ['x-other'] })), ['x-region'], 'lowercase, and names the header');
assert.deepEqual(
  codes(config({}, { globalHeaders: ['x-region'] })),
  [],
  'globalHeaders satisfy the requirement too',
);
assert.deepEqual(
  codes(config({ headers: ['X-REGION'] })),
  [],
  'case never decides — header names are compared lowercase',
);

// Deprecated fires only for a header the frontend actually sends.
{
  const found = verify(config({ headers: ['x-region', 'x-legacy'] }), spec);
  assert.deepEqual(found.map((f) => f.code), ['header-deprecated']);
  assert.equal(found[0].severity, 'relevant');
  assert.equal(found[0].subject, 'x-legacy');
}
assert.deepEqual(codes(config({ headers: ['x-region'] })), [], 'deprecated but not sent -> silence');

// An optional header the frontend does not send is not a finding.
assert.deepEqual(codes(config({ headers: ['x-region'] })), [], 'x-optional is optional');

// Bearer auth applies to the whole API, so it must not become a per-route finding.
assert.deepEqual(
  codes(config({ headers: ['x-region'] })),
  [],
  'security-derived authorization is excluded deliberately',
);

// Operation missing.
{
  const found = verify(
    config({ responseFields: ['total'] }, { consumes: [{ method: 'GET', path: '/orders/{id}' }, { method: 'GET', path: '/gone' }] } as Partial<Config>),
    spec,
  );
  assert.deepEqual(found.map((f) => f.code), ['operation-missing']);
  assert.equal(found[0].path, '/gone');
}

// Every route missing is a misconfiguration, not N breakages — one finding that names the cause.
{
  const found = verify(
    { specUrl: 'https://x.test/s.json', consumes: [{ method: 'GET', path: '/a' }, { method: 'GET', path: '/b' }] } as Config,
    spec,
  );
  assert.deepEqual(found.map((f) => f.code), ['no-routes-matched']);
  assert.match(found[0].reason, /specUrl and basePath.*currently unset/);
}

// basePath is applied to config paths, exactly as in check.
{
  const prefixed = { ...spec, paths: { '/api/v1/orders/{orderId}': spec.paths['/orders/{orderId}'] } };
  const c = config({ responseFields: ['total'] }, { basePath: '/api/v1' });
  assert.deepEqual(verify(c, prefixed).map((f) => f.code), [], 'basePath makes the route match');
  assert.deepEqual(
    verify(config({ responseFields: ['total'] }), prefixed).map((f) => f.code),
    ['no-routes-matched'],
    'and without it, nothing matches',
  );
  assert.match(verify(c, { paths: {} }).map((f) => f.reason).join(), /currently '\/api\/v1'/);
}

// Keys are stable across runs and unique per disagreement — the app closes issues by their absence.
{
  const c = config({ responseFields: ['customer.phone', 'shippedAt'], headers: ['x-other'] });
  const first = verify(c, spec).map((f) => f.key);
  const second = verify(c, spec).map((f) => f.key);
  assert.deepEqual(first, second, 'stateless: same inputs, same keys');
  assert.equal(new Set(first).size, first.length, 'no two findings share a key');
  assert.deepEqual(first, [
    'required-header-not-sent:GET /orders/{id}:x-region',
    'response-field-missing:GET /orders/{id}:customer.phone',
    'response-field-missing:GET /orders/{id}:shippedAt',
  ]);
}

// A path the frontend serves itself is absent from every backend spec by definition. Excusing that
// must not excuse anything else, or a BFF-mirrored route stops being checked at all.
{
  const bff = (extra: object) => ({
    specUrl: 'https://x.test/spec.json',
    consumes: [{ method: 'GET' as const, path: '/auth/session', served: true, ...extra }],
  });

  assert.deepEqual(verify(bff({}), spec).map((f) => f.code), [], 'its own handler is not a deleted route');
  assert.deepEqual(
    verify({ ...bff({}), consumes: [{ method: 'GET', path: '/auth/session' }] }, spec).map((f) => f.code),
    ['no-routes-matched'],
    'the same route unmarked is still reported',
  );

  // Marked AND present in the spec — the common case, since a BFF usually forwards the path unchanged.
  const served: Config = {
    specUrl: 'https://x.test/spec.json',
    consumes: [
      { method: 'GET', path: '/orders/{orderId}', served: true, responseFields: ['customer.phone'], headers: [] },
    ],
  };
  assert.deepEqual(
    verify(served, spec).map((f) => f.code),
    ['required-header-not-sent', 'response-field-missing'],
    'a served route that exists is checked exactly like any other',
  );
}

console.log('ok');
