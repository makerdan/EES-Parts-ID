import { z } from "zod";

const InventoryItemSchema = z.object({
  id: z.number(),
  vendor: z.string(),
  catalog: z.string(),
  orderPurchase: z.number().int().nonnegative(),
  orderQuantity: z.number().int().nonnegative(),
  description: z.string(),
  binLocations: z
    .array(z.string())
    .describe(
      "Bin locations where this part is stored (a part may live in multiple bins)",
    ),
  aiKeywords: z.array(z.string()),
  barcodes: z
    .array(z.string())
    .describe("Barcode values associated with this part"),
  enrichedAt: z.coerce.date().nullish(),
  imageUrl: z
    .string()
    .nullish()
    .describe(
      "URL of the full-size catalog image (longest edge ≤ 800 px), served via the API proxy",
    ),
  thumbnailUrl: z
    .string()
    .nullish()
    .describe(
      "URL of the thumbnail image (longest edge ≤ 200 px), served via the API proxy",
    ),
  imageUrl2: z
    .string()
    .nullish()
    .describe(
      "URL of the second full-size photo (Detail / Wire Frame slot), served via the API proxy",
    ),
  thumbnailUrl2: z
    .string()
    .nullish()
    .describe(
      "URL of the second thumbnail photo (Detail / Wire Frame slot), served via the API proxy",
    ),
  expandedDescription: z
    .string()
    .nullish()
    .describe(
      "AI-expanded plain-English version of the abbreviated description (admin enrichment, never replaces the original)",
    ),
  dimensions: z
    .object({
      length: z.number().nullish(),
      width: z.number().nullish(),
      height: z.number().nullish(),
      diameter: z.number().nullish(),
    })
    .nullish()
    .describe(
      "Physical dimensions in millimetres (length, width, height, diameter)",
    ),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/** 201 response for POST /inventory/add-part */
export const AddPartResponse = z.object({
  item: InventoryItemSchema,
});

/** 409 response for POST /inventory/add-part (duplicate vendor+catalog) */
export const AddPartConflictResponse = z.object({
  error: z.string(),
  existingItem: InventoryItemSchema,
});

const BinDiffRowSchema = z.object({
  vendor: z.string(),
  catalog: z.string(),
  status: z.enum(["replace", "add", "preserve", "none"]),
  existingBins: z.array(z.string()),
  incomingBins: z.array(z.string()),
});

/** Request body for PATCH /inventory/:id/expanded-description */
export const PatchExpandedDescriptionBody = z.object({
  expandedDescription: z.string().max(2000).nullable(),
});


/** 200 response for POST /inventory/upsert-batch/preview */
export const UpsertBatchPreviewResponse = z.object({
  willReplaceBins: z.number().int().nonnegative(),
  willAddBins: z.number().int().nonnegative(),
  willPreserveBins: z.number().int().nonnegative(),
  noChange: z.number().int().nonnegative(),
  rows: z.array(BinDiffRowSchema),
});
