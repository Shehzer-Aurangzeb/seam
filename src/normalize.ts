import type { Difference } from 'microdiff';
import { readPath } from './util/path.js';

// OpenAPI stores these as arrays but means them as SETS, so microdiff reports a positional
// CREATE/REMOVE/CHANGE per index when the members were merely reordered.
//
// Approach: reconstructing set membership from the individual microdiff entries is fragile
// (a reorder can surface as CHANGE at two indices, or CREATE+REMOVE at different depths), so
// instead we DROP every positional entry that targets one of these arrays and re-derive the net
// membership straight from the old/new operation objects. Reorder-only edits therefore produce
// nothing at all. Synthetic entries carry the parent array as their path and the member as the
// value, so no index ever reaches the classifier.
const SET_FIELDS = new Set(['required', 'enum', 'tags']);

function isSetMemberPath(path: (string | number)[]): boolean {
  const last = path[path.length - 1];
  const parent = path[path.length - 2];
  return typeof last === 'number' && typeof parent === 'string' && SET_FIELDS.has(parent);
}

/** Keyed by JSON so numeric enum members compare correctly and the original value survives. */
function members(value: unknown): Map<string, unknown> {
  const array = Array.isArray(value) ? value : [];
  return new Map(array.map((member) => [JSON.stringify(member), member]));
}

/**
 * A media type is the segment directly under `content`. The `/` is what keeps a response field that
 * happens to be called `content` from having its own children blinded.
 */
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

const mediaBlind = (path: (string | number)[]): (string | number)[] =>
  path.map((segment, i) =>
    path[i - 1] === 'content' && typeof segment === 'string' && MEDIA_TYPE.test(segment) ? '*' : segment,
  );

/** Same edit, same place, same values — differing only in which media type declared the schema. */
const mediaKey = (change: Difference) =>
  JSON.stringify([
    change.type,
    mediaBlind(change.path),
    'value' in change ? change.value : null,
    'oldValue' in change ? change.oldValue : null,
  ]);

/**
 * One schema served under several media types is ONE contract change, but it lives in the document
 * once per type, so microdiff reports it once per type — Petstore's json+xml pet gave two entries and
 * two identical reasons for every single edit. Dropping the repeats here rather than in `classify`
 * keeps `reasons[i]` paired with `rawChanges[i]`, which the report relies on.
 *
 * Only exact repeats collapse. Where json and xml genuinely describe different shapes, the changes
 * differ in path or value and both survive.
 */
function dedupeMediaTypes(changes: Difference[]): Difference[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = mediaKey(change);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeRawChanges(
  rawChanges: Difference[],
  oldOp: unknown,
  newOp: unknown,
): Difference[] {
  const kept = rawChanges.filter((change) => !isSetMemberPath(change.path));

  const setArrays = new Map<string, (string | number)[]>();
  for (const change of rawChanges) {
    if (!isSetMemberPath(change.path)) continue;
    const parent = change.path.slice(0, -1);
    setArrays.set(JSON.stringify(parent), parent);
  }

  const synthetic: Difference[] = [];
  for (const parent of setArrays.values()) {
    const before = members(readPath(oldOp, parent));
    const after = members(readPath(newOp, parent));
    for (const [key, value] of after) {
      if (!before.has(key)) synthetic.push({ type: 'CREATE', path: parent, value });
    }
    for (const [key, oldValue] of before) {
      if (!after.has(key)) synthetic.push({ type: 'REMOVE', path: parent, oldValue });
    }
  }

  // After the set re-derivation, so a `required` array declared under two media types collapses too.
  return dedupeMediaTypes([...kept, ...synthetic]);
}
