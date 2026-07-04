import { db } from "@workspace/db";
import { quickLookupCacheTable } from "@workspace/db";

const BREAKER_ATTRIBUTE_CHIPS: Array<{ label: string; answer: string }> = [
  {
    label: "Amp Rating",
    answer:
      "**Amp Rating** is the maximum continuous current the breaker will carry without tripping. Common residential ratings are **15A** and **20A**; commercial/industrial panels use 30A, 60A, 100A, and higher. Always match the breaker amp rating to the wire gauge — 15A for 14 AWG, 20A for 12 AWG.",
  },
  {
    label: "Poles",
    answer:
      "**Poles** indicate how many hot conductors the breaker controls.\n- **1-Pole (1P):** 120 V circuits (lights, receptacles)\n- **2-Pole (2P):** 240 V circuits (dryers, HVAC, ranges)\n- **3-Pole (3P):** Three-phase 208/480 V circuits (commercial motors, large equipment)",
  },
  {
    label: "Voltage Rating",
    answer:
      "**Voltage Rating** is the maximum system voltage the breaker is listed for. Common ratings:\n- **120/240 V** — standard residential single-phase\n- **120/208 V** — commercial three-phase wye\n- **277/480 V** — industrial three-phase\nNever install a breaker in a panel whose voltage exceeds the breaker's rating.",
  },
  {
    label: "Frame Size",
    answer:
      "**Frame Size** is a physical size classification that determines the maximum ampere rating available in that frame. For example, a 100A frame can hold breakers from 15A up to 100A. Common frame sizes: 100A, 225A, 400A, 600A, 800A. Frame size must match the panel's bus bar mounting.",
  },
  {
    label: "AIC Rating",
    answer:
      "**AIC (Ampere Interrupting Capacity)** is the maximum fault current the breaker can safely interrupt without damage. Residential panels typically require **10,000 AIC**; commercial applications may need 22,000–65,000 AIC or higher. Under-rated breakers can explode during a fault. Always verify AIC meets the available fault current at the panel.",
  },
  {
    label: "Mount Type",
    answer:
      "**Mount Type** describes how the breaker attaches to the panel bus:\n- **Plug-in:** Snaps onto bus stabs (most residential panels — Square D QO, Eaton BR, Siemens)\n- **Bolt-on:** Bolted to bus bar (industrial panels, higher vibration applications)\nPlug-in and bolt-on breakers are NOT interchangeable even if they look similar.",
  },
  {
    label: "Physical Footprint",
    answer:
      "**Physical Footprint** refers to how many panel spaces (slots) the breaker occupies.\n- **Full-size (1\" wide):** Takes 1 slot per pole\n- **Tandem / Twin:** Two 1-pole breakers in one slot space (where panel and local code allow)\n- **Double-pole:** Takes 2 adjacent slots\nAlways check the panel's loadcenter directory for approved tandem positions.",
  },
  {
    label: "Series Codes",
    answer:
      "**Series Codes** are manufacturer-specific identifiers that indicate the breaker family and compatibility:\n- **Eaton:** BR, CH, BAB, HQP\n- **Square D:** QO, HOM, FA, KA\n- **Siemens/ITE:** QP, QPF, EQ\n- **GE:** THQL, THQP\nBreakers are only listed for specific panel series — mixing series can void listings and create safety hazards.",
  },
  {
    label: "Trade Size",
    answer:
      "**Trade Size** in the context of breakers refers to the common industry shorthand combining poles and amps, e.g. **1P-20A**, **2P-30A**, **3P-60A**. When ordering, specifying trade size plus series code (e.g., \"BR 1P-20A\") ensures you get the correct breaker for the panel family. Some vendors use it interchangeably with frame size.",
  },
];

export async function seedBreakerAttributeChips(): Promise<void> {
  console.log(`Seeding ${BREAKER_ATTRIBUTE_CHIPS.length} Breaker Attribute chip answers…`);

  for (const { label, answer } of BREAKER_ATTRIBUTE_CHIPS) {
    process.stdout.write(`  [${label}] upserting… `);

    await db
      .insert(quickLookupCacheTable)
      .values({ label, answer, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: quickLookupCacheTable.label,
        set: { answer, updatedAt: new Date() },
      });

    console.log("done");
  }

  console.log("Breaker Attribute chip seed complete.");
}
