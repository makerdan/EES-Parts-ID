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
