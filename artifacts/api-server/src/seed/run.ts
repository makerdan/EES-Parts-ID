/**
 * One-shot seeder: dictionaries + taxonomy. Idempotent — every seed
 * upserts by slug/key so re-running on a populated DB is a no-op except
 * for new rows added since the last run.
 *
 * Run with: `node --import tsx/esm --no-warnings src/seed/run.ts`
 */
import { seedAllDictionaries } from './dictionaries';
import { seedTaxonomy } from './taxonomy';

(async () => {
  try {
    await seedAllDictionaries();
    const counts = await seedTaxonomy();
    console.log(
      `Seed complete — taxonomy (${counts.source}): +${counts.insertedCategories} categories, +${counts.insertedSubcategories} subcategories, +${counts.insertedTypes} types, ~${counts.updatedNodes} updated`
    );
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
})();
