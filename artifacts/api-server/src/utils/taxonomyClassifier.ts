/**
 * Hybrid taxonomy classifier — pure rule-based first pass.
 *
 * Given an inventory item (vendor + catalog + description + aiKeywords) and a
 * flat list of taxonomy nodes (the seeded `category_node` rows), pick the
 * single best leaf "type" node. The rules look at catalog patterns first
 * (most reliable) and fall back to keyword/description matches.
 *
 * If no rule fires we return null and the caller is free to escalate to an
 * AI fallback (see /categories/classify endpoint).
 */

export interface ClassifierItem {
  id?: number;
  vendor: string;
  catalog: string;
  description: string | null;
  aiKeywords?: string[] | null;
}

export interface ClassifierNode {
  id: number;
  parentId: number | null;
  level: string; // "category" | "subcategory" | "type"
  name: string;
  slug: string;
}

export interface ClassifierResult {
  /** Slug of the chosen "type" node (or higher level if no type matched). */
  nodeSlug: string;
  /** Slug of the type-level ancestor (same as nodeSlug when leaf was matched). */
  typeSlug: string | null;
  subcategorySlug: string | null;
  categorySlug: string | null;
  /** 0-1 score; deterministic rule hits use 0.9-1.0, soft keyword hits 0.5-0.8. */
  confidence: number;
  /** Short human-readable reason for the assignment (for debugging/UX). */
  ruleHit: string;
}

/* ── Rule definitions ─────────────────────────────────────────────────────── */

interface Rule {
  /** Slug of the leaf "type" node this rule maps to. Must exist in tree. */
  typeSlug: string;
  /** Catalog regex (case-insensitive). Matching catalog → confidence 0.95. */
  catalogPattern?: RegExp;
  /** All of these keywords must appear in lower-cased fullText. */
  allKeywords?: string[];
  /** ANY of these keywords appearing in fullText is a hit (confidence 0.7). */
  anyKeywords?: string[];
  /** Vendor short codes that boost the rule. */
  vendors?: string[];
}

/**
 * Rules are evaluated in order. The first matching rule wins. Order matters
 * — put the most specific / most reliable patterns at the top.
 */
