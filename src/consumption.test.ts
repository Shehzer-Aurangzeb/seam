// v2 field- and header-level consumption scoping.
// Run: node --import tsx src/consumption.test.ts
import assert from 'node:assert/strict';
import { classifyAll, type Severity } from './classify.js';
import type { Config, ConsumedRoute } from './config.js';
import { diffSpecs } from './diff.js';
import { breakingHeaderSchema, effectiveHeaders, specHeaders } from './headers.js';
import { clusterBackends } from './init.js';
import { fieldPath } from './util/describe.js';

// ---------- header resolution ----------

assert.equal(effectiveHeaders({}, {}), undefined, 'v1 config: neither list declared');
assert.equal(effectiveHeaders({}, undefined), undefined, 'route not found is still v1');
assert.deepEqual(effectiveHeaders({ globalHeaders: [] }, {}), [], 'an empty list is a declaration');

assert.deepEqual(
  effectiveHeaders({ globalHeaders: ['Authorization', 'X-Tenant-Id'] }, { headers: ['X-Idempotency-Key'] }),
  ['authorization', 'x-tenant-id', 'x-idempotency-key'],
);
assert.deepEqual(
  effectiveHeaders({ globalHeaders: ['Authorization'] }, { headers: ['authorization', 'AUTHORIZATION'] }),
  ['authorization'],
  'case variants collapse to one member',
);
assert.deepEqual(effectiveHeaders({ globalHeaders: ['X-A'] }, undefined), ['x-a'], 'global alone is enough');

// init stores headers lowercase and unions what each sighting of a route observed.
{
  const { groups } = clusterBackends([
    {
      ref: 'API_URL',
      globalHeaders: ['Authorization'],
      consumes: [{ method: 'GET', path: '/orders', headers: ['X-Trace'], responseFields: ['id'] }],
    },
    {
      ref: 'process.env.API_URL',
      globalHeaders: ['X-Tenant-Id', 'authorization'],
      consumes: [{ method: 'GET', path: '/orders', headers: ['X-Idempotency-Key'], responseFields: ['total'] }],
    },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].globalHeaders, ['authorization', 'x-tenant-id']);
  assert.equal(groups[0].consumes.length, 1, 'one route, seen twice');
  assert.deepEqual(groups[0].consumes[0].headers, ['x-trace', 'x-idempotency-key']);
  assert.deepEqual(groups[0].consumes[0].responseFields, ['id', 'total'], 'field lists merge, case intact');
  assert.equal(groups[0].consumes[0].requestFields, undefined, 'never observed stays undefined');
}

// init never writes an empty list — the key is dropped so the config reads as "monitor everything".
{
  const { groups } = clusterBackends([
    { ref: 'API_URL', globalHeaders: [], consumes: [{ method: 'GET', path: '/orders', headers: [], responseFields: [] }] },
  ]);
  assert.equal(groups[0].globalHeaders, undefined);
  assert.equal(groups[0].consumes[0].headers, undefined);
  assert.equal(groups[0].consumes[0].responseFields, undefined);
}

// ---------- dot / [] notation ----------

const at = (...segments: (string | number)[]) => fieldPath(segments);
assert.equal(at('responses', '200', 'content', 'application/json', 'schema', 'properties', 'total'), 'total');
assert.equal(at('schema', 'properties', 'profile', 'properties', 'firstName'), 'profile.firstName');
assert.equal(at('schema', 'properties', 'items', 'items', 'properties', 'sku'), 'items[].sku');
assert.equal(at('schema', 'properties', 'items'), 'items', 'the array property itself');
assert.equal(at('responses', '200', 'description'), null, 'not a field-level path');

// ---------- spec header extraction ----------

const SCHEMES = {
  bearerAuth: { type: 'http', scheme: 'bearer' },
  tenantKey: { type: 'apiKey', in: 'header', name: 'X-Tenant-Id' },
  cookieKey: { type: 'apiKey', in: 'cookie', name: 'session' },
};

