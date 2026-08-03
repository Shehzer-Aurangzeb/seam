import { readPath } from './path.js';

export type Region = 'parameter' | 'request' | 'response' | 'unknown';

export function regionOf(path: (string | number)[]): Region {
  if (path[0] === 'parameters') return 'parameter';
  if (path.includes('requestBody')) return 'request';
  if (path.includes('responses')) return 'response';
  return 'unknown';
}

/** The noun for a region — always states send-side vs receive-side. */
export function regionWord(region: Region): string {
  if (region === 'parameter') return 'parameter';
  if (region === 'request') return 'request field';
  if (region === 'response') return 'response field';
  return 'field';
}

/**
 * Field names are the segments sitting directly under a `properties` object, dotted for nesting.
 * An `items` hop marks its parent as an array, so a structural path lands on exactly the notation
 * configs use: `profile.firstName`, `items[].sku`.
 */
export function fieldPath(path: (string | number)[]): string | null {
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    if (segment === 'properties' && typeof path[i + 1] === 'string') {
      parts.push(String(path[i + 1]));
      i++; // Skip the name itself — a field called `properties` or `items` is a name, not a keyword.
    } else if (segment === 'items' && parts.length > 0 && !parts[parts.length - 1].endsWith('[]')) {
      parts[parts.length - 1] += '[]';
    }
  }
  return parts.length > 0 ? parts.join('.') : null;
}

/**
 * Turns a structural path into readable English: `parameter 'status'`, `request field 'address.city'`,
 * `response field 'total'`. Unknown shapes fall back to the raw dotted path rather than crashing.
 */
export function describePath(
  path: (string | number)[],
  oldOp: unknown,
  newOp: unknown,
): string {
  const region = regionOf(path);

  if (region === 'parameter' && typeof path[1] === 'number') {
    const at = ['parameters', path[1], 'name'];
    const name = readPath(newOp, at) ?? readPath(oldOp, at);
    if (typeof name === 'string') return `parameter '${name}'`;
  }

  if (region === 'request' || region === 'response') {
    const field = fieldPath(path);
    return field ? `${regionWord(region)} '${field}'` : regionWord(region);
  }

  return path.join('.');
}
