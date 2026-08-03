import { readPath } from './util/path.js';

/**
 * Resolving a consumed field path against ONE spec, for `verify`. `check` never needed this: microdiff
 * compares two raw documents, so a `$ref` on both sides diffs as a `$ref`. Asking "is `customer.email`
 * still in this response?" means actually following the pointer into `components`.
 *
 * `unprovable` is the load-bearing state. A finding must only ever be raised when the field is
 * DEMONSTRABLY gone — a schema we cannot read is not evidence of removal, and reporting one as
 * breaking would train the team to ignore the tool.
 */
export type FieldStatus = 'present' | 'absent' | 'unprovable';

export type FieldResult = { status: FieldStatus; schema?: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** JSON Pointer escapes: `~1` is a literal `/`, `~0` a literal `~`. Order matters — `~01` is `~1`. */
const unescapePointer = (segment: string) => segment.replace(/~1/g, '/').replace(/~0/g, '~');

// ponytail: local `#/...` pointers only. Remote and file refs resolve to undefined -> `unprovable`,
// which is silent rather than wrong. Add a fetching resolver if a real spec ever needs one.
const MAX_HOPS = 32;

/**
 * Follows a `$ref` chain to the node it names, and returns undefined for anything it cannot follow.
 *
 * The visited set is per-call, and deliberately so: it guards against pure alias loops
 * (`#/a -> #/b -> #/a`, which never terminate) without touching the legitimate case of a path
 * revisiting a schema. `Order.parent` IS an `Order`, and asking for `.total` on it is one honest hop —
 * a shared set across the walk would read that as a cycle. The field path is finite, so each segment
 * consumes exactly one hop and the walk always terminates.
 */
function deref(node: unknown, spec: unknown): unknown {
  const seen = new Set<string>();
  let current = node;
  for (let hops = 0; isObject(current) && typeof current.$ref === 'string'; hops++) {
    const ref = current.$ref;
    if (!ref.startsWith('#/') || seen.has(ref) || hops >= MAX_HOPS) return undefined;
    seen.add(ref);
    current = readPath(spec, ref.slice(2).split('/').map(unescapePointer));
  }
  return current;
}

/** Types that cannot hold members, so a field path descending into one is demonstrably gone. */
const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** `allOf` members, and `oneOf`/`anyOf` alternatives — a field declared in any branch exists. */
const branchesOf = (schema: Record<string, unknown>): unknown[] => [
  ...asArray(schema.allOf),
  ...asArray(schema.oneOf),
  ...asArray(schema.anyOf),
];

/**
 * One hop: the schema for `name` inside `schema`.
 *
 * Arrays are transparent. `items[].sku` and `items.sku` name the same field — array-ness is not part
 * of a field's identity anywhere else in this codebase, so `[]` in a config is decoration and a hop
 * descends through `items` whether or not it was written.
 */
function step(schema: unknown, name: string, spec: unknown): FieldResult {
  // A schema we could not follow — or one that is not an object at all — is not proof of anything.
  const resolved = deref(schema, spec);
  if (!isObject(resolved)) return { status: 'unprovable' };
  let node: Record<string, unknown> = resolved;

  for (let depth = 0; node.items !== undefined || node.type === 'array'; depth++) {
    if (depth >= MAX_HOPS) return { status: 'unprovable' };
    // `type: array` with no `items` says nothing about its members.
    if (node.items === undefined) return { status: 'unprovable' };
    const inner = deref(node.items, spec);
    if (!isObject(inner)) return { status: 'unprovable' };
    node = inner;
  }

  const properties = node.properties;
  if (isObject(properties) && name in properties) {
    return { status: 'present', schema: properties[name] };
  }

  // Composition: present in ANY branch wins. Unprovable beats absent, since one unreadable branch
  // could have declared the field.
  const branches = branchesOf(node);
  if (branches.length > 0) {
    let sawUnprovable = false;
    for (const branch of branches) {
      const result = step(branch, name, spec);
      if (result.status === 'present') return result;
      if (result.status === 'unprovable') sawUnprovable = true;
    }
    if (sawUnprovable) return { status: 'unprovable' };
    // Every branch ruled the field out. When the node declares nothing of its own, the composition
    // IS the whole shape, so that verdict stands — an `allOf` wrapper is not a free-form object.
    // (Generated specs compose DTO inheritance this way, so treating it as free-form would make
    // every inherited schema unverifiable.) A node with its own `properties` falls through instead,
    // so its `additionalProperties` still gets the last word.
    if (properties === undefined) return { status: 'absent' };
  }

  // An object that spells out its `properties` proves absence, INCLUDING when it says nothing about
  // `additionalProperties`. Strict JSON Schema would default that to true, but an OpenAPI response is
  // a descriptive contract, not a validator: generated specs almost never emit
  // `additionalProperties: false` (0 of 6 schemas in the Swagger Petstore do), so demanding it would
  // make verify silent on essentially every real spec. Only an EXPLICIT `true` or a schema — a
  // deliberate map or free-form object — can still hide the field.
  if (properties === undefined) {
    // A declared scalar holds no members at all, so absence IS provable here. This is the rule that
    // catches a field demoted from an object to an id string: `customer.email` where customer is now
    // `{type: 'string'}`.
    // ponytail: OpenAPI 3.1 union types (`type: ['string','null']`) fall through to unprovable —
    // silent, not wrong. Widen to arrays of scalars if a 3.1 spec ever needs it.
    return typeof node.type === 'string' && SCALARS.has(node.type)
      ? { status: 'absent' }
      : { status: 'unprovable' };
  }
  if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
    return { status: 'unprovable' };
  }

  return { status: 'absent' };
}

/**
 * Walks a config field path (`customer.email`, `items[].sku`) into a schema.
 * A path is present only if every hop is.
 */
export function resolveField(schema: unknown, field: string, spec: unknown): FieldResult {
  const segments = field
    .replace(/\[\]/g, '')
    .split('.')
    .filter((s) => s !== '');
  if (segments.length === 0) return { status: 'unprovable' };

  let current: FieldResult = { status: 'present', schema };
  for (const name of segments) {
    current = step(current.schema, name, spec);
    if (current.status !== 'present') return current;
  }
  return current;
}

/**
 * The response body an operation returns on success. Prefers `application/json`, then any other
 * media type, over the lowest 2xx status — `default` is a catch-all that usually describes errors,
 * so it is only used when nothing else is declared.
 */
export function successResponseSchema(op: unknown, spec: unknown): unknown {
  const responses = readPath(op, ['responses']);
  if (!isObject(responses)) return undefined;

  const codes = Object.keys(responses)
    .filter((code) => /^2\d\d$/.test(code))
    .sort();
  const chosen = codes.length > 0 ? codes : Object.keys(responses).filter((c) => c === 'default');

  for (const code of chosen) {
    // A response object can itself be a `$ref` into `components.responses`.
    const content = readPath(deref(responses[code], spec), ['content']);
    if (!isObject(content)) continue;
    const media = content['application/json'] ?? Object.values(content)[0];
    const schema = readPath(media, ['schema']);
    if (schema !== undefined) return schema;
  }
  return undefined;
}
