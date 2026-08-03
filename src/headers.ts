import type { Config, ConsumedRoute } from './config.js';
import { readPath } from './util/path.js';

/** Where the spec says this header comes from — only declared parameters are worth reporting as new. */
export type HeaderSource = 'parameter' | 'security' | 'implicit';

export type SpecHeader = {
  /** Always lowercase. HTTP header names are case-insensitive; comparing them any other way invents drift. */
  name: string;
  required: boolean;
  deprecated: boolean;
  schema: unknown;
  source: HeaderSource;
};

/**
 * The headers this route actually sends: the shared client's plus its own, lowercased and deduped.
 * `undefined` means the config declared neither — a v1 config, where every header counts as sent.
 */
export function effectiveHeaders(
  config: Pick<Config, 'globalHeaders'>,
  route?: Pick<ConsumedRoute, 'headers'>,
): string[] | undefined {
  if (!config.globalHeaders && !route?.headers) return undefined;
  // Lowercase BEFORE deduping — otherwise `Authorization` and `authorization` both survive as members.
  return [...new Set([...(config.globalHeaders ?? []), ...(route?.headers ?? [])].map((h) => h.toLowerCase()))];
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Every header the spec implies for one operation, keyed lowercase:
 * declared `in: header` parameters, whatever its security schemes put on the wire, and the two
 * HTTP always-ons. First writer wins, so an explicit parameter keeps its own schema and flags.
 */
export function specHeaders(op: unknown, spec: unknown): Map<string, SpecHeader> {
  const found = new Map<string, SpecHeader>();
  const add = (name: unknown, header: Omit<SpecHeader, 'name'>) => {
    if (typeof name !== 'string' || name.trim() === '') return;
    const key = name.trim().toLowerCase();
    if (!found.has(key)) found.set(key, { name: key, ...header });
  };

  for (const raw of asArray(readPath(op, ['parameters']))) {
    const parameter = asObject(raw);
    if (parameter.in !== 'header') continue;
    add(parameter.name, {
      required: parameter.required === true,
      deprecated: parameter.deprecated === true,
      schema: parameter.schema,
      source: 'parameter',
    });
  }

  // An operation's own `security` overrides the document's — including `security: []` for "no auth here".
  const security = readPath(op, ['security']) ?? readPath(spec, ['security']);
  const schemes = asObject(readPath(spec, ['components', 'securitySchemes']));
  for (const requirement of asArray(security)) {
    for (const name of Object.keys(asObject(requirement))) {
      const scheme = asObject(schemes[name]);
      // Bearer/basic/oauth2/OIDC all ride on Authorization; an apiKey scheme names its own header.
      const header =
        scheme.type === 'apiKey' && scheme.in === 'header'
          ? scheme.name
          : scheme.type === 'http' || scheme.type === 'oauth2' || scheme.type === 'openIdConnect'
            ? 'authorization'
            : undefined;
      add(header, { required: true, deprecated: false, schema: undefined, source: 'security' });
    }
  }

  const implicit = { required: false, deprecated: false, schema: undefined, source: 'implicit' } as const;
  if (readPath(op, ['requestBody']) !== undefined) add('content-type', implicit);
  if (readPath(op, ['responses']) !== undefined) add('accept', implicit);

  return found;
}

const show = (value: unknown) => JSON.stringify(value) ?? String(value);

/**
 * A header the frontend already sends breaks when the shape the backend accepts NARROWS.
 * Widening (an enum constraint dropped, a pattern removed) is not drift the caller has to act on.
 */
export function breakingHeaderSchema(before: unknown, after: unknown): string | null {
  const a = asObject(before);
  const b = asObject(after);

  if (a.type !== b.type) return `type ${show(a.type)}→${show(b.type)}`;
  if (a.format !== b.format) return `format ${show(a.format)}→${show(b.format)}`;
  if (a.pattern !== b.pattern && b.pattern !== undefined) return `pattern is now ${show(b.pattern)}`;

  const afterEnum = b.enum === undefined ? null : asArray(b.enum);
  if (afterEnum) {
    if (a.enum === undefined) return `now restricted to ${show(afterEnum)}`;
    const dropped = asArray(a.enum).filter((value) => !afterEnum.includes(value));
    if (dropped.length > 0) return `dropped accepted value(s) ${dropped.map(show).join(', ')}`;
  }

  return null;
}
