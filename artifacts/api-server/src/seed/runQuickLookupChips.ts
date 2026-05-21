import { seedQuickLookupChips } from "./quickLookupChips";

seedQuickLookupChips()
  .then(() => {
    console.log("Quick Lookup chip seed complete");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Quick Lookup chip seed failed:", err);
    process.exit(1);
  });