{
  const op = {
    parameters: [
      { name: 'X-Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } },
      { name: 'status', in: 'query', schema: { type: 'string' } },
    ],
    security: [{ bearerAuth: [] }, { tenantKey: [] }, { cookieKey: [] }],
    requestBody: { content: {} },
    responses: { '200': {} },
  };
  const headers = specHeaders(op, { components: { securitySchemes: SCHEMES } });

  assert.deepEqual([...headers.keys()].sort(), [
    'accept',
    'authorization',
    'content-type',
    'x-idempotency-key',
    'x-tenant-id',
  ]);
  assert.equal(headers.get('x-idempotency-key')?.source, 'parameter');
  assert.equal(headers.get('authorization')?.source, 'security', 'bearer auth implies authorization');
  assert.equal(headers.get('x-tenant-id')?.required, true, 'apiKey-in-header is a required header');
  assert.equal(headers.get('content-type')?.source, 'implicit', 'requestBody implies content-type');
  assert.equal(headers.get('accept')?.required, false, 'implicit headers are never required');
  assert.equal(headers.has('session'), false, 'a cookie scheme is not a header');
}

assert.equal(specHeaders({ responses: {}, security: [] }, { security: [{ bearerAuth: [] }] }).has('authorization'), false,
  'an empty operation-level security overrides the document default');

// ---------- header schema narrowing ----------

assert.equal(breakingHeaderSchema({ type: 'string' }, { type: 'string' }), null);
assert.match(breakingHeaderSchema({ type: 'string' }, { type: 'integer' }) ?? '', /type/);
assert.match(breakingHeaderSchema({ type: 'string' }, { type: 'string', format: 'uuid' }) ?? '', /format/);
assert.match(breakingHeaderSchema({ enum: ['a', 'b'] }, { enum: ['a'] }) ?? '', /dropped/);
assert.equal(breakingHeaderSchema({ enum: ['a'] }, {}), null, 'dropping the constraint widens, not narrows');

// ---------- classification ----------

const jsonSchema = (properties: Record<string, unknown>) => ({
  responses: { '200': { content: { 'application/json': { schema: { type: 'object', properties } } } } },
});

const specOf = (op: unknown) => ({
  paths: { '/orders': { get: op } },
  components: { securitySchemes: SCHEMES },
});

const configOf = (route: Partial<ConsumedRoute>, globalHeaders?: string[]): Config => ({
  specUrl: 'https://example.com/openapi.json',
  ...(globalHeaders ? { globalHeaders } : {}),
  consumes: [{ method: 'GET', path: '/orders', ...route }],
});

/** The real check pipeline: diff two specs, then judge what the config says the frontend uses. */
function check(oldOp: unknown, newOp: unknown, config: Config) {
  const oldSpec = specOf(oldOp);
  const newSpec = specOf(newOp);
  const [result] = classifyAll(diffSpecs(oldSpec, newSpec), config, oldSpec, newSpec);
  assert.ok(result, 'expected the change to land on the consumed route');
  return result;
}

const reasons = (r: { reasons: string[] }) => r.reasons.join(' | ');
const expect = (r: { severity: Severity; reasons: string[] }, severity: Severity, note: string) =>
  assert.equal(r.severity, severity, `${note} — got ${r.severity}: ${reasons(r)}`);

// One schema under several media types is ONE contract change. The spec repeats it, microdiff repeats
// it, and before the dedupe every reason and every raw line came out twice.
{
  const bothTypes = (properties: Record<string, unknown>) => ({
    responses: {
      '200': {
        content: {
          'application/json': { schema: { type: 'object', properties } },
          'application/xml': { schema: { type: 'object', properties } },
        },
      },
    },
  });

  const result = check(
    bothTypes({ total: { type: 'number' }, note: { type: 'string' } }),
    bothTypes({ total: { type: 'string' }, note: { type: 'string' } }),
    configOf({ responseFields: ['total'] }),
  );
  expect(result, 'breaking', 'a retyped consumed field still breaks');
  assert.equal(result.reasons.length, 1, `one edit, one reason — got: ${result.reasons.join(' | ')}`);
  assert.equal(result.rawChanges.length, 1, 'and one raw line under it');

  // Two real edits stay two, so the dedupe cannot swallow a distinct change.
  const two = check(
    bothTypes({ total: { type: 'number' }, note: { type: 'string' } }),
    bothTypes({ total: { type: 'string' }, note: { type: 'integer' } }),
    configOf({ responseFields: ['total', 'note'] }),
  );
  assert.equal(two.reasons.length, 2, `two edits, two reasons — got: ${two.reasons.join(' | ')}`);

  // json and xml describing genuinely different shapes are genuinely different changes.
  const divergent = check(
    {
      responses: {
        '200': {
          content: {
            'application/json': { schema: { type: 'object', properties: { total: { type: 'number' } } } },
            'application/xml': { schema: { type: 'object', properties: { total: { type: 'number' } } } },
          },
        },
      },
    },
    {
      responses: {
        '200': {
          content: {
            'application/json': { schema: { type: 'object', properties: { total: { type: 'string' } } } },
            'application/xml': { schema: { type: 'object', properties: { total: { type: 'boolean' } } } },
          },
        },
      },
    },
    configOf({ responseFields: ['total'] }),
  );
  assert.equal(divergent.reasons.length, 2, 'different target types are not the same change');
}

// A removed field that IS consumed breaks; one that is not is ignored; v1 keeps flagging both.
{
  const before = jsonSchema({ id: { type: 'string' }, email: { type: 'string' } });
  const after = jsonSchema({ id: { type: 'string' } });

  expect(check(before, after, configOf({ responseFields: ['id', 'email'] })), 'breaking', 'consumed field removed');
  expect(check(before, after, configOf({ responseFields: ['id'] })), 'ignore', 'unconsumed field removed');
  expect(check(before, after, configOf({})), 'breaking', 'v1 fallback: every removal breaks');
  // An empty list is "nobody looked", never "reads nothing" — models write [] where they mean to omit.
  expect(check(before, after, configOf({ responseFields: [] })), 'breaking', 'empty list must not silence drift');
}

// Type changes, nested paths and array notation follow the same scoping.
{
  const before = jsonSchema({ profile: { type: 'object', properties: { firstName: { type: 'string' } } } });
  const after = jsonSchema({ profile: { type: 'object', properties: { firstName: { type: 'integer' } } } });
  expect(check(before, after, configOf({ responseFields: ['profile.firstName'] })), 'breaking', 'nested type change');
  expect(check(before, after, configOf({ responseFields: ['profile.lastName'] })), 'ignore', 'sibling field retyped');
}
{
  const list = (sku: unknown) => jsonSchema({ items: { type: 'array', items: { type: 'object', properties: sku } } });
  const before = list({ sku: { type: 'string' }, colour: { type: 'string' } });
  expect(
    check(before, list({ colour: { type: 'string' } }), configOf({ responseFields: ['items[].sku'] })),
    'breaking',
    'items[].sku removed',
  );
  expect(
    check(before, list({ sku: { type: 'string' } }), configOf({ responseFields: ['items[].sku'] })),
    'ignore',
    'unconsumed array element field removed',
  );
  // Dropping the whole array takes every path under it with it.
  expect(
    check(before, jsonSchema({}), configOf({ responseFields: ['items[].sku'] })),
    'breaking',
    'ancestor of a consumed path removed',
  );
}

// A field leaving the response `required` set is scoped the same way.
{
  const withRequired = (required: string[]) => ({
    responses: {
      '200': {
        content: {
          'application/json': {
            schema: { type: 'object', required, properties: { id: { type: 'string' }, email: { type: 'string' } } },
          },
        },
      },
    },
  });
  const before = withRequired(['id', 'email']);
  expect(check(before, withRequired(['id']), configOf({ responseFields: ['email'] })), 'breaking', 'consumed field no longer guaranteed');
  expect(check(before, withRequired(['id']), configOf({ responseFields: ['id'] })), 'ignore', 'unconsumed field no longer guaranteed');
}

// Additions of fields nobody reads are noise.
expect(
  check(jsonSchema({ id: { type: 'string' } }), jsonSchema({ id: { type: 'string' }, tracking: { type: 'string' } }),
    configOf({ responseFields: ['id'] })),
  'ignore',
  'unconsumed field added',
);

// A newly required header the frontend does not send breaks it; one it already sends does not.
{
  const before = { parameters: [], ...jsonSchema({ id: { type: 'string' } }) };
  const after = {
    parameters: [{ name: 'X-Tenant-Id', in: 'header', required: true, schema: { type: 'string' } }],
    ...jsonSchema({ id: { type: 'string' } }),
  };

  expect(check(before, after, configOf({ headers: [] }, ['authorization'])), 'breaking', 'required header not sent');
  expect(
    check(before, after, configOf({ headers: [] }, ['Authorization', 'X-Tenant-Id'])),
    'ignore',
    'required header already in globalHeaders',
  );
  expect(
    check(before, after, configOf({ headers: ['x-tenant-id'] }, ['authorization'])),
    'ignore',
    'required header declared on the route',
  );
  expect(check(before, after, configOf({})), 'breaking', 'v1 fallback: a new required header still breaks');
}

// Security schemes count as headers: adding bearer auth demands one the frontend may not send.
{
  const before = jsonSchema({ id: { type: 'string' } });
  const after = { security: [{ bearerAuth: [] }], ...jsonSchema({ id: { type: 'string' } }) };
  expect(check(before, after, configOf({}, ['x-tenant-id'])), 'breaking', 'bearer auth added, no authorization sent');
  expect(check(before, after, configOf({}, ['authorization'])), 'ignore', 'bearer auth added, already sending it');
}

// Deprecation and narrowing only matter for headers the frontend actually sends.
{
  const header = (extra: Record<string, unknown>) => ({
    parameters: [{ name: 'X-Legacy', in: 'header', schema: { type: 'string' }, ...extra }],
    ...jsonSchema({ id: { type: 'string' } }),
  });
  expect(check(header({}), header({ deprecated: true }), configOf({ headers: ['x-legacy'] })), 'relevant', 'sent header deprecated');
  expect(check(header({}), header({ deprecated: true }), configOf({ headers: [] })), 'ignore', 'unsent header deprecated');

  const narrowed = {
    parameters: [{ name: 'X-Legacy', in: 'header', schema: { type: 'string', enum: ['a'] } }],
    ...jsonSchema({ id: { type: 'string' } }),
  };
  expect(check(header({}), narrowed, configOf({ headers: ['x-legacy'] })), 'breaking', 'sent header schema narrowed');
  expect(check(header({}), narrowed, configOf({ headers: [] })), 'ignore', 'unsent header schema narrowed');
}

// The `parameters` key appearing whole is the same event as one arriving by index — headerDrift owns
// both, so neither double-reports. A non-header member in the array keeps its own generic report.
{
  const bare = jsonSchema({ id: { type: 'string' } });
  const withHeader = { parameters: [{ name: 'X-Foo', in: 'header', schema: { type: 'string' } }], ...bare };
  const added = check(bare, withHeader, configOf({}));
  expect(added, 'ignore', 'optional header arriving with the whole parameters array');
  assert.deepEqual(added.reasons, ["optional header 'x-foo' added"], 'reported once, not once per code path');
  expect(check(withHeader, bare, configOf({})), 'ignore', 'header parameter dropped entirely');

  const mixed = { parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }], ...bare };
  expect(check(bare, mixed, configOf({})), 'relevant', 'a query param in the same slot still reports');
}

