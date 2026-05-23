import { seedAllDictionaries } from "./dictionaries";
import { seedQuickLookupChips, seedReferenceAnswerCacheFromChips } from "./quickLookupChips";

Promise.resolve()
  .then(() => seedAllDictionaries())
  .then(() => seedQuickLookupChips())
  .then(() => seedReferenceAnswerCacheFromChips())
  .then(() => {
    console.log("Seed complete");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
