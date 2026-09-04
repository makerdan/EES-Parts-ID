import { z } from "zod";

/**
 * Runtime contracts for model-generated JSON. These schemas intentionally live
 * beside the API contracts so every caller validates provider output against
 * the same shapes before returning it or using it for a write.
 */

export const AiIdentifyResponseSchema = z.object({
  partNumbers: z.array(z.string()).default([]),
  searchTerms: z.array(z.string()).default([]),
  synonyms: z.array(z.string()).default([]),
  relatedTerms: z.array(z.string()).default([]),
  manufacturerVerified: z.boolean().default(false),
  detectedVendor: z.string().nullable().default(null),
  summary: z.string().default(""),
});

export type AiIdentifyResponse = z.infer<typeof AiIdentifyResponseSchema>;

export const AiTranslateResponseSchema = z.object({
  translatedTerms: z.array(z.string()).default([]),
  interpretation: z.string().default(""),
  appliedTranslation: z.boolean().default(false),
  partName: z.string().default(""),
  partSpecs: z.array(z.string()).default([]),
  catalogNumbers: z.array(z.string()).default([]),
  suggestedRequery: z.string().default(""),
});

export type AiTranslateResponse = z.infer<typeof AiTranslateResponseSchema>;

const AiPartCardSpecSchema = z.object({
  label: z.string(),
  value: z.string(),
});

export const AiPartCardResponseSchema = z.object({
  displayName: z.string().default(""),
  // Keep the outer array permissive so one malformed spec cannot discard
  // otherwise useful model output. Callers validate each element below.
  specs: z.array(z.unknown()).default([]),
  crossRefs: z.array(z.unknown()).default([]),
  // The route preserves valid fields while safely dropping this optional
  // field when a provider returns a non-string value.
  compatibilityNote: z.unknown().default(""),
});

export const AiPartCardSpecResponseSchema = AiPartCardSpecSchema;

export type AiPartCardResponse = z.infer<typeof AiPartCardResponseSchema>;

export const AiEnrichmentResponseSchema = z.object({
  expandedDescription: z.string().trim().min(1),
  confidence: z.number().finite().min(0).max(100),
});

export type AiEnrichmentResponse = z.infer<typeof AiEnrichmentResponseSchema>;

export const AiDimensionsResponseSchema = z.object({
  length: z.number().finite().positive().max(100_000).nullable(),
  width: z.number().finite().positive().max(100_000).nullable(),
  height: z.number().finite().positive().max(100_000).nullable(),
  diameter: z.number().finite().positive().max(100_000).nullable(),
});

export type AiDimensionsResponse = z.infer<typeof AiDimensionsResponseSchema>;

export const AiCatalogEntrySchema = z.object({
  catalogNumber: z.string().trim().min(1),
  description: z.string(),
  confidence: z.number().finite(),
  hasPartImage: z.boolean().default(false),
  // These fields are normalized by the catalogue extractor after validation.
  imageRegion: z.unknown().nullable().optional().default(null),
  imageRegion2: z.unknown().nullable().optional().default(null),
  imageIndex: z.number().finite().optional().default(-1),
  imageIndex2: z.number().finite().optional().default(-1),
});

export const AiCatalogResponseSchema = z.array(z.unknown());

export type AiCatalogEntry = z.infer<typeof AiCatalogEntrySchema>;

export const AiKeywordsResponseSchema = z.array(z.string());