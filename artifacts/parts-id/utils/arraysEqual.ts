/**
 * Order-sensitive structural equality for primitive arrays.
 * Faster than `JSON.stringify(a) === JSON.stringify(b)` and avoids the
 * surprise where `undefined` / `NaN` round-trip differently.
 */
export function arraysEqual<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
