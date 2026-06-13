import { db } from "@workspace/db";
import { quickLookupCacheTable } from "@workspace/db";
import { getAiClient, getEnrichModel } from "../lib/aiProvider";
import { normalizeQuestion, hashQuestion, setCachedAnswer } from "../lib/answerCache";

const SYSTEM_PROMPT =
  "You are a concise electrical supply reference assistant for warehouse workers. Answer questions about electrical parts, NEC codes, NEMA ratings, wire gauges, breaker types, conduit sizing, and terminology. Use **bold** for key terms and - bullets for lists. Keep answers under 200 words. Be precise and practical.";

export const QUICK_LOOKUP_CHIPS: Array<{ label: string; question: string }> = [
  { label: "1G",               question: "What is a 1-gang electrical box, what devices does it hold, and what are the standard dimensions?" },
  { label: "GFCI",             question: "What does GFCI stand for, how does it work, and where is it required by the NEC?" },
  { label: "AFCI",             question: "What is an AFCI breaker or receptacle, how does it work, and where does the NEC require it?" },
  { label: "TRWR",             question: "What does TRWR mean on a receptacle — what is Tamper Resistant and Weather Resistant, and where is each required?" },
  { label: "Decora",           question: "What is a Decora style switch or receptacle, who makes them, and how do they differ from standard toggle style?" },
  { label: "Romex",            question: "What is Romex (NM-B cable), what do the numbers on the sheath mean, and when is it allowed by code?" },
  { label: "MC Cable",         question: "What is MC cable (Metal Clad armored cable), how does it differ from Romex, and when should it be used?" },
  { label: "EMT",              question: "What is EMT (Electrical Metallic Tubing) conduit, what are its common uses, and how does it differ from rigid conduit?" },
  { label: "Toggle vs Rocker", question: "What is the difference between a toggle switch and a rocker (paddle) switch — are they interchangeable?" },
  { label: "Duplex",           question: "What is a duplex receptacle, how does it differ from simplex and quadplex outlets, and what are standard amperage ratings?" },
  { label: "15A vs 20A",       question: "What is the difference between 15 amp and 20 amp circuits, receptacles, and breakers — how do I tell them apart?" },
  { label: "AWG",              question: "What does AWG mean, how does wire gauge numbering work, and which gauge should I use for common circuits?" },
];

async function generateAnswer(question: string): Promise<string> {
  const stream = await getAiClient().chat.completions.create({
    model: getEnrichModel(),
    max_completion_tokens: 512,
    stream: true,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: question },
    ],
  });

  let fullText = "";
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) fullText += content;
  }
  return fullText;
}

export async function seedQuickLookupChips(): Promise<void> {
  console.log(`Seeding ${QUICK_LOOKUP_CHIPS.length} Quick Lookup chip answers…`);

  for (const { label, question } of QUICK_LOOKUP_CHIPS) {
    process.stdout.write(`  [${label}] generating… `);
    const answer = await generateAnswer(question);

    await db
      .insert(quickLookupCacheTable)
      .values({ label, answer, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: quickLookupCacheTable.label,
        set: { answer, updatedAt: new Date() },
      });

    console.log("done");
  }

  console.log("Quick Lookup chip seed complete.");
}

export async function seedReferenceAnswerCacheFromChips(): Promise<void> {
  console.log(`Cross-populating reference_answer_cache from ${QUICK_LOOKUP_CHIPS.length} chip questions…`);

  const rows = await db.select().from(quickLookupCacheTable);
  const answerByLabel = new Map(rows.map((r) => [r.label, r.answer]));

  for (const { label, question } of QUICK_LOOKUP_CHIPS) {
    const answer = answerByLabel.get(label);
    if (!answer) {
      console.warn(`  [${label}] no cached answer found — skipping`);
      continue;
    }

    const normalized = normalizeQuestion(question);
    const questionHash = hashQuestion(normalized);
    await setCachedAnswer(questionHash, question, answer);
    console.log(`  [${label}] cross-populated`);
  }

  console.log("Reference answer cache pre-seed complete.");
}
