import type { Difference } from 'microdiff';
import type { Config } from './config.js';
import type { OperationChange } from './diff.js';
import { breakingHeaderSchema, effectiveHeaders, specHeaders } from './headers.js';
import { normalizeRawChanges } from './normalize.js';
import { changeKey, consumedIndex } from './scope.js';
import { describePath, fieldPath, regionOf, regionWord } from './util/describe.js';
import { readPath } from './util/path.js';

export type Severity = 'breaking' | 'relevant' | 'ignore';

export type ClassifiedChange = {
  path: string;
  method: string;
  kind: 'added' | 'removed' | 'modified';
  severity: Severity;
  reasons: string[];
  rawChanges: Difference[];
  /** Carried through so the report can resolve names for anything phrased after the fact. */
  oldOp: unknown;
  newOp: unknown;
};

/**
 * What the frontend actually uses on this route. Both lists are `undefined` for a v1 config, and
 * `undefined` always means "we never looked" — so v1 keeps flagging everything.
 */
export type ClassifyContext = {
  /** Lowercase headers the frontend sends. Undefined = every header counts as sent. */
  headers?: string[];
  /** Response paths the frontend reads. Undefined = every field counts as read. */
  responseFields?: string[];
  /** Needed only to resolve `components.securitySchemes` into header names. */
  oldSpec?: unknown;
  newSpec?: unknown;
};

export const RANK: Record<Severity, number> = { ignore: 0, relevant: 1, breaking: 2 };

const TEXT_FIELDS = new Set(['description', 'summary', 'example', 'examples']);

type Verdict = { severity: Severity; reason: string };

const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/** Is `field` listed in the `required` array beside this schema's `properties`? */
function isRequiredInNew(field: string, schemaPath: (string | number)[], newOp: unknown): boolean {
  const required = readPath(newOp, [...schemaPath, 'required']);
  return Array.isArray(required) && required.includes(field);
}

/** A field absent from the old properties is newly added, so its required-membership is the same event. */
function existedInOld(field: string, schemaPath: (string | number)[], oldOp: unknown): boolean {
  const properties = readPath(oldOp, [...schemaPath, 'properties']);
  return typeof properties === 'object' && properties !== null && field in properties;
}

/**
 * Header parameters are handled as a SET by `headerDrift`, never positionally: microdiff indexes
 * `parameters` by position, so one insertion rewrites every entry after it. Either side saying
 * `in: header` at this index is enough to hand the change over.
 */
function isHeaderParameter(path: (string | number)[], oldOp: unknown, newOp: unknown): boolean {
  if (path[0] !== 'parameters') return false;
  if (typeof path[1] === 'number') {
    const at = ['parameters', path[1], 'in'];
    return readPath(newOp, at) === 'header' || readPath(oldOp, at) === 'header';
  }
  // The `parameters` key itself appeared or vanished, so the whole array is one entry. Hand it over
  // only when every member is a header — otherwise a query param in the same array loses its report.
  if (path.length !== 1) return false;
  const list = readPath(newOp, ['parameters']) ?? readPath(oldOp, ['parameters']);
  return Array.isArray(list) && list.length > 0 && list.every((p) => (p as { in?: unknown } | null)?.in === 'header');
}

/** The response path this change lands on, in config notation, or null if it is not field-level. */
function targetField(change: Difference): string | null {
  const last = change.path[change.path.length - 1];
  const member = 'value' in change ? change.value : 'oldValue' in change ? change.oldValue : undefined;
  // Synthetic set-membership entries name the field in the VALUE — the path stops at the schema.
  if (last === 'required' && typeof member === 'string') {
    const parent = fieldPath(change.path.slice(0, -1));
    return parent ? `${parent}.${member}` : member;
  }
  return fieldPath(change.path);
}

/** `items[].sku` and `items.sku` are the same path — array-ness never decides consumption. */
const bare = (field: string) => field.replace(/\[\]/g, '');

/**
 * A change counts as consumed if it touches a configured field, its ancestor, or its descendant:
 * dropping `user` breaks `user.email`, and retyping `user.email` breaks anyone reading `user`.
 */
