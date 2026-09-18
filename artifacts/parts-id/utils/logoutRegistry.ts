/**
 * Tiny pub/sub registry used by AppContext to invite screens to reset their
 * in-memory state on logout (e.g. SearchScreen clearing filters/results so a
 * subsequent login doesn't see the prior session's data).
 *
 * Extracted into its own module so the registry contract — register returns
 * an unsubscribe, fire is exception-safe, unsubscribed handlers are skipped —
 * can be unit tested without spinning up the full provider.
 */
export type LogoutHandler = () => void;

export class LogoutRegistry {
  private handlers = new Set<LogoutHandler>();

  register(handler: LogoutHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  fire(): void {
    for (const handler of this.handlers) {
      try {
        handler();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[LogoutRegistry] handler threw:", err);
      }
    }
  }

  size(): number {
    return this.handlers.size;
  }
}
