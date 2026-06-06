/**
 * Catch handler for ScreenOrientation.lockAsync / unlockAsync calls.
 *
 * Some devices (iPad split-view, web, certain simulators) do not support
 * orientation locking. Expo surfaces this as an Error whose message contains
 * "not available". We silently swallow those because the user experience is
 * still fine — the layout just won't be forced to a specific orientation.
 * Any other error is unexpected and should be re-thrown so it surfaces in
 * error monitoring.
 */
export function swallowOrientationNotAvailable(err: unknown): void {
  if (err instanceof Error && err.message.includes("not available")) {
    return;
  }
  throw err;
}
