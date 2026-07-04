"use strict";

class MockWorksheet {
  addRow() { return this; }
  getRow() { return { values: [], font: {}, fill: {}, eachCell: () => {} }; }
  columns = [];
}

class MockWorkbook {
  addWorksheet() { return new MockWorksheet(); }
  xlsx = {
    writeBuffer: async () => Buffer.alloc(0),
  };
}

module.exports = MockWorkbook;
