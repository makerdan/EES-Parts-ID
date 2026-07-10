"use strict";

/**
 * Jest stub for @workspace/api-client-react.
 *
 * Provides only the exports that the files under test actually call at runtime;
 * all React-Query hooks and type-only exports are omitted (they are stripped by
 * ts-jest before this mock is even consulted).
 */

const getListInventoryQueryKey = (params) => {
  return ["/inventory", ...(params ? [params] : [])];
};

module.exports = {
  getListInventoryQueryKey,
};