export const CLASSIFIER_RULES: Rule[] = [
  // ── Breakers (most reliable: catalog-pattern based) ──────────────────────
  // GFCI/AFCI breakers must mention "breaker" alongside the GFCI/AFCI keyword,
  // OR the catalog must match the breaker-specific prefixes. Otherwise a "GFCI
  // receptacle" would wrongly land here because it shares the GFCI keyword.
  // Eaton GFCI breakers end in `GF` (e.g. BRP120GF, CHFN240GF). Square D /
  // Cutler-Hammer GFCI breakers start with QPF/GFTCB/HOMGFCBP. The catalog
  // pattern alone is enough — no keyword required.
  { typeSlug: "breaker-gfci", catalogPattern: /(^(QPF|GFTCB|HOMGFCBP)\d|GFI?$)/i },
  { typeSlug: "breaker-gfci", allKeywords: ["gfci", "breaker"] },
  { typeSlug: "breaker-afci", catalogPattern: /(^(BRA|BRAF|HOMA|QOA)\d|AFI?$)/i },
  { typeSlug: "breaker-afci", allKeywords: ["afci", "breaker"] },
  { typeSlug: "breaker-standard", catalogPattern: /^(BR|QO|CH|HOM|THQL|TNL|MP|FH|HH|Q1|EHB|QBH)\d{1,3}$/i, anyKeywords: ["breaker", "circuit breaker"] },
  { typeSlug: "breaker-standard", anyKeywords: ["breaker", "circuit breaker"] },

  // ── Wire & cable ─────────────────────────────────────────────────────────
  { typeSlug: "wire-thhn", anyKeywords: ["thhn", "thwn", "building wire"], catalogPattern: /THHN|THWN/i },
  { typeSlug: "wire-romex", anyKeywords: ["romex", "nm-b", "nm cable", "non-metallic"], catalogPattern: /^(NM|RX)\d/i },
  { typeSlug: "wire-mc", anyKeywords: ["mc cable", "metal clad", "armored cable", "bx"], catalogPattern: /^(MC|AC|BX)\d/i },
  { typeSlug: "wire-uf", anyKeywords: ["uf cable", "underground feeder", "direct burial cable"], catalogPattern: /^UF\d/i },
  { typeSlug: "wire-ser", anyKeywords: ["ser cable", "service entrance"], catalogPattern: /^(SE|SER)\d/i },
  { typeSlug: "wire-other", anyKeywords: ["wire", "cable", "conductor", "awg", "gauge"] },

  // ── Conduit & raceway ────────────────────────────────────────────────────
  { typeSlug: "conduit-emt", anyKeywords: ["emt", "thin wall conduit", "electrical metallic tubing"], catalogPattern: /EMT/i },
  { typeSlug: "conduit-pvc", anyKeywords: ["pvc conduit", "schedule 40", "schedule 80", "plastic conduit"], catalogPattern: /PVC/i },
  { typeSlug: "conduit-rmc", anyKeywords: ["rmc", "rigid metal conduit", "galvanized rigid"], catalogPattern: /RMC|GRC/i },
  { typeSlug: "conduit-imc", anyKeywords: ["imc", "intermediate metal conduit"], catalogPattern: /IMC/i },
  { typeSlug: "conduit-fmc", anyKeywords: ["fmc", "flexible metal conduit", "greenfield", "flex conduit"], catalogPattern: /FMC|LFMC/i },
  { typeSlug: "conduit-ent", anyKeywords: ["ent", "smurf tube", "blue conduit", "electrical nonmetallic"], catalogPattern: /ENT/i },
  { typeSlug: "conduit-other", anyKeywords: ["conduit", "raceway", "tubing"] },

  // ── Conduit fittings ─────────────────────────────────────────────────────
  { typeSlug: "fitting-coupling", anyKeywords: ["coupling", "conduit coupling"] },
  { typeSlug: "fitting-elbow", anyKeywords: ["elbow", "90 degree", "45 degree", "conduit elbow"] },
  { typeSlug: "fitting-connector", anyKeywords: ["connector", "conduit connector", "compression connector", "set screw connector"] },
  { typeSlug: "fitting-condulet", anyKeywords: ["condulet", "lb body", "conduit body", "ll body", "lr body"] },
  { typeSlug: "fitting-strap", anyKeywords: ["strap", "conduit strap", "one hole strap", "two hole strap"] },
  { typeSlug: "fitting-other", anyKeywords: ["fitting", "bushing", "locknut", "reducer"] },

  // ── Receptacles & outlets ────────────────────────────────────────────────
  // GFCI receptacle requires "receptacle" or "outlet" alongside "gfci" — the
  // bare "gfci" keyword is too noisy (matches breakers, wallplate covers, etc).
  { typeSlug: "receptacle-gfci", anyKeywords: ["gfci receptacle", "gfci outlet", "gfci recpt"], catalogPattern: /^(GFTR|GFNT|GF15|GF20)\d/i },
  { typeSlug: "receptacle-usb", anyKeywords: ["usb outlet", "usb receptacle", "usb charger outlet"] },
  { typeSlug: "receptacle-duplex", anyKeywords: ["duplex receptacle", "duplex outlet", "duplex"], catalogPattern: /^(DR|CR|TR|HBL|5\d{3}|62\d{2})/i },
  { typeSlug: "receptacle-twist-lock", anyKeywords: ["twist lock", "twistlock", "locking receptacle", "locking outlet"] },
  { typeSlug: "receptacle-range", anyKeywords: ["range receptacle", "dryer receptacle", "50 amp receptacle"] },
  { typeSlug: "receptacle-other", anyKeywords: ["receptacle", "outlet", "plug", "socket"] },

  // ── Switches & dimmers ───────────────────────────────────────────────────
  { typeSlug: "switch-dimmer", anyKeywords: ["dimmer", "dimmer switch", "lutron dimmer"] },
  { typeSlug: "switch-3way", anyKeywords: ["3 way switch", "three way switch", "spdt switch"] },
  { typeSlug: "switch-4way", anyKeywords: ["4 way switch", "four way switch"] },
  { typeSlug: "switch-occupancy", anyKeywords: ["occupancy sensor", "motion switch", "vacancy sensor"] },
  { typeSlug: "switch-toggle", anyKeywords: ["toggle switch", "single pole switch", "1 pole switch", "wall switch"] },
  { typeSlug: "switch-other", anyKeywords: ["switch"] },

  // ── Boxes & enclosures ───────────────────────────────────────────────────
  { typeSlug: "box-junction", anyKeywords: ["junction box", "j box", "splice box", "pull box"] },
  { typeSlug: "box-device", anyKeywords: ["device box", "switch box", "outlet box", "single gang", "double gang", "1 gang", "2 gang", "3 gang", "4 gang"] },
  { typeSlug: "box-weatherproof", anyKeywords: ["weatherproof box", "wp box", "outdoor box", "in use cover"] },
  { typeSlug: "box-floor", anyKeywords: ["floor box"] },
  { typeSlug: "box-fan", anyKeywords: ["fan box", "ceiling fan box"] },
  { typeSlug: "box-other", anyKeywords: ["box", "enclosure"] },

  // ── Panels, transformers, fuses ──────────────────────────────────────────
  { typeSlug: "panel-loadcenter", anyKeywords: ["load center", "loadcenter", "panelboard", "main panel"] },
  { typeSlug: "panel-meter", anyKeywords: ["meter socket", "meter base", "meter main"] },
  { typeSlug: "panel-other", anyKeywords: ["panel"] },
  { typeSlug: "transformer-control", anyKeywords: ["control transformer", "buck boost", "isolation transformer"], catalogPattern: /^V\d+M\d+/i },
  { typeSlug: "transformer-other", anyKeywords: ["transformer"] },
  { typeSlug: "fuse-cartridge", anyKeywords: ["cartridge fuse", "ferrule fuse", "midget fuse"] },
  { typeSlug: "fuse-glass", anyKeywords: ["glass fuse", "agc", "agu fuse"] },
  { typeSlug: "fuse-other", anyKeywords: ["fuse"] },

  // ── Lighting ─────────────────────────────────────────────────────────────
  { typeSlug: "lighting-led-bulb", anyKeywords: ["led bulb", "led lamp", "a19 led", "br30 led", "par led"] },
  { typeSlug: "lighting-fluorescent", anyKeywords: ["fluorescent", "t5", "t8", "t12", "cfl"] },
  { typeSlug: "lighting-fixture", anyKeywords: ["fixture", "luminaire", "troffer", "high bay", "wall pack", "exit sign"] },
  { typeSlug: "lighting-recessed", anyKeywords: ["recessed", "can light", "downlight"] },
  { typeSlug: "lighting-other", anyKeywords: ["light", "lamp", "bulb"] },

  // ── Connectors & terminations ────────────────────────────────────────────
  { typeSlug: "connector-wirenut", anyKeywords: ["wire nut", "wirenut", "twist on connector"] },
  { typeSlug: "connector-lug", anyKeywords: ["lug", "compression lug", "mechanical lug", "battery lug"] },
  { typeSlug: "connector-terminal", anyKeywords: ["terminal block", "terminal strip", "ring terminal", "spade terminal"] },
  { typeSlug: "connector-other", anyKeywords: ["connector", "splice"] },

  // ── Motors / sensors / misc ──────────────────────────────────────────────
  { typeSlug: "motor-control", anyKeywords: ["motor starter", "contactor", "vfd", "variable frequency drive"] },
  { typeSlug: "sensor-photo", anyKeywords: ["photocell", "photo sensor", "light sensor"] },
];

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function buildText(item: ClassifierItem): string {
  return [
    item.vendor,
    item.catalog,
    item.description ?? "",
    ...(item.aiKeywords ?? []),
  ].join(" ").toLowerCase();
}

