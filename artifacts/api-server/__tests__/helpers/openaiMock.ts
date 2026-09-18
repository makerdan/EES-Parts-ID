/**
 * Shared OpenAI constructor mock contract for API tests.
 *
 * Production code uses OpenAI's static error classes with `instanceof`.
 * Keeping those classes on the mocked constructor prevents import-only test
 * doubles from silently drifting away from the runtime module contract.
 */

type JestApi = Pick<typeof jest, "fn">;

type OpenAIConstructor = jest.Mock;

const errorClassNames = [
  "RateLimitError",
  "InternalServerError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "AuthenticationError",
  "PermissionDeniedError",
] as const;

export function attachOpenAIErrorClasses(
  constructor: OpenAIConstructor,
): OpenAIConstructor {
  const constructorWithStatics = constructor as unknown as Record<
    string,
    unknown
  >;
  for (const name of errorClassNames) {
    constructorWithStatics[name] = class extends Error {};
  }
  return constructor;
}

export function createOpenAIMock(
  jestApi: JestApi,
  implementation: () => unknown = () => ({
    chat: { completions: { create: jestApi.fn() } },
  }),
): OpenAIConstructor {
  const constructor = jestApi
    .fn()
    .mockImplementation(implementation) as OpenAIConstructor;
  return attachOpenAIErrorClasses(constructor);
}
