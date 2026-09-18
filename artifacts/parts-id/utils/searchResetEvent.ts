type Listener = () => void;

const listeners = new Set<Listener>();

export const searchResetEvent = {
  emit() {
    listeners.forEach(fn => fn());
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