function isConsumedField(change: Difference, responseFields: string[]): boolean {
  const target = targetField(change);
  if (target === null) return true; // Not a field — a whole response, a status code. Judge it normally.
  const changed = bare(target);
  return responseFields.some((field) => {
    const consumed = bare(field);
    return consumed === changed || consumed.startsWith(`${changed}.`) || changed.startsWith(`${consumed}.`);
  });
}

function classifyOne(
  change: Difference,
  oldOp: unknown,
  newOp: unknown,
  ctx: ClassifyContext,
): Verdict | null {
  const last = change.path[change.path.length - 1];
  const inResponse = change.path.includes('responses');
  const value = 'value' in change ? change.value : undefined;
  const oldValue = 'oldValue' in change ? change.oldValue : undefined;
  // Single phrasing path: every reason names its region and a human field/param name.
  const what = describePath(change.path, oldOp, newOp);
  const region = regionWord(regionOf(change.path));

  // headerDrift owns every header verdict, so positional parameter noise never reaches the report.
  if (isHeaderParameter(change.path, oldOp, newOp)) return null;

  // A scheme added or dropped is a header event — headerDrift resolves it against components.
  // ponytail: only the requirement itself. Deeper paths are oauth scopes, still judged the v1 way,
  // because no config field says which scopes the frontend's token carries.
  if (change.path[0] === 'security' && change.path.length <= 2) return null;

  // v2: the config names the response paths the frontend reads, so drift anywhere else is noise.
  // An EMPTY list is not "reads nothing" — it is "nobody looked", and it must not silence the
  // whole response. Models write `[]` where they mean to omit the key, and a config that quietly
  // stops reporting is worse than one that over-reports.
  if (inResponse && ctx.responseFields?.length && !isConsumedField(change, ctx.responseFields)) {
    return { severity: 'ignore', reason: `${what} is not read by the frontend` };
  }

  if (typeof last === 'string' && TEXT_FIELDS.has(last)) {
    const target = change.path.length > 1 ? ` on ${describePath(change.path.slice(0, -1), oldOp, newOp)}` : '';
    return { severity: 'ignore', reason: `${last} text changed${target}` };
  }

  // `required: true` on a single parameter — distinct from membership in a `required` array.
  if (last === 'required' && typeof (value ?? oldValue) === 'boolean') {
    const subject = describePath(change.path.slice(0, -1), oldOp, newOp);
    return value === true
      ? { severity: 'breaking', reason: `${subject} became required` }
      : { severity: 'relevant', reason: `${subject} is no longer required` };
  }

  // Synthetic set-membership entries from the normalizer — the member name is the value, not the path.
  if (last === 'required') {
    if (change.type === 'CREATE') {
      if (inResponse) {
        return { severity: 'relevant', reason: `${region} '${show(value)}' is now always present` };
      }
      // The field arrived required in one go — the property CREATE reports it, so don't double up.
      if (!existedInOld(String(value), change.path.slice(0, -1), oldOp)) return null;
      return { severity: 'breaking', reason: `${region} '${show(value)}' became required` };
    }
    return inResponse
      ? { severity: 'breaking', reason: `${region} '${show(oldValue)}' is no longer guaranteed` }
      : { severity: 'relevant', reason: `${region} '${show(oldValue)}' is no longer required` };
  }

  if (last === 'enum') {
    return change.type === 'CREATE'
      ? { severity: 'relevant', reason: `${what} added enum value '${show(value)}'` }
      : { severity: 'breaking', reason: `${what} dropped enum value '${show(oldValue)}'` };
  }

  if (last === 'type' && change.type === 'CHANGE') {
    return { severity: 'breaking', reason: `${what} type changed ${show(oldValue)}→${show(value)}` };
  }

  if (change.type === 'REMOVE' && inResponse) {
    return { severity: 'breaking', reason: `${what} removed` };
  }

  if (change.type === 'CREATE') {
    const isProperty = change.path[change.path.length - 2] === 'properties';
    if (isProperty && !inResponse && isRequiredInNew(String(last), change.path.slice(0, -2), newOp)) {
      return { severity: 'breaking', reason: `required ${what} added` };
    }
    return { severity: 'relevant', reason: `optional ${what} added` };
  }

  return { severity: 'relevant', reason: `unclassified change at ${what} — review manually` };
}

/**
 * Headers are judged as a set — declared parameters, security schemes and the HTTP always-ons all
 * end up as one map per side, so it does not matter how the spec chose to express them.
 *
 * `ctx.headers === undefined` is a v1 config: every header reads as sent, but a newly required one
 * is still breaking, because v1 has no evidence the frontend sends it.
 */
