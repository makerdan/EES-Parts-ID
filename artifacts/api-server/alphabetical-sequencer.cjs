'use strict';

/**
 * Custom Jest test sequencer that runs test files in strict alphabetical
 * order by filename. This gives deterministic, human-readable ordering and,
 * critically, ensures that reclassify.integration.test.ts (r…) always runs
 * before seriesAutoAssign.integration.test.ts (s…) so the long-running
 * reclassify SSE scan cannot be contaminated by seriesAutoAssign's advisory-
 * lock activity.
 *
 * Jest requires a class with a `sort(tests)` method that returns the sorted
 * array. `cacheResults` is implemented as a no-op so Jest's --onlyFailures
 * flag still works (it just won't use timing-based ordering).
 */

const path = require('path');

class AlphabeticalSequencer {
  sort(tests) {
    return [...tests].sort((a, b) => {
      const nameA = path.basename(a.path);
      const nameB = path.basename(b.path);
      return nameA.localeCompare(nameB);
    });
  }

  cacheResults() {
    return Promise.resolve();
  }
}

module.exports = AlphabeticalSequencer;
