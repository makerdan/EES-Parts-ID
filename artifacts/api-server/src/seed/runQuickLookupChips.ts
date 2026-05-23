import { seedQuickLookupChips, seedReferenceAnswerCacheFromChips } from "./quickLookupChips";
import { seedBreakerAttributeChips } from "./seedBreakerAttributeChips";

async function main() {
  await seedQuickLookupChips();
  await seedReferenceAnswerCacheFromChips();
  await seedBreakerAttributeChips();
}

main()
  .then(() => {
    console.log("All reference chip seeds complete.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
