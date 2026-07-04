"use strict";

class MockFile {
  save() { return Promise.resolve(); }
  download() { return Promise.resolve([Buffer.alloc(0)]); }
}

class MockBucket {
  file() { return new MockFile(); }
}

class MockStorage {
  bucket() { return new MockBucket(); }
}

module.exports = { Storage: MockStorage };
