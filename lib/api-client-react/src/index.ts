/**
 * Public surface for the orval-generated React Query client.
 *
 * Everything in `./generated/*` is regenerated from
 * `lib/api-spec/openapi.yaml` via `pnpm --filter @workspace/api-spec
 * run codegen` — never edit by hand. This file just re-exports it
 * (plus the custom-fetch wrapper) so consumers can import from a
 * single, stable entry point.
 */
export * from './generated/api';
export * from './generated/api.schemas';
export { setBaseUrl, setAuthTokenGetter, ApiError, ResponseParseError } from './custom-fetch';
export type { AuthTokenGetter } from './custom-fetch';
