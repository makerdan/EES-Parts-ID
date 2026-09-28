const COUNT_FIELDS = [
  "numTotalTestSuites",
  "numPassedTestSuites",
  "numFailedTestSuites",
  "numPendingTestSuites",
  "numTotalTests",
  "numPassedTests",
  "numFailedTests",
  "numPendingTests",
  "numTodoTests",
];

const TEST_STATUSES = new Set([
  "passed",
  "failed",
  "pending",
  "todo",
  "skipped",
]);

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function invalid(reason) {
  return { ok: false, reason, executedTestCount: 0, pendingTestCount: 0 };
}

/**
 * Validate the stable portion of Jest/Vitest JSON reporter output and count
 * only assertions that actually executed. Pending, todo, and skipped tests
 * are intentionally not evidence that a run exercised the suite.
 */
export function validateTestResultArtifact(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return invalid("result must be a JSON object");
  }

  for (const field of COUNT_FIELDS) {
    if (!isNonNegativeInteger(data[field])) {
      return invalid(`${field} must be a non-negative integer`);
    }
  }

  if (
    data.numRuntimeErrorTestSuites !== undefined &&
    !isNonNegativeInteger(data.numRuntimeErrorTestSuites)
  ) {
    return invalid("numRuntimeErrorTestSuites must be a non-negative integer when present");
  }

  if (!Array.isArray(data.testResults)) {
    return invalid("testResults must be an array");
  }

  if (
    data.numPassedTestSuites +
      data.numFailedTestSuites +
      data.numPendingTestSuites >
    data.numTotalTestSuites
  ) {
    return invalid("suite counts exceed numTotalTestSuites");
  }

  if (
    data.numPassedTests + data.numFailedTests > data.numTotalTests ||
    data.numPendingTests + data.numTodoTests > data.numTotalTests
  ) {
    return invalid("test counts exceed numTotalTests");
  }

  let executedTestCount = 0;
  let pendingTestCount = 0;
  let passedTestCount = 0;
  let failedTestCount = 0;
  let todoTestCount = 0;

  for (const fileResult of data.testResults) {
    if (!fileResult || typeof fileResult !== "object" || Array.isArray(fileResult)) {
      return invalid("each testResults entry must be an object");
    }

    const tests = fileResult.testResults ?? fileResult.assertionResults;
    if (!Array.isArray(tests)) {
      return invalid("each testResults entry must contain testResults or assertionResults");
    }

    for (const test of tests) {
      if (
        !test ||
        typeof test !== "object" ||
        Array.isArray(test) ||
        !TEST_STATUSES.has(test.status)
      ) {
        return invalid("each assertion result must have a recognized status");
      }
      if (test.status === "passed" || test.status === "failed") {
        executedTestCount++;
        if (test.status === "passed") passedTestCount++;
        else failedTestCount++;
      } else {
        pendingTestCount++;
        if (test.status === "todo") todoTestCount++;
      }
    }
  }

  const observedTestCount =
    passedTestCount + failedTestCount + pendingTestCount;
  if (observedTestCount !== data.numTotalTests) {
    return invalid(
      `nested assertion count ${observedTestCount} does not match numTotalTests ${data.numTotalTests}`,
    );
  }
  if (passedTestCount !== data.numPassedTests) {
    return invalid(
      `nested passed assertion count ${passedTestCount} does not match numPassedTests ${data.numPassedTests}`,
    );
  }
  if (failedTestCount !== data.numFailedTests) {
    return invalid(
      `nested failed assertion count ${failedTestCount} does not match numFailedTests ${data.numFailedTests}`,
    );
  }
  if (todoTestCount !== data.numTodoTests) {
    return invalid(
      `nested todo assertion count ${todoTestCount} does not match numTodoTests ${data.numTodoTests}`,
    );
  }
  if (pendingTestCount - todoTestCount !== data.numPendingTests) {
    return invalid(
      `nested pending assertion count ${pendingTestCount - todoTestCount} does not match numPendingTests ${data.numPendingTests}`,
    );
  }

  return {
    ok: true,
    executedTestCount,
    pendingTestCount,
    hasFailures:
      data.numFailedTestSuites > 0 ||
      data.numFailedTests > 0 ||
      (data.numRuntimeErrorTestSuites ?? 0) > 0,
    isPassing:
      data.numFailedTestSuites === 0 &&
      data.numFailedTests === 0 &&
      (data.numRuntimeErrorTestSuites ?? 0) === 0,
  };
}
