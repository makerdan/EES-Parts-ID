// CJS mock stub for @workspace/integrations-gemini-ai.
// Used by jest.config.cjs moduleNameMapper to prevent the p-limit ESM crash.
const ai = {
  models: {
    generateContent: jest.fn(),
  },
};
const generateImage = jest.fn();
const batchProcess = jest.fn();
const batchProcessWithSSE = jest.fn();
const isRateLimitError = jest.fn(() => false);

module.exports = { ai, generateImage, batchProcess, batchProcessWithSSE, isRateLimitError };
