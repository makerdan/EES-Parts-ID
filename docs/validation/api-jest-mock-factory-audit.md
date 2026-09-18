# API Jest mock-factory contract audit

This inventory covers the API test roots
`artifacts/api-server/__tests__` and `artifacts/api-server/src/__tests__`.
The audit is intentionally limited to factories that replace classes,
constructors, static error classes, or other identity-sensitive exports.

## Confirmed risk and fix

### OpenAI constructor factories

The production API imports `OpenAI` directly and uses its static error classes
with `instanceof`, including `OpenAI.RateLimitError`. A mock that only returns
an object from `new OpenAI()` is therefore incomplete even when the individual
test only imports the app.

The incomplete factories were:

- `artifacts/api-server/__tests__/adminAiProvider.integration.test.ts`
- `artifacts/api-server/__tests__/adminAiStatus.integration.test.ts`
- `artifacts/api-server/__tests__/adminMe.integration.test.ts`
- `artifacts/api-server/__tests__/aiProvider.test.ts`
- `artifacts/api-server/src/__tests__/bootstrapAdminClerkFetchFailed.test.ts`
- `artifacts/api-server/src/__tests__/bootstrapAdminEmailCollision.test.ts`
- `artifacts/api-server/src/__tests__/requestIdTracing.test.ts`
- `artifacts/api-server/src/__tests__/requireAppAuthErrorPath.test.ts`
- `artifacts/api-server/src/__tests__/routeHandlerErrorPath.test.ts`

They now use the shared `openaiMock` contract, which supplies the constructor
and the static classes used by production error classification. Existing
factories in `adminUsers.integration.test.ts`, `adminAuditLog.integration.test.ts`,
`poeBotChain.test.ts`, `rateLimitEndpoints.test.ts`, `adminAiStatus.test.ts`,
`adminApprovalFlow.test.ts`, `adminQuery.test.ts`, and `adminSelfAction.test.ts`
already supplied those classes and were left semantically unchanged.

## Confirmed-safe factories

- `@workspace/integrations-openai-ai-server` and its `/batch` subpath are
  function/object boundary doubles. They do not export the OpenAI error
  classes consumed by the API routes.
- `sharp`, `pdfjs-dist`, `http-proxy-middleware`, logger, database, object
  storage, matcher, cache, and resize mocks replace procedural APIs or data
  objects rather than class identities.
- `aiHelpers` factories spread `jest.requireActual`, preserving
  `MalformedAiResponseError`.
- Catalog extractor factories spread `jest.requireActual`, preserving
  `CatalogAiError`.
- Poe bot factories spread `jest.requireActual`, preserving
  `PoeHttpError` and `PoeBotChainExhaustedError`. Their success-path overrides
  intentionally make Poe classification helpers return `false`; those mocks
  are not error-class classification coverage.

## Contract cleanup

The `requestIdTracing` and `routeHandlerErrorPath` mocks previously added
`PoeBotChainExhaustedError` to a mock of `aiProvider`, although that class is
exported by `poeBot`, not `aiProvider`. The stale entries were removed so those
mocks now describe the production module surface more accurately.
