/**
 * Small environment helpers for Jest suites that temporarily change process
 * globals. Each suite owns its changes and restores the previous values.
 */

export type TestEnvValues = Record<string, string | undefined>;

export function setTestEnv(values: TestEnvValues): () => void {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}