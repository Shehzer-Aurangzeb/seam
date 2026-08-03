// Run: node --import tsx src/resolve.test.ts
import assert from 'node:assert/strict';
import { resolveField, successResponseSchema } from './resolve.js';

const spec = {
  components: {
    schemas: {
      Order: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          customer: { $ref: '#/components/schemas/Person' },
          items: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
          parent: { $ref: '#/components/schemas/Order' },
        },
        additionalProperties: false,
      },
      Person: {
        type: 'object',
        properties: { email: { type: 'string' }, name: { type: 'string' } },
        additionalProperties: false,
      },
      Item: {
        allOf: [
          { type: 'object', properties: { sku: { type: 'string' } }, additionalProperties: false },
          { type: 'object', properties: { qty: { type: 'integer' } }, additionalProperties: false },
        ],
      },
      Loose: { type: 'object' },
      Map: { type: 'object', properties: {}, additionalProperties: { type: 'string' } },
      Cycle: {
        type: 'object',
        properties: { next: { $ref: '#/components/schemas/Cycle' } },
        additionalProperties: false,
      },
    },
  },
};

const order = { $ref: '#/components/schemas/Order' };
const status = (field: string, schema: unknown = order) => resolveField(schema, field, spec).status;

// Present: through a $ref, nested, and through an array
assert.equal(status('total'), 'present');
assert.equal(status('customer.email'), 'present', 'follows a $ref into components');
assert.equal(status('items[].sku'), 'present', 'descends array items and an allOf branch');
assert.equal(status('items[].qty'), 'present', 'second allOf branch counts too');
// [] is decoration — array-ness is not part of a field's identity anywhere in this codebase.
assert.equal(status('items.sku'), 'present', 'the same field written without []');

// Absent: only when the schema spells out its properties AND forbids extras
assert.equal(status('missing'), 'absent');
assert.equal(status('customer.phone'), 'absent');
assert.equal(status('items[].warehouseCode'), 'absent');
assert.equal(status('total.deeper'), 'absent', 'a scalar has no members');

// Unprovable beats absent everywhere the schema cannot rule the field out. Each of these reported as
// `absent` would be a fabricated breaking change.
assert.equal(status('anything', { $ref: '#/components/schemas/Loose' }), 'unprovable', 'free-form object');
assert.equal(status('anyKey', { $ref: '#/components/schemas/Map' }), 'unprovable', 'additionalProperties map');
assert.equal(status('x', { $ref: '#/components/schemas/Nope' }), 'unprovable', 'dangling internal $ref');
assert.equal(status('x', { $ref: 'https://other.test/spec.json#/X' }), 'unprovable', 'remote $ref not followed');
assert.equal(status('x', { type: 'array' }), 'unprovable', 'array with no items declared');
assert.equal(status('x', {}), 'unprovable', 'schema with no properties key');
assert.equal(status('', order), 'unprovable', 'empty path');
{
  // One unreadable branch means the field might be declared there.
  const partly = { allOf: [{ type: 'object', properties: {}, additionalProperties: false }, { $ref: '#/nope' }] };
  assert.equal(resolveField(partly, 'x', spec).status, 'unprovable', 'unprovable branch wins over absent');
}

// A self-referential schema is not a cycle when the path keeps consuming segments — a linked list
// genuinely has `next.next.next`, and `Order.parent` genuinely is an `Order`.
assert.equal(status('parent.total'), 'present', 'one hop through a self-reference resolves');
assert.equal(status('parent.parent.customer.email'), 'present', 'and so does the hop after that');
assert.equal(status('next.next.next', { $ref: '#/components/schemas/Cycle' }), 'present', 'linked list');
assert.equal(status('next.next.gone', { $ref: '#/components/schemas/Cycle' }), 'absent', 'still provable');

// A pure alias loop consumes no segments and never terminates — that is the case the guard is for.
{
  const looped = {
    components: { schemas: { A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' } } },
  };
  assert.equal(
    resolveField({ $ref: '#/components/schemas/A' }, 'x', looped).status,
    'unprovable',
    'alias loop must terminate, and silence is the safe answer',
  );
}

// The resolved schema comes back, so a caller can inspect the type.
assert.deepEqual(resolveField(order, 'total', spec).schema, { type: 'number' });
assert.deepEqual(resolveField(order, 'customer.email', spec).schema, { type: 'string' });

// successResponseSchema: lowest 2xx, application/json preferred
{
  const pick = (op: unknown) => successResponseSchema(op, spec);

  assert.deepEqual(
    pick({ responses: { '200': { content: { 'application/json': { schema: order } } } } }),
    order,
  );
  assert.deepEqual(
    pick({
      responses: {
        '404': { content: { 'application/json': { schema: { type: 'string' } } } },
        '201': { content: { 'application/json': { schema: order } } },
      },
    }),
    order,
    'only 2xx counts',
  );
  assert.deepEqual(
    pick({ responses: { '204': {}, '200': { content: { 'application/json': { schema: order } } } } }),
    order,
    'a 204 carries no body, so the 200 is the answer',
  );
  assert.deepEqual(
    pick({ responses: { '200': { content: { 'application/xml': { schema: order } } } } }),
    order,
    'falls back to whatever media type is declared',
  );
  assert.deepEqual(
    pick({ responses: { default: { content: { 'application/json': { schema: order } } } } }),
    order,
    'default is used only when no 2xx exists',
  );
  // A response object behind a $ref still resolves.
  const withRef = {
    responses: { '200': { $ref: '#/components/responses/Ok' } },
  };
  const specWithResponse = {
    ...spec,
    components: { ...spec.components, responses: { Ok: { content: { 'application/json': { schema: order } } } } },
  };
  assert.deepEqual(successResponseSchema(withRef, specWithResponse), order, 'response-level $ref');

  assert.equal(pick({}), undefined);
  assert.equal(pick({ responses: { '204': {} } }), undefined, 'no body anywhere');
}

console.log('ok');
