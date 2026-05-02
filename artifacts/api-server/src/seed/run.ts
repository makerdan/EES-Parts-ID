import { seedAllDictionaries } from "./dictionaries";
import { seedTaxonomy } from "./taxonomy";

(async () => {
  try {
    await seedAllDictionaries();
    const counts = await seedTaxonomy();
    console.log(
      `Seed complete — taxonomy: +${counts.insertedCategories} categories, +${counts.insertedSubcategories} subcategories, +${counts.insertedTypes} types, ~${counts.updatedNodes} updated`,
    );
    process.exit(0);
  } catch (err) {
    console.error("Seed failed:", err);
    process.exit(1);
  }
})();
