/**
 * Escape SQL LIKE wildcard characters in a literal string so it can be safely
 * embedded inside a LIKE pattern without matching unintended rows.
 *
 * PostgreSQL's default LIKE escape character is backslash, so:
 *   %  →  \%   (would otherwise match any sequence of characters)
 *   _  →  \_   (would otherwise match any single character)
 *
 * Usage:
 *   const pattern = `%${escapeLikeWildcard(keyword)}%`;
 *   // safe to use directly with LIKE — no explicit ESCAPE clause needed
 *   // because \ is already Postgres LIKE's default escape character.
 */
export function escapeLikeWildcard(value: string): string {
  return value.replace(/%/g, "\\%").replace(/_/g, "\\_");
}
