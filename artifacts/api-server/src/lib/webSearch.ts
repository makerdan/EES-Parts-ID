import { ai } from "@workspace/integrations-gemini-ai";

/** Gemini model used for reference Q&A (web-grounded). */
export const WEB_REFERENCE_MODEL = "gemini-2.5-flash";

/**
 * Call Gemini-2.5-Flash via Replit AI Integrations for a reference answer.
 *
 * Sends a single-turn prompt consisting of a system instruction and the user
 * question. Returns the model's full text response.
 */
export async function callGemini(
  systemInstruction: string,
  userMessage: string,
): Promise<string> {
  const response = await ai.models.generateContent({
    model: WEB_REFERENCE_MODEL,
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    config: {
      systemInstruction,
      maxOutputTokens: 8192,
    },
  });
  return response.text ?? "";
}
