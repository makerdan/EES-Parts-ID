// Manual Jest mock for @workspace/integrations-gemini-ai
// Prevents the p-limit/yocto-queue ESM-only crash when jest runs in CJS mode.
const ai = {
  models: { generateContent: jest.fn() },
};
const generateImage = jest.fn();
const batchProcess = jest.fn();
const batchProcessWithSSE = jest.fn();
const isRateLimitError = jest.fn(() => false);
module.exports = { ai, generateImage, batchProcess, batchProcessWithSSE, isRateLimitError };
