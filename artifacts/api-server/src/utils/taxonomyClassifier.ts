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

// Rules are evaluated in order; first match wins. Within each group the most
// specific rules come first and "*-other" catch-alls come last.
export const CLASSIFIER_RULES: Rule[] = [
  // ── BREAKERS (catalog-pattern first — highest precision)
  { typeSlug: 'breaker-gfci', catalogPattern: /(^(QPF|GFTCB|HOMGFCBP)\d|GFI?$)/i },
  { typeSlug: 'breaker-gfci', allKeywords: ['gfci', 'breaker'] },
  { typeSlug: 'breaker-afci', catalogPattern: /(^(BRA|BRAF|HOMA|QOA)\d|AFI?$)/i },
  { typeSlug: 'breaker-afci', allKeywords: ['afci', 'breaker'] },
  {
    typeSlug: 'breaker-standard',
    catalogPattern: /^(BR|QO|CH|HOM|THQL|TNL|MP|FH|HH|Q1|EHB|QBH)\d{1,3}$/i,
    anyKeywords: ['breaker', 'circuit breaker'],
  },
  { typeSlug: 'breaker-standard', anyKeywords: ['breaker', 'circuit breaker'] },

  // ── HVAC — early so hvac-thermostat beats sensor-temp, hvac-fuse-block beats fuse-other
  {
    typeSlug: 'hvac-thermostat',
    anyKeywords: [
      'thermostat',
      't-stat',
      'programmable thermostat',
      'smart thermostat',
      'heat pump thermostat',
    ],
  },
  {
    typeSlug: 'hvac-contactor',
    anyKeywords: ['hvac contactor', 'compressor contactor', 'ac contactor', 'hvac relay'],
  },
  {
    typeSlug: 'hvac-control-other',
    anyKeywords: ['hvac control', 'defrost control', 'hvac board'],
  },
  {
    typeSlug: 'hvac-motor',
    anyKeywords: [
      'hvac motor',
      'blower motor',
      'condenser fan motor',
      'evaporator motor',
      'ecm motor',
    ],
  },
  {
    typeSlug: 'hvac-capacitor',
    anyKeywords: ['run capacitor', 'start capacitor', 'dual round capacitor', 'hvac capacitor'],
  },
  { typeSlug: 'hvac-component-other', anyKeywords: ['hvac component', 'air handler', 'condenser'] },
  {
    typeSlug: 'hvac-disconnect-switch',
    anyKeywords: [
      'ac disconnect',
      'hvac disconnect',
      'air conditioner disconnect',
      'ac unit disconnect',
    ],
  },
  {
    typeSlug: 'hvac-fuse-block',
    anyKeywords: ['fuse block', 'fuse holder', 'fuse pull out', 'pullout fuse'],
  },
  {
    typeSlug: 'hvac-protection-other',
    anyKeywords: ['hvac fuse', 'hvac breaker', 'hvac protection'],
  },

  // ── WIRE & CABLE — specific types first, wire-other last

  // Standard building wire
  {
    typeSlug: 'wire-thhn',
    anyKeywords: ['thhn', 'thwn', 'building wire'],
    catalogPattern: /THHN|THWN/i,
  },
  {
    typeSlug: 'wire-romex',
    anyKeywords: ['romex', 'nm-b', 'nm cable', 'non-metallic'],
    catalogPattern: /^(NM|RX)\d/i,
  },
  {
    typeSlug: 'wire-mc',
    anyKeywords: ['mc cable', 'metal clad', 'armored cable', 'bx'],
    catalogPattern: /^(MC|AC|BX)\d/i,
  },
  {
    typeSlug: 'wire-uf',
    anyKeywords: ['uf cable', 'underground feeder', 'direct burial cable'],
    catalogPattern: /^UF\d/i,
  },
  {
    typeSlug: 'wire-ser',
    anyKeywords: ['ser cable', 'service entrance'],
    catalogPattern: /^(SE|SER)\d/i,
  },

  // Specialty wire (before wire-other)
  {
    typeSlug: 'wire-control',
    anyKeywords: [
      'control cable',
      'instrumentation cable',
      'shielded control cable',
      'tffn control',
    ],
    catalogPattern: /^(TC|TRAY|18\/\d|16\/\d|14\/\d)\s/i,
  },
  {
    typeSlug: 'wire-tray',
    anyKeywords: ['tray cable', 'tc cable', 'power limited tray'],
    catalogPattern: /^(TC-ER|TRAY-|PLTC)/i,
  },
  {
    typeSlug: 'wire-welding',
    anyKeywords: ['welding cable', 'welding lead', 'battery cable', 'booster cable'],
    catalogPattern: /WELD|BATT-CABLE/i,
  },
  // Note: "thermostat wire" excluded here — hvac-thermostat already catches it above
  {
    typeSlug: 'wire-low-voltage',
    anyKeywords: [
      'thermostat wire',
      'low voltage wire',
      '18 2 wire',
      '18-2 wire',
      'thermostat cable',
      'hvac wire',
    ],
    catalogPattern: /^(18\/2|18-2|20\/2|20-2|THERM)/i,
  },
  {
    typeSlug: 'wire-specialty-other',
    anyKeywords: [
      'specialty cable',
      'fire alarm cable',
      'security cable',
      'audio cable',
      'speaker wire',
    ],
  },

  // Line construction wire (before wire-other)
  {
    typeSlug: 'wire-triplex',
    anyKeywords: ['triplex', 'quadruplex', 'urd triplex', 'secondary urd'],
    catalogPattern: /TRIPLEX|QUAD[RU]|URD-/i,
  },
  {
    typeSlug: 'wire-aac',
    anyKeywords: ['aac cable', 'acsr', 'overhead conductor', 'aluminum conductor'],
    catalogPattern: /^AAC|^ACSR/i,
  },
  {
    typeSlug: 'wire-overhead-other',
    anyKeywords: ['overhead wire', 'span wire', 'messenger wire'],
  },

  // Telecom cable (before wire-other which matches "cable")
  {
    typeSlug: 'cable-cat5e',
    anyKeywords: ['cat 5e', 'cat5e', 'category 5e', 'category5e'],
    catalogPattern: /CAT5E|CAT-5E/i,
  },
  {
    typeSlug: 'cable-cat6',
    anyKeywords: ['cat 6', 'cat6', 'cat 6a', 'cat6a', 'category 6'],
    catalogPattern: /CAT6|CAT-6/i,
  },
  {
    typeSlug: 'cable-fiber',
    anyKeywords: [
      'fiber optic',
      'fibre optic',
      'optical fiber',
      'om3 fiber',
      'om4 fiber',
      'single mode fiber',
    ],
    catalogPattern: /FIBER|FIBRE|OPTICAL/i,
  },
  {
    typeSlug: 'cable-coax',
    anyKeywords: ['coaxial cable', 'coax cable', 'rg6 cable', 'rg11 cable', 'rg59 cable'],
    catalogPattern: /RG6|RG11|RG59|COAX/i,
  },
  {
    typeSlug: 'cable-telecom-other',
    anyKeywords: ['plenum cable', 'riser cable', 'cmp cable', 'cmr cable', 'data cable'],
  },

  // Catch-all — must remain last in wire group
  { typeSlug: 'wire-other', anyKeywords: ['wire', 'cable', 'conductor', 'awg', 'gauge'] },

  // ── CONDUIT & RACEWAY
  {
    typeSlug: 'conduit-emt',
    anyKeywords: ['emt', 'thin wall conduit', 'electrical metallic tubing'],
    catalogPattern: /EMT/i,
  },
  {
    typeSlug: 'conduit-pvc',
    anyKeywords: ['pvc conduit', 'schedule 40', 'schedule 80', 'plastic conduit'],
    catalogPattern: /PVC/i,
  },
  {
    typeSlug: 'conduit-rmc',
    anyKeywords: ['rmc', 'rigid metal conduit', 'galvanized rigid'],
    catalogPattern: /RMC|GRC/i,
  },
  {
    typeSlug: 'conduit-imc',
    anyKeywords: ['imc', 'intermediate metal conduit'],
    catalogPattern: /IMC/i,
  },
  // Liquidtight fittings must precede conduit-fmc: the LTFMC catalog prefix
  // matches conduit-fmc's /FMC|LFMC/ pattern but the product is a fitting, not conduit.
  {
    typeSlug: 'fitting-liquidtight-connector',
    anyKeywords: [
      'liquidtight connector',
      'liquid tight connector',
      'lfmc connector',
      'watertight connector',
    ],
    catalogPattern: /LT-|LTFMC|LIQT/i,
  },
  {
    typeSlug: 'fitting-liquidtight-other',
    anyKeywords: ['liquidtight fitting', 'liquid tight fitting'],
  },
  {
    typeSlug: 'conduit-fmc',
    anyKeywords: ['fmc', 'flexible metal conduit', 'greenfield', 'flex conduit'],
    catalogPattern: /FMC|LFMC/i,
  },
  {
    typeSlug: 'conduit-ent',
    anyKeywords: ['ent', 'smurf tube', 'blue conduit', 'electrical nonmetallic'],
    catalogPattern: /ENT/i,
  },
  // Wireways (before conduit-other which matches "raceway")
  {
    typeSlug: 'wireway-metal',
    anyKeywords: ['wireway', 'wiring duct', 'panduit duct', 'metal duct'],
  },
  { typeSlug: 'cable-tray-ladder', anyKeywords: ['ladder tray', 'cable tray ladder'] },
  {
    typeSlug: 'cable-tray-solid',
    anyKeywords: ['solid bottom tray', 'solid tray', 'cable tray solid'],
  },
  { typeSlug: 'wireway-other', anyKeywords: ['cable tray', 'raceway duct'] },
  // Catch-all
  { typeSlug: 'conduit-other', anyKeywords: ['conduit', 'raceway', 'tubing'] },

  // ── CONDUIT FITTINGS — grounding / liquidtight / reducer before fitting-other
  { typeSlug: 'fitting-coupling', anyKeywords: ['coupling', 'conduit coupling'] },
  { typeSlug: 'fitting-elbow', anyKeywords: ['elbow', '90 degree', '45 degree', 'conduit elbow'] },
  // fitting-connector uses specific multi-word phrases to avoid clashing with connector-other
  {
    typeSlug: 'fitting-connector',
    anyKeywords: ['conduit connector', 'compression connector', 'set screw connector'],
  },
  {
    typeSlug: 'fitting-condulet',
    anyKeywords: ['condulet', 'lb body', 'conduit body', 'll body', 'lr body'],
  },
  {
    typeSlug: 'fitting-strap',
    anyKeywords: ['strap', 'conduit strap', 'one hole strap', 'two hole strap'],
  },
  // Grounding fittings (before fitting-other which catches "bushing")
  {
    typeSlug: 'fitting-ground-rod',
    anyKeywords: ['ground rod', 'grounding rod', 'copper clad ground rod', 'ground electrode'],
    catalogPattern: /GR-|GND-ROD/i,
  },
  {
    typeSlug: 'fitting-ground-connector',
    anyKeywords: [
      'grounding clamp',
      'ground clamp',
      'acorn clamp',
      'grounding connector',
      'bonding connector',
      'ground lug',
    ],
    catalogPattern: /GBMC|GBC\d|GRND/i,
  },
  {
    typeSlug: 'fitting-ground-other',
    anyKeywords: ['grounding fitting', 'bonding fitting', 'ground bushing', 'bonding bushing'],
  },
  // Reducers (before fitting-other which catches "reducer", "bushing")
  {
    typeSlug: 'fitting-reducer',
    anyKeywords: [
      'conduit reducer',
      'reducing bushing',
      'conduit adapter',
      'emt to rigid',
      'chase nipple',
    ],
  },
  { typeSlug: 'fitting-nipple', anyKeywords: ['conduit nipple', 'nipple conduit'] },
  { typeSlug: 'fitting-reducer-other', anyKeywords: ['reducer', 'adapter fitting'] },
  // Catch-all
  { typeSlug: 'fitting-other', anyKeywords: ['fitting', 'bushing', 'locknut'] },

  // ── SURGE PROTECTION — before receptacles ("surge protector" items often mention "outlet")
  {
    typeSlug: 'surge-protector-panel',
    anyKeywords: [
      'whole house surge',
      'panel surge',
      'service entrance surge',
      'type 1 spd',
      'type 2 spd',
    ],
  },
  {
    typeSlug: 'surge-protector-point',
    anyKeywords: ['surge strip', 'surge protector', 'point of use surge'],
  },
  { typeSlug: 'surge-other', anyKeywords: ['surge', 'spd', 'transient voltage'] },

  // ── RECEPTACLES & OUTLETS
  {
    typeSlug: 'receptacle-gfci',
    anyKeywords: ['gfci receptacle', 'gfci outlet', 'gfci recpt'],
    catalogPattern: /^(GFTR|GFNT|GF15|GF20)\d/i,
  },
  {
    typeSlug: 'receptacle-usb',
    anyKeywords: ['usb outlet', 'usb receptacle', 'usb charger outlet'],
  },
  {
    typeSlug: 'receptacle-duplex',
    anyKeywords: ['duplex receptacle', 'duplex outlet', 'duplex'],
    catalogPattern: /^(DR|CR|TR|HBL|5\d{3}|62\d{2})/i,
  },
  {
    typeSlug: 'receptacle-twist-lock',
    anyKeywords: ['twist lock', 'twistlock', 'locking receptacle', 'locking outlet'],
  },
  {
    typeSlug: 'receptacle-range',
    anyKeywords: ['range receptacle', 'dryer receptacle', '50 amp receptacle'],
  },
  { typeSlug: 'receptacle-other', anyKeywords: ['receptacle', 'outlet', 'plug', 'socket'] },

  // ── SWITCHES & DIMMERS — pilot-selector, timer-switch, disconnect before switch-other
  { typeSlug: 'switch-dimmer', anyKeywords: ['dimmer', 'dimmer switch', 'lutron dimmer'] },
  { typeSlug: 'switch-3way', anyKeywords: ['3 way switch', 'three way switch', 'spdt switch'] },
  { typeSlug: 'switch-4way', anyKeywords: ['4 way switch', 'four way switch'] },
  {
    typeSlug: 'switch-occupancy',
    anyKeywords: ['occupancy sensor', 'motion switch', 'vacancy sensor'],
  },
  {
    typeSlug: 'switch-toggle',
    anyKeywords: ['toggle switch', 'single pole switch', '1 pole switch', 'wall switch'],
  },
  // Pilot devices that contain "switch" in keywords — must precede switch-other
  { typeSlug: 'pilot-selector', anyKeywords: ['selector switch', 'rotary switch', 'key switch'] },
  // Timer (contains "timer switch") — must precede switch-other
  {
    typeSlug: 'timer-switch',
    anyKeywords: ['timer switch', 'astronomic timer', 'time clock', 'mechanical timer'],
  },
  // Disconnects containing "disconnect switch" / "safety switch" — must precede switch-other
  {
    typeSlug: 'disconnect-fusible',
    anyKeywords: ['fusible safety switch', 'fusible disconnect', 'fusible switch'],
  },
  {
    typeSlug: 'disconnect-nonfusible',
    anyKeywords: ['non-fusible', 'nonfusible', 'safety disconnect', 'disconnect switch'],
  },
  { typeSlug: 'disconnect-other', anyKeywords: ['disconnect', 'safety switch'] },
  // Catch-all
  { typeSlug: 'switch-other', anyKeywords: ['switch'] },

  // ── BOXES & ENCLOSURES — covers first (cover-wallplate before box-device's "single gang"),
  //   NEMA enclosures before box-other's "enclosure"
  { typeSlug: 'cover-blank', anyKeywords: ['blank cover', 'blank plate', 'dead front'] },
  {
    typeSlug: 'cover-wallplate',
    anyKeywords: [
      'wall plate',
      'wallplate',
      'device plate',
      'faceplate',
      'decorator plate',
      'midway plate',
      'screwless plate',
    ],
  },
  {
    typeSlug: 'cover-weatherproof',
    anyKeywords: ['in use cover', 'in-use cover', 'weatherproof cover', 'while-in-use cover'],
  },
  {
    typeSlug: 'cover-box-cover',
    anyKeywords: ['extension ring', 'box cover', 'mud ring', 'raised cover'],
  },
  { typeSlug: 'cover-other', anyKeywords: ['cover plate', 'cover'] },
  // NEMA enclosures (before box-other which catches "enclosure")
  {
    typeSlug: 'enclosure-nema1',
    anyKeywords: ['nema 1', 'nema1', 'indoor enclosure', 'general duty enclosure'],
  },
  {
    typeSlug: 'enclosure-nema3r',
    anyKeywords: ['nema 3r', 'nema3r', 'rainproof enclosure', 'outdoor enclosure 3r'],
  },
  {
    typeSlug: 'enclosure-nema4',
    anyKeywords: [
      'nema 4x',
      'nema4x',
      'nema 4',
      'nema4',
      'watertight enclosure',
      'stainless enclosure',
    ],
    catalogPattern: /N4X|NEMA4/i,
  },
  { typeSlug: 'enclosure-nema-other', anyKeywords: ['nema enclosure', 'electrical enclosure'] },
  // Box types
  { typeSlug: 'box-junction', anyKeywords: ['junction box', 'j box', 'splice box', 'pull box'] },
  {
    typeSlug: 'box-device',
    anyKeywords: [
      'device box',
      'switch box',
      'outlet box',
      'single gang',
      'double gang',
      '1 gang',
      '2 gang',
      '3 gang',
      '4 gang',
    ],
  },
  { typeSlug: 'box-weatherproof', anyKeywords: ['weatherproof box', 'wp box', 'outdoor box'] },
  { typeSlug: 'box-floor', anyKeywords: ['floor box'] },
  { typeSlug: 'box-fan', anyKeywords: ['fan box', 'ceiling fan box'] },
  // Catch-all
  { typeSlug: 'box-other', anyKeywords: ['box', 'enclosure'] },

  // ── PANELS, TRANSFORMERS, FUSES
  {
    typeSlug: 'panel-loadcenter',
    anyKeywords: ['load center', 'loadcenter', 'panelboard', 'main panel'],
  },
  { typeSlug: 'panel-meter', anyKeywords: ['meter socket', 'meter base', 'meter main'] },
  // Catch-all
  { typeSlug: 'panel-other', anyKeywords: ['panel'] },
  {
    typeSlug: 'transformer-control',
    anyKeywords: ['control transformer', 'buck boost', 'isolation transformer'],
    catalogPattern: /^V\d+M\d+/i,
  },
  { typeSlug: 'transformer-other', anyKeywords: ['transformer'] },
  { typeSlug: 'fuse-cartridge', anyKeywords: ['cartridge fuse', 'ferrule fuse', 'midget fuse'] },
  { typeSlug: 'fuse-glass', anyKeywords: ['glass fuse', 'agc', 'agu fuse'] },
  { typeSlug: 'fuse-other', anyKeywords: ['fuse'] },

  // ── LIGHTING — emergency/exit and controls before lighting-fixture / lighting-other
  {
    typeSlug: 'lighting-led-bulb',
    anyKeywords: ['led bulb', 'led lamp', 'a19 led', 'br30 led', 'par led'],
  },
  { typeSlug: 'lighting-fluorescent', anyKeywords: ['fluorescent', 't5', 't8', 't12', 'cfl'] },
  // Emergency & exit (before lighting-fixture and lighting-other)
  { typeSlug: 'lighting-exit-sign', anyKeywords: ['exit sign', 'exit light', 'combo exit'] },
  {
    typeSlug: 'lighting-emergency-unit',
    anyKeywords: [
      'emergency light',
      'emergency lighting unit',
      'bug eye light',
      'emergency backup',
    ],
  },
  {
    typeSlug: 'lighting-emergency-other',
    anyKeywords: ['emergency egress', 'emergency luminaire'],
  },
  // Lighting controls (before lighting-other which catches "light")
  {
    typeSlug: 'lighting-ctrl-daylight',
    anyKeywords: ['daylight sensor', 'astronomical timer', 'dusk to dawn', 'photocell control'],
  },
  {
    typeSlug: 'lighting-ctrl-motion',
    anyKeywords: [
      'motion sensor light',
      'motion control',
      'occupancy controlled lighting',
      'pir sensor',
    ],
  },
  {
    typeSlug: 'lighting-ctrl-dimmer',
    anyKeywords: ['lighting dimmer', '0-10v dimmer', 'trailing edge dimmer', 'leading edge dimmer'],
  },
  {
    typeSlug: 'lighting-ctrl-other',
    anyKeywords: ['lighting control', 'light control', 'daylight control'],
  },
  // Standard fixture types ("exit sign" removed — now handled by lighting-exit-sign above)
  {
    typeSlug: 'lighting-fixture',
    anyKeywords: ['fixture', 'luminaire', 'troffer', 'high bay', 'wall pack'],
  },
  { typeSlug: 'lighting-recessed', anyKeywords: ['recessed', 'can light', 'downlight'] },
  // Catch-all
  { typeSlug: 'lighting-other', anyKeywords: ['light', 'lamp', 'bulb'] },

  // ── CONNECTORS & TERMINATIONS — structural connectors before connector-other
  { typeSlug: 'connector-wirenut', anyKeywords: ['wire nut', 'wirenut', 'twist on connector'] },
  {
    typeSlug: 'connector-lug',
    anyKeywords: ['lug', 'compression lug', 'mechanical lug', 'battery lug'],
  },
  {
    typeSlug: 'connector-terminal',
    anyKeywords: ['terminal block', 'terminal strip', 'ring terminal', 'spade terminal'],
  },
  // Structural connectors (before connector-other which catches "connector")
  {
    typeSlug: 'connector-beam-clamp',
    anyKeywords: ['beam clamp', 'pipe clamp', 'c-clamp', 'i-beam clamp'],
  },
  {
    typeSlug: 'connector-cable-tray-conn',
    anyKeywords: ['cable tray connector', 'tray splice plate'],
  },
  {
    typeSlug: 'connector-strut-conn',
    anyKeywords: [
      'strut fitting',
      'unistrut fitting',
      'superstrut',
      'strut connector',
      'channel nut',
      'framing connector',
    ],
  },
  {
    typeSlug: 'connector-structural-other',
    anyKeywords: ['structural connector', 'post base', 'joist hanger'],
  },
  // Telecom jacks (before connector-other which catches "connector")
  {
    typeSlug: 'jack-rj45',
    anyKeywords: ['rj45', 'rj-45', 'keystone jack', 'keystone module', 'ethernet jack'],
  },
  {
    typeSlug: 'jack-coax',
    anyKeywords: ['f connector', 'coax connector', 'coax splitter', 'rg6 connector', 'f-type'],
  },
  {
    typeSlug: 'jack-other',
    anyKeywords: ['data jack', 'voice jack', 'telecom jack', 'rj11', 'rj-11'],
  },
  // Catch-all
  { typeSlug: 'connector-other', anyKeywords: ['connector', 'splice'] },

  // ── MOTORS, CONTROLS & SENSORS
  {
    typeSlug: 'motor-control',
    anyKeywords: ['motor starter', 'contactor', 'vfd', 'variable frequency drive'],
  },
  { typeSlug: 'sensor-photo', anyKeywords: ['photocell', 'photo sensor', 'light sensor'] },
  {
    typeSlug: 'relay-control',
    anyKeywords: ['control relay', 'ice cube relay', 'dpdt relay', 'spdt relay'],
  },
  { typeSlug: 'relay-other', anyKeywords: ['relay'] },
  // sensor-temp: "thermostat" removed here — hvac-thermostat fires first above
  { typeSlug: 'sensor-temp', anyKeywords: ['temperature sensor', 'temp sensor'] },
  {
    typeSlug: 'sensor-current',
    anyKeywords: ['current sensor', 'ct clamp', 'current transformer', 'current transducer'],
  },
  { typeSlug: 'sensor-other', anyKeywords: ['sensor', 'transducer', 'detector'] },
  {
    typeSlug: 'pilot-pushbutton',
    anyKeywords: ['push button', 'pushbutton', 'momentary button', 'e-stop button'],
  },
  {
    typeSlug: 'pilot-indicator',
    anyKeywords: ['pilot light', 'indicator light', 'stack light', 'tower light'],
  },
  // pilot-selector already placed in switches section above (before switch-other)
  { typeSlug: 'pilot-other', anyKeywords: ['pilot device', 'operator', 'control station'] },

  // ── BUILDERS PRODUCTS — strut / cable management / hangers
  {
    typeSlug: 'strut-channel',
    anyKeywords: ['strut channel', 'unistrut', 'superstrut', 'b-line channel', 'framing channel'],
    catalogPattern: /^(P1000|P1001|B22|B12)/i,
  },
  {
    typeSlug: 'strut-fitting',
    anyKeywords: ['strut fitting', 'strut nut', 'channel nut', 'strut clamp', 'unistrut nut'],
  },
  { typeSlug: 'strut-other', anyKeywords: ['strut', 'framing rail', 'slotted channel'] },
  {
    typeSlug: 'cable-tie',
    anyKeywords: ['cable tie', 'zip tie', 'tie wrap', 'wire tie', 'nylon tie'],
  },
  {
    typeSlug: 'cable-staple',
    anyKeywords: ['cable staple', 'cable clip', 'wire staple', 'romex staple', 'nm staple'],
  },
  { typeSlug: 'cable-duct', anyKeywords: ['cable duct', 'wiring duct', 'wire management duct'] },
  {
    typeSlug: 'cable-management-other',
    anyKeywords: ['cable management', 'wire loom', 'split loom', 'corrugated loom'],
  },
  {
    typeSlug: 'hanger-rod',
    anyKeywords: ['hanger rod', 'all-thread hanger', 'drop rod', 'support rod'],
  },
  { typeSlug: 'hanger-beam', anyKeywords: ['beam hanger', 'trapeze hanger', 'trapeze support'] },
  {
    typeSlug: 'hanger-pipe',
    anyKeywords: ['pipe hanger', 'pipe clamp', 'pipe strap', 'conduit hanger'],
  },
  { typeSlug: 'hanger-other', anyKeywords: ['hanger', 'support bracket', 'j hook', 'j-hook'] },

  // ── LINE CONSTRUCTION
  {
    typeSlug: 'pole-insulator',
    anyKeywords: ['insulator', 'pin insulator', 'spool insulator', 'strain insulator'],
  },
  {
    typeSlug: 'pole-clamp',
    anyKeywords: ['deadend clamp', 'strain clamp', 'guy clamp', 'dead end'],
  },
  {
    typeSlug: 'pole-hardware-other',
    anyKeywords: ['pole hardware', 'crossarm', 'pole band', 'bolt machine'],
  },
  {
    typeSlug: 'urd-cable',
    anyKeywords: [
      'urd cable',
      'underground distribution cable',
      '15kv cable',
      '25kv cable',
      '35kv cable',
    ],
  },
  {
    typeSlug: 'urd-splice',
    anyKeywords: ['urd splice', 'cable splice kit', 'inline splice', 'termination kit'],
    catalogPattern: /SPLICE|TERM-KIT/i,
  },
  {
    typeSlug: 'urd-other',
    anyKeywords: ['underground distribution', 'pad mount', 'elbow connector medium voltage'],
  },

  // ── TELECOM — patch panels & enclosures
  {
    typeSlug: 'patch-panel',
    anyKeywords: ['patch panel', '24 port panel', '48 port panel', 'cat6 panel', 'cat5e panel'],
  },
  {
    typeSlug: 'telecom-enclosure',
    anyKeywords: [
      'telecom enclosure',
      'data enclosure',
      'network enclosure',
      'wall mount rack',
      'patch enclosure',
    ],
  },
  {
    typeSlug: 'telecom-enclosure-other',
    anyKeywords: ['network rack', 'server rack', 'cable management panel'],
  },

  // ── TOOLS & TESTERS
  {
    typeSlug: 'tool-pliers',
    anyKeywords: [
      'lineman pliers',
      'needle nose pliers',
      'wire stripper',
      'wire cutter',
      'diagonal cutter',
      'side cutter',
    ],
    catalogPattern: /^(J2000|J45|J939|NP)/i,
  },
  {
    typeSlug: 'tool-screwdriver',
    anyKeywords: ['screwdriver', 'nut driver', 'hex driver', 'insulated driver', 'torque driver'],
  },
  {
    typeSlug: 'tool-fish-tape',
    anyKeywords: ['fish tape', 'pulling tape', 'pull wire', 'fish wire', 'wire puller tape'],
  },
  {
    typeSlug: 'tool-conduit-bender',
    anyKeywords: ['conduit bender', 'pipe bender', 'hickey bender', 'emt bender'],
  },
  {
    typeSlug: 'tool-hand-other',
    anyKeywords: ['crimper', 'punch tool', 'knockout punch', 'ratchet crimper', 'wire mesh grip'],
  },
  {
    typeSlug: 'tester-multimeter',
    anyKeywords: ['multimeter', 'digital multimeter', 'dmm', 'fluke multimeter', 'voltmeter'],
  },
  {
    typeSlug: 'tester-clamp-meter',
    anyKeywords: ['clamp meter', 'amp clamp', 'clamp on meter', 'current clamp'],
  },
  {
    typeSlug: 'tester-circuit',
    anyKeywords: [
      'circuit tester',
      'voltage tester',
      'voltage detector',
      'non-contact tester',
      'solenoid tester',
    ],
  },
  {
    typeSlug: 'tester-continuity',
    anyKeywords: [
      'continuity tester',
      'wire tester',
      'cable tester',
      'tone generator',
      'toner probe',
    ],
  },
  {
    typeSlug: 'tester-other',
    anyKeywords: ['power quality meter', 'insulation tester', 'megohmmeter', 'ir thermometer'],
  },
  {
    typeSlug: 'tool-drill-bit',
    anyKeywords: ['drill bit', 'hole saw', 'spade bit', 'auger bit', 'ship auger'],
  },
  {
    typeSlug: 'tool-blade',
    anyKeywords: [
      'saw blade',
      'reciprocating blade',
      'jig saw blade',
      'cutting wheel',
      'abrasive disc',
    ],
  },
  {
    typeSlug: 'tool-power-acc-other',
    anyKeywords: ['power tool accessory', 'impact socket', 'extension bar', 'right angle drill'],
  },

  // ── ANCHORS & FASTENERS — after tools so "screw"/"bolt" substrings in tool names
  //   don't shadow screwdriver / knockout-punch rules above.
  //   anchor-other uses only compound phrases (not bare "bolt" or "screw") to
  //   avoid false-positive matches on vendor names or unrelated descriptions.
  {
    typeSlug: 'anchor-concrete',
    anyKeywords: [
      'concrete anchor',
      'masonry anchor',
      'wedge anchor',
      'sleeve anchor',
      'drop-in anchor',
    ],
    catalogPattern: /RAWL|HILTI|TAPCON/i,
  },
  {
    typeSlug: 'anchor-toggle',
    anyKeywords: ['toggle bolt', 'hollow wall anchor', 'molly bolt', 'wall anchor'],
  },
  {
    typeSlug: 'anchor-threaded-rod',
    anyKeywords: ['threaded rod', 'all thread', 'allthread', 'stud rod'],
  },
  {
    typeSlug: 'anchor-other',
    anyKeywords: [
      'anchor',
      'fastener',
      'lag bolt',
      'hex bolt',
      'machine screw',
      'self-tapping screw',
      'sheet metal screw',
    ],
  },
];

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function buildText(item: ClassifierItem): string {
  return [item.vendor, item.catalog, item.description ?? '', ...(item.aiKeywords ?? [])]
    .join(' ')
    .toLowerCase();
}

