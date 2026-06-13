import OpenAI from "openai";

if (!process.env.POE_API_KEY) {
  throw new Error(
    "POE_API_KEY must be set. Did you forget to add the Poe API key secret?",
  );
}

export const poe = new OpenAI({
  apiKey: process.env.POE_API_KEY,
  baseURL: "https://api.poe.com/bot/",
});
