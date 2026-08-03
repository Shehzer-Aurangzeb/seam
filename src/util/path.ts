/** Walks a dotted/indexed path into parsed JSON, returning undefined at the first dead end. */
export function readPath(root: unknown, path: (string | number)[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}
