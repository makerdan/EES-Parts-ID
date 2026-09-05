import { catalogPdfJobTable } from "@workspace/db";
import { and, eq, isNull, or } from "drizzle-orm";

/**
 * Catalog jobs are private to the administrator whose Clerk identity created
 * them. Keep the predicate in one place so every route applies the same
 * ownership boundary, including parent and child chunk jobs.
 */
export function ownedCatalogPdfJobWhere(jobId: number, ownerClerkUserId: string) {
  return and(
    eq(catalogPdfJobTable.id, jobId),
    catalogPdfOwnerWhere(ownerClerkUserId),
  );
}

export function ownedCatalogPdfChildWhere(parentJobId: number, ownerClerkUserId: string) {
  return and(
    eq(catalogPdfJobTable.parentJobId, parentJobId),
    catalogPdfOwnerWhere(ownerClerkUserId),
  );
}

/**
 * Jobs created before ownership tracking have a null owner. They remain
 * available only to the configured bootstrap administrator so the existing
 * single-admin catalog history continues to work without exposing unowned
 * legacy rows to another administrator.
 */
export function catalogPdfOwnerWhere(ownerClerkUserId: string) {
  return isCatalogPdfLegacyOwner(ownerClerkUserId)
    ? or(
        eq(catalogPdfJobTable.ownerClerkUserId, ownerClerkUserId),
        isNull(catalogPdfJobTable.ownerClerkUserId),
      )
    : eq(catalogPdfJobTable.ownerClerkUserId, ownerClerkUserId);
}

export function isCatalogPdfLegacyOwner(ownerClerkUserId: string): boolean {
  return process.env.ADMIN_CLERK_USER_ID === ownerClerkUserId;
}