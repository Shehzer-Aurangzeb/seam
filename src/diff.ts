import diff, { type Difference } from 'microdiff';

// ponytail: the five methods driftcheck's config can name. Add head/options/trace here
// and to the config enum together if a spec ever needs them.
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export type OperationChange = {
  path: string;
  method: string;
  kind: 'added' | 'removed' | 'modified';
  rawChanges: Difference[];
  /** The operation objects this change came from — the normalizer needs them for set-valued arrays. */
  oldOp: unknown;
  newOp: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type Operation = { path: string; method: string; body: Record<string, unknown> };

/** Flattens a spec into `"GET /foo" -> operation object`, ignoring non-method keys. */
export function operations(spec: unknown): Map<string, Operation> {
  const paths = isObject(spec) && isObject(spec.paths) ? spec.paths : {};
  const ops = new Map<string, Operation>();
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) continue;
    for (const method of METHODS) {
      const body = pathItem[method];
      if (isObject(body)) ops.set(`${method.toUpperCase()} ${path}`, { path, method: method.toUpperCase(), body });
    }
  }
  return ops;
}

export function diffSpecs(oldSpec: unknown, newSpec: unknown): OperationChange[] {
  const before = operations(oldSpec);
  const after = operations(newSpec);
  const changes: OperationChange[] = [];

  for (const [key, { path, method, body }] of after) {
    const old = before.get(key);
    if (!old) {
      changes.push({ path, method, kind: 'added', rawChanges: [], oldOp: undefined, newOp: body });
      continue;
    }
    const rawChanges = diff(old.body, body);
    if (rawChanges.length > 0) {
      changes.push({ path, method, kind: 'modified', rawChanges, oldOp: old.body, newOp: body });
    }
  }

  for (const [key, { path, method, body }] of before) {
    if (!after.has(key)) {
      changes.push({ path, method, kind: 'removed', rawChanges: [], oldOp: body, newOp: undefined });
    }
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