interface NodeIndex {
  bySlug: Map<string, ClassifierNode>;
  /** Map a leaf slug → its (subcategorySlug, categorySlug). */
  ancestors: Map<string, { subcategorySlug: string | null; categorySlug: string | null }>;
}

export function buildNodeIndex(nodes: ClassifierNode[]): NodeIndex {
  const bySlug = new Map<string, ClassifierNode>();
  const byId = new Map<number, ClassifierNode>();
  for (const n of nodes) {
    bySlug.set(n.slug, n);
    byId.set(n.id, n);
  }

  const ancestors = new Map<string, { subcategorySlug: string | null; categorySlug: string | null }>();
  for (const n of nodes) {
    if (n.level !== "type") continue;
    const sub = n.parentId !== null ? byId.get(n.parentId) ?? null : null;
    const cat = sub?.parentId !== null && sub?.parentId !== undefined ? byId.get(sub.parentId) ?? null : null;
    ancestors.set(n.slug, {
      subcategorySlug: sub?.slug ?? null,
      categorySlug: cat?.slug ?? null,
    });
  }
  return { bySlug, ancestors };
}

/**
 * Classify a single inventory item against the seeded taxonomy. Returns
 * `null` if no rule matched — the caller may then send the item to AI.
 */
export function classifyItem(
  item: ClassifierItem,
  index: NodeIndex,
): ClassifierResult | null {
  const text = buildText(item);

  for (const rule of CLASSIFIER_RULES) {
    let confidence = 0;
    let reason = "";

    const catalogHit = rule.catalogPattern ? rule.catalogPattern.test(item.catalog) : false;
    if (catalogHit) {
      confidence = 0.95;
      reason = `catalog pattern ${rule.catalogPattern}`;
    }

    if (rule.allKeywords) {
      const allHit = rule.allKeywords.every(k => text.includes(k.toLowerCase()));
      if (allHit) {
        confidence = Math.max(confidence, 0.85);
        reason = reason || `all keywords matched: ${rule.allKeywords.join(", ")}`;
      } else if (!catalogHit) {
        // Skip rule if allKeywords specified but didn't all match and no catalog hit.
        continue;
      }
    }

    if (rule.anyKeywords && confidence === 0) {
      const hit = rule.anyKeywords.find(k => text.includes(k.toLowerCase()));
      if (hit) {
        confidence = 0.7;
        reason = `keyword "${hit}"`;
      }
    }

    if (confidence === 0) continue;

    const node = index.bySlug.get(rule.typeSlug);
    if (!node) continue; // taxonomy doesn't have this leaf — skip

    const anc = index.ancestors.get(rule.typeSlug) ?? {
      subcategorySlug: null,
      categorySlug: null,
    };

    return {
      nodeSlug: rule.typeSlug,
      typeSlug: rule.typeSlug,
      subcategorySlug: anc.subcategorySlug,
      categorySlug: anc.categorySlug,
      confidence,
      ruleHit: reason,
    };
  }

  return null;
}
