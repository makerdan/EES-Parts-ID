import type * as AiHelpers from "../../src/utils/aiHelpers";

type AiHelpersModule = typeof AiHelpers;

export interface AiHelpersMockOptions {
  /**
   * Return value or implementation for the image-size helper used by route
   * tests. All other aiHelpers exports come directly from the real module.
   */
  estimateImageBytes?: number | AiHelpersModule["estimateImageBytes"];
}

/**
 * Build the shared aiHelpers Jest mock contract.
 *
 * The real module is supplied by the calling jest.mock factory so Jest keeps
 * the exact identity of exported classes such as MalformedAiResponseError.
 */
export function createAiHelpersMock(
  actual: AiHelpersModule,
  options: AiHelpersMockOptions = {},
): AiHelpersModule {
  const estimateImageBytes = jest.fn(actual.estimateImageBytes);
  const override = options.estimateImageBytes;

  if (override !== undefined) {
    if (typeof override === "function") {
      estimateImageBytes.mockImplementation(override);
    } else {
      estimateImageBytes.mockReturnValue(override);
    }
  }

  return {
    ...actual,
    estimateImageBytes,
  } as AiHelpersModule;
}