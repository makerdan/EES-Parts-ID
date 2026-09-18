import { z } from "zod";

export const AdminProfilePayloadSchema = z.object({
  dimensionUnit: z.enum(["mm", "cm", "in"]),
  textSize: z.enum(["small", "normal", "large"]),
  themeMode: z.enum(["light", "dark", "system"]),
  defaultConfidenceThreshold: z
    .number()
    .int()
    .min(0)
    .max(100),
  scanSound: z.boolean(),
});

export type AdminProfilePayload = z.infer<typeof AdminProfilePayloadSchema>;

export const ShelfPreferencesPayloadSchema = z.object({
  shelfPrefix: z.string().max(10).optional(),
  shelfStep: z.number().int().min(1).max(100).optional(),
});

export type ShelfPreferencesPayload = z.infer<typeof ShelfPreferencesPayloadSchema>;

export const AiIdentifyBodySchema = z.object({
  images: z.array(z.string()).min(1, "At least one image is required").max(10),
  keywords: z.string().max(500).optional(),
  vendor: z.string().max(200).optional(),
  color: z.string().max(100).optional(),
  size: z.string().max(100).optional(),
  material: z.string().max(100).optional(),
  textNumbers: z.string().max(500).optional(),
});

export type AiIdentifyBody = z.infer<typeof AiIdentifyBodySchema>;

export const AiTranslateQueryBodySchema = z.object({
  query: z.string().max(1000).optional(),
  zeroResults: z.boolean().optional(),
});

export type AiTranslateQueryBody = z.infer<typeof AiTranslateQueryBodySchema>;

export const AiPartCardBodySchema = z.object({
  catalog: z.string().max(200).optional(),
  vendor: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  force: z.boolean().optional(),
});

export type AiPartCardBody = z.infer<typeof AiPartCardBodySchema>;

