#!/usr/bin/env node
import { inspectAccountSkillMirror } from "./lib/account-skill-projection.mjs";

const EXIT_CODES = {
  pass: 0,
  mismatch: 1,
  "unavailable-source": 2,
  "missing-mirror": 3,
};

const skillIndex = process.argv.indexOf("--skill");
const skillName = skillIndex >= 0 ? process.argv[skillIndex + 1] : undefined;
if (!skillName) {
  console.error("Usage: node scripts/account-skill-status.mjs --skill <canonical-skill-id>");
  process.exitCode = 64;
} else {
  try {
    const result = await inspectAccountSkillMirror({
      accountSource: process.env.ACCOUNT_SKILLS_SOURCE,
      skillName,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = EXIT_CODES[result.outcome];
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ outcome: "unavailable-source", skillId: skillName })}\n`);
    process.exitCode = EXIT_CODES["unavailable-source"];
  }
}