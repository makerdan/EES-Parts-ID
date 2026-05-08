/**
 * Server-side OpenAI client bound to the Replit AI Integrations proxy.
 * Re-exported here so route files can `import { openai } from
 * "@workspace/integrations-openai-ai-server"` without knowing about
 * the proxy details.
 */
export { openai } from './client';
export { generateImageBuffer, editImages } from './image';
export { batchProcess, batchProcessWithSSE, isRateLimitError, type BatchOptions } from './batch';
