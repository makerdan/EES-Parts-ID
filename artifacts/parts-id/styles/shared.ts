/**
 * Shared primitive style constants.
 *
 * These are plain objects (not wrapped in StyleSheet.create) so they can be
 * spread-composed inside any file's own StyleSheet.create() call:
 *
 *   const styles = StyleSheet.create({
 *     myBtn: { ...secondaryBtnBase, paddingHorizontal: 12 },
 *   });
 */

export const secondaryBtnBase = {
  borderWidth: 1,
  borderRadius: 8,
} as const;
