/**
 * Derives section parity from a section label string.
 *
 * Parses the leading numeric portion of the label (e.g. "12A" → 12, "00" → 0).
 * Returns "even" when the number is even (including 0), "odd" when odd,
 * and null when no leading digits can be found (parity should be left unchanged).
 */
export function deriveParity(label: string): "even" | "odd" | null {
  const match = label.match(/^(\d+)/);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  return n % 2 === 0 ? "even" : "odd";
}
