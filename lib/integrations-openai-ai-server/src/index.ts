import OpenAI from "openai";
import { getOpenAIClient } from "./client";

export { getOpenAIClient } from "./client";
export { generateImageBuffer, editImages } from "./image";
export { batchProcess, batchProcessWithSSE, isRateLimitError, type BatchOptions } from "./batch";

export const openai: OpenAI = new Proxy({} as OpenAI, {
  get(_target, prop: string | symbol) {
    return Reflect.get(getOpenAIClient() as object, prop);
  },
});
