import OpenAI from "openai";

import { getOpenAIClient } from "./client";

export { type BatchOptions,batchProcess, batchProcessWithSSE, isRateLimitError } from "./batch";
export { getOpenAIClient } from "./client";
export { editImages,generateImageBuffer } from "./image";

export const openai: OpenAI = new Proxy({} as OpenAI, {
  get(_target, prop: string | symbol) {
    return Reflect.get(getOpenAIClient() as object, prop);
  },
});
