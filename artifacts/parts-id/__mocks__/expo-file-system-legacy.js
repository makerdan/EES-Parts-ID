const readAsStringAsync = jest.fn(async (_uri, _opts) => "RAW_BASE64");

module.exports = { readAsStringAsync };
