/**
 * Parses and validates the structured Vision API response for Photo ID.
 *
 * The Vision prompt requests a specific JSON shape. This module extracts
 * the JSON, validates it with Zod, and returns a typed object. Any parse or
 * validation failure throws a VisionParseError so the caller can log the event
 * and return a graceful "could not identify" response to the client.
 */

import { z } from "zod";

export const VisionContractSchema = z.object({
  catalog_guess:      z.string().nullable().default(null),
  vendor_guess:       z.string().nullable().default(null),
  type_guess:         z.string().nullable().default(null),
  attributes: z
    .object({
      amperage:      z.number().nullable().default(null),
      poles:         z.number().nullable().default(null),
      voltage:       z.number().nullable().default(null),
      trade_size_in: z.number().nullable().default(null),
      color:         z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  descriptive_tokens: z.array(z.string()).default([]),
  confidence:         z.number().min(0).max(1).nullable().default(null),
  notes:              z.string().nullable().default(null),
});

export type VisionContract = z.infer<typeof VisionContractSchema>;

export class VisionParseError extends Error {
  constructor(
    public readonly raw: string,
    cause: unknown,
  ) {
    super("Vision response could not be parsed");
    this.name = "VisionParseError";
    this.cause = cause;
  }
}

/**
 * Extracts, parses, and Zod-validates the structured Vision response.
 *
 * @param raw  Raw text content from the Vision API response.
 * @returns    Validated VisionContract.
 * @throws     VisionParseError when JSON cannot be extracted or validation fails.
 */
export function handleVisionResponse(raw: string): VisionContract {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error("[handleVisionResponse] no JSON object found:", raw.slice(0, 400));
    throw new VisionParseError(raw, new Error("No JSON object found in response"));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (e) {
    console.error("[handleVisionResponse] JSON.parse failed:", e, raw.slice(0, 400));
    throw new VisionParseError(raw, e);
  }

  const result = VisionContractSchema.safeParse(parsed);
  if (!result.success) {
    console.error("[handleVisionResponse] schema validation failed:", result.error.flatten());
    throw new VisionParseError(raw, result.error);
  }

  return result.data;
}
