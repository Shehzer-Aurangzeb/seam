import type { Config, ConsumedRoute } from './config.js';
import type { OperationChange } from './diff.js';

/** `/assets/{assetId}` and `/assets/{id}` both become `/assets/{}` — param names are not part of identity. */
export function normalizePath(path: string): string {
  return path.replace(/\{[^}]*\}/g, '{}');
}

const key = (method: string, path: string) => `${method.toUpperCase()} ${normalizePath(path)}`;

export const changeKey = (change: OperationChange) => key(change.method, change.path);

/**
 * Consumed routes keyed the way spec paths arrive. `basePath` is applied here and nowhere else:
 * config paths follow the frontend's calling convention, spec paths carry the shared prefix.
 * Prefixing at comparison time keeps the stored config untouched.
 */
export function consumedIndex(consumes: Config['consumes'], basePath = ''): Map<string, ConsumedRoute> {
  return new Map(consumes.map((route) => [key(route.method, `${basePath}${route.path}`), route]));
}
