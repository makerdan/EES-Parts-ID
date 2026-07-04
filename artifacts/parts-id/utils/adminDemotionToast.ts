/**
 * Pure helper for detecting an admin demotion transition.
 *
 * Returns true only when the user *was* an admin and is *no longer* one.
 * Used by `verifyAdmin` in AppContext to decide whether to show a toast.
 */
export function shouldNotifyDemotion(wasAdmin: boolean, isNowAdmin: boolean): boolean {
  return wasAdmin && !isNowAdmin;
}
