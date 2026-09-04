import assert from "node:assert/strict";
import { hasExplicitTestFilter, getSuiteFloor, violatesSuiteFloor } from "../../artifacts/api-server/scripts/run-tests.mjs";

assert.equal(hasExplicitTestFilter(["__tests__/inventory.test.ts"]), true);
assert.equal(hasExplicitTestFilter(["--testNamePattern=returns inventory"]), true);
assert.equal(hasExplicitTestFilter(["--testNamePattern", "returns inventory"]), true);
assert.equal(hasExplicitTestFilter(["--config", "jest.config.cjs", "--runInBand"]), false);

const fullRunFloor = getSuiteFloor({ discoveredCount: 100, focused: false });
assert.equal(fullRunFloor, 85);
assert.equal(violatesSuiteFloor({ ran: 84, suiteFloor: fullRunFloor }), true);
assert.equal(violatesSuiteFloor({ ran: 85, suiteFloor: fullRunFloor }), false);

const focusedRunFloor = getSuiteFloor({ discoveredCount: 100, focused: true });
assert.equal(focusedRunFloor, null);
assert.equal(violatesSuiteFloor({ ran: 0, suiteFloor: focusedRunFloor }), false);

console.log("API suite-floor contract: focused and full-run guard behavior passed");