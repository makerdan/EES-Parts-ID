const readAsStringAsync = jest.fn(async (_uri, _opts) => "RAW_BASE64");

const cacheDirectory = "file:///mock-cache/";

const getInfoAsync = jest.fn(async (_uri) => ({ exists: false, isDirectory: false }));
const makeDirectoryAsync = jest.fn(async (_uri, _opts) => {});
const downloadAsync = jest.fn(async (_uri, _local) => ({ status: 200, uri: _local }));
const createDownloadResumable = jest.fn((uri, local) => ({
  downloadAsync: () => downloadAsync(uri, local),
  cancelAsync: jest.fn(async () => {}),
}));
const deleteAsync = jest.fn(async (_uri, _opts) => {});
const moveAsync = jest.fn(async (_opts) => {});
const readDirectoryAsync = jest.fn(async (_uri) => []);

module.exports = {
  readAsStringAsync,
  cacheDirectory,
  getInfoAsync,
  makeDirectoryAsync,
  downloadAsync,
  createDownloadResumable,
  deleteAsync,
  moveAsync,
  readDirectoryAsync,
};
