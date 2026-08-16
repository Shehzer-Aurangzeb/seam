import type { Severity } from './classify.js';
import type { Config, ConsumedRoute } from './config.js';
import { operations } from './diff.js';
import { effectiveHeaders, specHeaders } from './headers.js';
import { resolveField, successResponseSchema } from './resolve.js';
import { operationKey } from './scope.js';

/**
 * `verify` answers a different question from `check`.
 *
 * `check` is a changelog — "what did the backend change since last run?" It needs two specs, and it
 * cannot see the frontend being FIXED, because a frontend change does not touch the spec.
 *
 * `verify` is a checklist — "does what the frontend uses still exist in the spec as it stands?" One
 * spec, no snapshot, no memory of previous runs. Run it a hundred times and it answers the same, so
 * a finding disappearing means the disagreement is genuinely resolved. That is what lets an issue
 * close by itself.
 */
export type FindingCode =
  | 'no-routes-matched'
  | 'operation-missing'
  | 'response-field-missing'
  | 'required-header-not-sent'
  | 'header-deprecated';

export type Finding = {
  code: FindingCode;
  method: string;
  path: string;
  /** The field or header this is about. Empty for whole-operation findings. */
  subject: string;
  severity: Severity;
  reason: string;
  /**
   * Same disagreement -> same key, on every run and every machine. Built from the code and the
   * subject, never from the prose, so rewording a reason does not orphan an issue that quotes it.
   */
  key: string;
};

const fingerprint = (code: FindingCode, method: string, path: string, subject: string) =>
  `${code}:${method} ${path}${subject ? `:${subject}` : ''}`;

/**
 * What the frontend uses, checked against one spec. Only routes the config actually describes can
 * produce findings: a route with no `responseFields` says nothing about which fields matter, and a
 * config with no headers declared says nothing about what gets sent — in both cases silence is the
 * only honest answer, exactly as in `check`.
 */
export function verify(config: Config, spec: unknown): Finding[] {
  const specOps = new Map<string, Record<string, unknown>>();
  for (const op of operations(spec).values()) {
    specOps.set(operationKey(op.method, op.path), op.body);
  }

  const findings: Finding[] = [];
  const add = (
    code: FindingCode,
    route: Pick<ConsumedRoute, 'method' | 'path'>,
    subject: string,
    severity: Severity,
    reason: string,
  ) => {
    findings.push({
      code,
      method: route.method,
      path: route.path,
      subject,
      severity,
      reason,
      key: fingerprint(code, route.method, route.path, subject),
    });
  };

  const missing: ConsumedRoute[] = [];

  for (const route of config.consumes) {
    const op = specOps.get(operationKey(route.method, `${config.basePath ?? ''}${route.path}`));
    if (op === undefined) {
      // A path the frontend serves itself is absent from every backend spec by definition — its own
      // /api/auth/session handler is not a route this backend deleted. Measured on platform-web: 7 of
      // 12 breaking findings were exactly this. The cost is a real deletion going unreported when a
      // BFF mirrors the backend path, which is the trade the alternative could not make without
      // deleting 31 of 41 routes' coverage outright.
      if (!route.served) missing.push(route);
      continue;
    }

    // Response fields. `absent` is the only status that reports — `unprovable` means the schema could
    // not rule the field out, and guessing there would fabricate a breaking change.
    if (route.responseFields?.length) {
      const schema = successResponseSchema(op, spec);
      // No declared success body at all: nothing to resolve against, so nothing is provable.
      if (schema !== undefined) {
        for (const field of route.responseFields) {
          if (resolveField(schema, field, spec).status === 'absent') {
            add('response-field-missing', route, field, 'breaking', `reads '${field}', which the response no longer declares`);
          }
        }
      }
    }

    // ponytail: `requestFields` is deliberately NOT checked here, and the obvious check — "the spec
    // requires a body field the config does not list" — must not be added. `requestFields` records
    // what could be SEEN in the code, so a field's absence is not evidence the frontend omits it.
    // Measured against the live specs with a freshly generated config: 8 of 12 platform routes and
    // 1 of 3 idp routes would have produced a finding, including POST /users/query "missing"
    // sortColumn and sortDirection, which it plainly sends. The rule this follows is the one
    // `resolveField` already encodes — accuse only from what is DEMONSTRABLE. So request fields may
    // silence a change in `check` and may never raise a finding here. Revisit only if the config ever
    // records request bodies exhaustively rather than observationally.

    // Headers. Undefined means the config never recorded what this route sends, so "we don't send it"
    // is not something we know.
    const sent = effectiveHeaders(config, route);
    if (!sent) continue;

    for (const [name, header] of specHeaders(op, spec)) {
      // ponytail: declared `in: header` parameters only. A security scheme requiring `authorization`
      // applies to the whole API, not to one route — reporting it per route would put the same
      // finding on all 33 routes of a secured backend, and `check` already flags a newly-required
      // header from any source. Widen this if a spec ever secures individual routes differently.
      if (header.source !== 'parameter') continue;

      if (header.required && !sent.includes(name)) {
        add('required-header-not-sent', route, name, 'breaking', `requires header '${name}', which the frontend does not send`);
      }
      if (header.deprecated && sent.includes(name)) {
        add('header-deprecated', route, name, 'relevant', `header '${name}' is sent but deprecated in the spec`);
      }
    }
  }

  // ponytail: every route missing is a wrong basePath or specUrl far more often than a backend that
  // deleted its whole API, and N breaking findings would bury that. One finding names the real cause.
  if (missing.length > 0 && missing.length === config.consumes.length) {
    const { method, path } = missing[0];
    return [
      {
        code: 'no-routes-matched',
        method,
        path,
        subject: '',
        severity: 'breaking',
        reason:
          `none of the ${missing.length} consumed route(s) exist in this spec — ` +
          `check specUrl and basePath${config.basePath ? ` (currently '${config.basePath}')` : ' (currently unset)'}`,
        key: fingerprint('no-routes-matched', method, path, ''),
      },
    ];
  }

  for (const route of missing) {
    add('operation-missing', route, '', 'breaking', 'is called by the frontend but not declared in the spec');
  }

  return findings.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.key.localeCompare(b.key));
}
