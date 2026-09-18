const DEFAULT_SETTINGS = {
  textSize: "normal",
  defaultConfidenceThreshold: 50,
  themeMode: "system",
  shelfViewEnabled: true,
  scanSound: true,
  dimensionUnit: "mm",
};

const useApp = jest.fn(() => ({
  settings: { ...DEFAULT_SETTINGS },
  updateSetting: jest.fn(),
}));

module.exports = { useApp, DEFAULT_SETTINGS };