export interface NodeIndex {
  bySlug: Map<string, ClassifierNode>;
  byId: Map<number, ClassifierNode>;
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

  const ancestors = new Map<
    string,
    { subcategorySlug: string | null; categorySlug: string | null }
  >();
  for (const n of nodes) {
    if (n.level !== 'type') continue;
    const sub = n.parentId !== null ? (byId.get(n.parentId) ?? null) : null;
    const cat =
      sub?.parentId !== null && sub?.parentId !== undefined
        ? (byId.get(sub.parentId) ?? null)
        : null;
    ancestors.set(n.slug, {
      subcategorySlug: sub?.slug ?? null,
      categorySlug: cat?.slug ?? null,
    });
  }
  return { bySlug, byId, ancestors };
}

/**
 * Classify a single inventory item against the seeded taxonomy. Returns
 * `null` if no rule matched — the caller may then send the item to AI.
 */
export function classifyItem(item: ClassifierItem, index: NodeIndex): ClassifierResult | null {
  const text = buildText(item);

  for (const rule of CLASSIFIER_RULES) {
    let confidence = 0;
    let reason = '';

    const catalogHit = rule.catalogPattern ? rule.catalogPattern.test(item.catalog) : false;
    if (catalogHit) {
      confidence = 0.95;
      reason = `catalog pattern ${rule.catalogPattern}`;
    }

    if (rule.allKeywords) {
      const allHit = rule.allKeywords.every((k) => text.includes(k.toLowerCase()));
      if (allHit) {
        confidence = Math.max(confidence, 0.85);
        reason = reason || `all keywords matched: ${rule.allKeywords.join(', ')}`;
      } else if (!catalogHit) {
        // Skip rule if allKeywords specified but didn't all match and no catalog hit.
        continue;
      }
    }

    if (rule.anyKeywords && confidence === 0) {
      const hit = rule.anyKeywords.find((k) => text.includes(k.toLowerCase()));
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