// Scoping never reaches operations the config does not consume at all.
assert.equal(
  classifyAll(
    diffSpecs(specOf(jsonSchema({ id: { type: 'string' } })), specOf(jsonSchema({}))),
    { specUrl: 'https://example.com/openapi.json', consumes: [{ method: 'POST', path: '/other' }] },
    null,
    null,
  ).length,
  0,
);

// basePath still applies with v2 fields present.
{
  const oldSpec = { paths: { '/api/v1/orders': { get: jsonSchema({ id: { type: 'string' } }) } } };
  const newSpec = { paths: { '/api/v1/orders': { get: jsonSchema({}) } } };
  const config: Config = {
    specUrl: 'https://example.com/openapi.json',
    basePath: '/api/v1',
    consumes: [{ method: 'GET', path: '/orders', responseFields: ['id'] }],
  };
  expect(classifyAll(diffSpecs(oldSpec, newSpec), config, oldSpec, newSpec)[0], 'breaking', 'basePath route matched');
}

// ---------- $ref: the whole reason check was blind to component schemas ----------
// Every fixture in this suite spells its response schema out inline, so a `$ref` — which is what
// real generated specs emit — was never exercised, and diffSpecs reported 0 changes on a retyped
// or deleted field. These build the same operations through components.schemas instead.
{
  /** GET /orders whose 200 body is `$ref: '#/components/schemas/Order'`. */
  const refSpec = (order: unknown) => ({
    paths: {
      '/orders': {
        get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } } },
      },
    },
    components: { securitySchemes: SCHEMES, schemas: { Order: order } },
  });
  const order = (properties: Record<string, unknown>) => ({ type: 'object', properties });
  const refConfig = (responseFields?: string[]): Config => ({
    specUrl: 'https://example.com/openapi.json',
    consumes: [{ method: 'GET', path: '/orders', ...(responseFields ? { responseFields } : {}) }],
  });
  const refCheck = (before: unknown, after: unknown, config: Config) => {
    const [oldSpec, newSpec] = [refSpec(before), refSpec(after)];
    const [result] = classifyAll(diffSpecs(oldSpec, newSpec), config, oldSpec, newSpec);
    return result;
  };

  assert.equal(
    diffSpecs(refSpec(order({ name: { type: 'string' } })), refSpec(order({ name: { type: 'integer' } }))).length,
    1,
    'a retype behind a $ref is a change — this reported 0 before refs were inlined',
  );

  expect(
    refCheck(order({ name: { type: 'string' } }), order({ name: { type: 'integer' } }), refConfig(['name'])),
    'breaking',
    'consumed field retyped inside components.schemas',
  );
  expect(
    refCheck(order({ name: { type: 'string' }, status: { type: 'string' } }), order({ name: { type: 'string' } }), refConfig(['name'])),
    'ignore',
    'an unread field removed behind a $ref is still filtered by consumption',
  );
  expect(
    refCheck(order({ name: { type: 'string' }, status: { type: 'string' } }), order({ name: { type: 'string' } }), refConfig(['status'])),
    'breaking',
    'the read one is not',
  );
  assert.equal(
    diffSpecs(refSpec(order({ name: { type: 'string' } })), refSpec(order({ name: { type: 'string' } }))).length,
    0,
    'an unchanged $ref stays quiet — inlining must not invent changes',
  );

  // A self-referential schema must terminate and still compare equal to itself.
  const recursive = order({ name: { type: 'string' }, parent: { $ref: '#/components/schemas/Order' } });
  assert.equal(diffSpecs(refSpec(recursive), refSpec(recursive)).length, 0, 'a cyclic schema terminates and matches');
  assert.equal(
    diffSpecs(refSpec(recursive), refSpec(order({ name: { type: 'integer' }, parent: { $ref: '#/components/schemas/Order' } }))).length,
    1,
    'and a change inside the cycle is still seen',
  );

  // A ref that cannot be followed is not evidence of anything — it must not diff as a removal.
  const dangling = { paths: { '/orders': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Gone' } } } } } } } } };
  assert.equal(diffSpecs(dangling, dangling).length, 0, 'an unresolvable $ref is left alone, not dropped');
}

console.log('ok');
