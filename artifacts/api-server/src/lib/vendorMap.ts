/**
 * Build the vendor-name lookup used by inventory search.
 *
 * Vendor rows are read from PostgreSQL without an ORDER BY, so relying on
 * their physical order makes duplicate aliases resolve differently after
 * reseeding or unrelated updates. Primary rows win over extended rows, and
 * the explicit Eaton aliases below preserve the product-family mapping that
 * distinguishes Eaton/Cutler-Hammer parts (CHD) from the Eaton corporate code
 * (ETN).
 */

export interface VendorMapEntry {
  code: string;
  names: ReadonlyArray<string>;
  isPrimary: boolean;
}

const PREFERRED_VENDOR_ALIASES = new Map<string, string>([
  ["eaton", "CHD"],
  ["cutler hammer", "CHD"],
  ["cutler-hammer", "CHD"],
  ["c-h", "CHD"],
  ["eaton electrical", "CHD"],
]);

export function buildReverseVendorMap(
  vendors: ReadonlyArray<VendorMapEntry>,
): Map<string, string> {
  const reverseVendorMap = new Map<string, string>();

  // PostgreSQL does not guarantee the order of the dictionary query. Use a
  // stable order for the fallback conflict policy: primary rows after
  // extended rows, then code order within each group.
  const orderedVendors = [...vendors].sort((a, b) =>
    Number(a.isPrimary) - Number(b.isPrimary) || a.code.localeCompare(b.code)
  );

  for (const vendor of orderedVendors) {
    for (const name of vendor.names) {
      reverseVendorMap.set(name.toLowerCase(), vendor.code);
    }
  }

  const primaryCodes = new Set(
    vendors.filter((vendor) => vendor.isPrimary).map((vendor) => vendor.code),
  );
  for (const [alias, code] of PREFERRED_VENDOR_ALIASES) {
    if (primaryCodes.has(code)) {
      reverseVendorMap.set(alias, code);
    }
  }

  return reverseVendorMap;
}