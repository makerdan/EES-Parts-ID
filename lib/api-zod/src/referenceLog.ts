import { z } from "zod";

export const ReferenceLogRowSchema = z.object({
  id: z.number().int().positive(),
  question: z.string().min(1).max(2_000),
  answer: z.string().min(1).max(20_000),
  matchedItemCount: z.number().int().nonnegative().max(1_000_000),
  createdAt: z.string().datetime({ offset: true }),
});

export const ReferenceLogResponseSchema = z.object({
  rows: z.array(ReferenceLogRowSchema).max(100),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive().max(100),
  hasMore: z.boolean(),
});

export const ReferenceLogQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(20).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export type ReferenceLogRow = z.infer<typeof ReferenceLogRowSchema>;
export type ReferenceLogResponse = z.infer<typeof ReferenceLogResponseSchema>;