function headerDrift(oldOp: unknown, newOp: unknown, ctx: ClassifyContext): Verdict[] {
  const declared = ctx.headers;
  const before = specHeaders(oldOp, ctx.oldSpec);
  const after = specHeaders(newOp, ctx.newSpec);
  const isSent = (name: string) => declared === undefined || declared.includes(name);
  const verdicts: Verdict[] = [];

  for (const [name, header] of after) {
    const previous = before.get(name);

    if (header.required && !previous?.required) {
      verdicts.push(
        declared !== undefined && isSent(name)
          ? { severity: 'ignore', reason: `header '${name}' became required and the frontend already sends it` }
          : {
              severity: 'breaking',
              reason: `header '${name}' became required${declared ? ' and the frontend does not send it' : ''}`,
            },
      );
    } else if (!previous && header.source === 'parameter') {
      verdicts.push({ severity: 'ignore', reason: `optional header '${name}' added` });
    }

    if (header.deprecated && !previous?.deprecated) {
      verdicts.push({
        severity: isSent(name) ? 'relevant' : 'ignore',
        reason: `header '${name}' is deprecated`,
      });
    }

    if (previous?.required && !header.required) {
      verdicts.push({
        severity: isSent(name) ? 'relevant' : 'ignore',
        reason: `header '${name}' is no longer required`,
      });
    }

    const narrowed = previous && breakingHeaderSchema(previous.schema, header.schema);
    if (narrowed) {
      verdicts.push({
        severity: isSent(name) ? 'breaking' : 'ignore',
        reason: `header '${name}' ${narrowed}`,
      });
    }
  }

  return verdicts;
}

export function classify(
  change: OperationChange,
  normalized: Difference[],
  ctx: ClassifyContext = {},
): ClassifiedChange {
  const { path, method, kind, oldOp, newOp } = change;
  const base = { path, method, kind, oldOp, newOp };

  if (kind === 'removed') {
    return { ...base, kind, severity: 'breaking', reasons: ['operation removed'], rawChanges: [] };
  }
  if (kind === 'added') {
    return { ...base, kind, severity: 'relevant', reasons: ['operation newly present'], rawChanges: [] };
  }

  // Suppressed changes drop their raw entry too, so reasons[i] stays paired with rawChanges[i].
  const verdicts: Verdict[] = [];
  const reported: Difference[] = [];
  for (const raw of normalized) {
    const verdict = classifyOne(raw, change.oldOp, change.newOp, ctx);
    if (verdict === null) continue;
    verdicts.push(verdict);
    reported.push(raw);
  }

  // Appended last on purpose: header verdicts have no single raw entry behind them, and the report
  // pairs by index, so they must sit past the end of `reported` rather than shift it.
  verdicts.push(...headerDrift(oldOp, newOp, ctx));

  if (verdicts.length === 0) {
    return { ...base, kind, severity: 'ignore', reasons: ['nothing the frontend uses changed'], rawChanges: [] };
  }

  const severity = verdicts.reduce<Severity>(
    (worst, v) => (RANK[v.severity] > RANK[worst] ? v.severity : worst),
    'ignore',
  );
  return { ...base, kind, severity, reasons: verdicts.map((v) => v.reason), rawChanges: reported };
}

/** The whole deterministic pass: keep consumed operations, normalize, judge against what the config says we use. */
export function classifyAll(
  changes: OperationChange[],
  config: Config,
  oldSpec: unknown,
  newSpec: unknown,
): ClassifiedChange[] {
  const routes = consumedIndex(config.consumes, config.basePath);
  const classified: ClassifiedChange[] = [];

  for (const change of changes) {
    const route = routes.get(changeKey(change));
    if (!route) continue;
    const normalized = normalizeRawChanges(change.rawChanges, change.oldOp, change.newOp);
    // Normalization erased everything — this operation was only reordered, so it never happened.
    if (change.kind === 'modified' && normalized.length === 0) continue;
    classified.push(
      classify(change, normalized, {
        headers: effectiveHeaders(config, route),
        responseFields: route.responseFields,
        oldSpec,
        newSpec,
      }),
    );
  }

  return classified;
}
