/**
 * Seeded three-level taxonomy.
 *
 * Top-level Categories follow the section structure of the Elliott
 * Electric Supply (EES) Product Catalog (June 2025) found in
 * `attached_assets/EES_Product_Catalog_(06.2025)_*.pdf`:
 *
 *   A. Distribution Equipment   → "breakers" + "panels-distribution"
 *   B. Wiring Devices           → "receptacles" + "switches"
 *   C. Lighting & Lighting Ctrl → "lighting"
 *   D. Wire & Cable             → "wire-cable"
 *   E. Conduit, Fittings, Boxes → "conduit-raceway" + "boxes-enclosures"
 *                                 + "connectors-terminations"
 *   F. Enclosures & Wireway     → covered by "boxes-enclosures"
 *   G. HVAC                     → not seen in current inventory
 *   H. Motor Control            → "motors-controls-sensors"
 *   I. Harsh Locations          → folded into existing categories
 *   J. Datacom                  → not seen in current inventory
 *   K. Tools / Terminals / Fast → not seen in current inventory
 *   L. References               → not categorisable
 *
 * Subcategory + Type splits below were then refined from existing
 * dictionaries (CHIP_DIMS_SERVER, abbreviation map categories, vendor
 * patterns) and from real inventory shapes observed in the database.
 *
 * The classifier rules in `taxonomyClassifier.ts` map onto the leaf
 * "type" slugs defined here — keep them in sync.
 *
 * Idempotent: an existing slug is left alone, missing slugs are
 * inserted, and node names/sort_order are updated in place.
 */

import { eq, sql } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { db, categoryNodeTable } from '@workspace/db';

interface SeedType {
  slug: string;
  name: string;
}
interface SeedSubcategory {
  slug: string;
  name: string;
  types: SeedType[];
}
interface SeedCategory {
  slug: string;
  name: string;
  subcategories: SeedSubcategory[];
}

// Default seed taxonomy derived from the EES Product Catalog PDF.
// Overridden at seed time by attached_assets/eesTaxonomy.json if present
// (see loadTaxonomySource).
//
// Full 17-category EES hierarchy (June 2025 catalog):
//   1.  Anchors & Connectors     → anchors-connectors          (new)
//   2.  Boxes & Covers           → boxes-enclosures             (existing, covers sub added)
//   3.  Builders Products        → builders-products            (new)
//   4.  Conduit & Raceways       → conduit-raceway              (existing, wireways sub added)
//   5.  Controls                 → motors-controls-sensors      (existing, new subs added)
//   6.  Distribution Equipment   → panels-distribution          (existing, new subs added)
//                                  + breakers                   (existing)
//   7.  Fittings                 → fittings                     (new top-level for non-conduit fittings)
//   8.  Fuses                    → panels-distribution/fuses    (existing sub)
//   9.  HVAC                     → hvac                         (new)
//  10.  Lighting                 → lighting                     (existing, controls sub added)
//  11.  Line Construction        → line-construction            (new)
//  12.  Telecom                  → telecom                      (new)
//  13.  Tools & Testers          → tools-testers                (new)
//  14.  Wire                     → wire-cable                   (existing, specialty sub added)
//  15.  Wiring Devices           → receptacles + switches       (existing)
export const SEED_TAXONOMY: SeedCategory[] = [
  // ── 1. Anchors & Connectors (new) ─────────────────────────────────────
  {
    slug: 'anchors-connectors',
    name: 'Anchors & Connectors',
    subcategories: [
      {
        slug: 'anchors',
        name: 'Anchors & Fasteners',
        types: [
          { slug: 'anchor-concrete', name: 'Concrete / Masonry Anchors' },
          { slug: 'anchor-toggle', name: 'Toggle Bolts & Hollow-Wall Anchors' },
          { slug: 'anchor-threaded-rod', name: 'Threaded Rod & Studs' },
          { slug: 'anchor-other', name: 'Other Anchors & Fasteners' },
        ],
      },
      {
        slug: 'structural-connectors',
        name: 'Structural Connectors',
        types: [
          { slug: 'connector-beam-clamp', name: 'Beam Clamps & Pipe Clamps' },
          { slug: 'connector-cable-tray-conn', name: 'Cable Tray Connectors' },
          { slug: 'connector-strut-conn', name: 'Strut / Unistrut Connectors' },
          { slug: 'connector-structural-other', name: 'Other Structural Connectors' },
        ],
      },
    ],
  },

  // ── 2. Boxes & Enclosures (existing — covers sub added) ───────────────
  {
    slug: 'boxes-enclosures',
    name: 'Boxes & Enclosures',
    subcategories: [
      {
        slug: 'boxes-by-type',
        name: 'By Type',
        types: [
          { slug: 'box-device', name: 'Device / Switch Boxes' },
          { slug: 'box-junction', name: 'Junction / Pull Boxes' },
          { slug: 'box-weatherproof', name: 'Weatherproof Boxes' },
          { slug: 'box-floor', name: 'Floor Boxes' },
          { slug: 'box-fan', name: 'Fan-Rated Boxes' },
          { slug: 'box-other', name: 'Other Boxes & Enclosures' },
        ],
      },
      {
        slug: 'covers-plates',
        name: 'Covers & Plates',
        types: [
          { slug: 'cover-blank', name: 'Blank Covers' },
          { slug: 'cover-wallplate', name: 'Wall Plates & Device Plates' },
          { slug: 'cover-weatherproof', name: 'Weatherproof In-Use Covers' },
          { slug: 'cover-box-cover', name: 'Box Covers & Extension Rings' },
          { slug: 'cover-other', name: 'Other Covers & Plates' },
        ],
      },
      {
        slug: 'nema-enclosures',
        name: 'NEMA Enclosures',
        types: [
          { slug: 'enclosure-nema1', name: 'NEMA 1 Enclosures (Indoor)' },
          { slug: 'enclosure-nema3r', name: 'NEMA 3R Enclosures (Rainproof)' },
          { slug: 'enclosure-nema4', name: 'NEMA 4 / 4X Enclosures (Watertight)' },
          { slug: 'enclosure-nema-other', name: 'Other NEMA Enclosures' },
        ],
      },
    ],
  },

  // ── 3. Builders Products (new) ─────────────────────────────────────────
  {
    slug: 'builders-products',
    name: 'Builders Products',
    subcategories: [
      {
        slug: 'strut-framing',
        name: 'Strut & Framing',
        types: [
          { slug: 'strut-channel', name: 'Strut Channel (Unistrut / Superstrut)' },
          { slug: 'strut-fitting', name: 'Strut Fittings & Nuts' },
          { slug: 'strut-other', name: 'Other Strut & Framing' },
        ],
      },
      {
        slug: 'cable-management',
        name: 'Cable Management',
        types: [
          { slug: 'cable-tie', name: 'Cable Ties & Zip Ties' },
          { slug: 'cable-staple', name: 'Cable Staples & Clips' },
          { slug: 'cable-duct', name: 'Cable Duct & Wiring Duct' },
          { slug: 'cable-management-other', name: 'Other Cable Management' },
        ],
      },
      {
        slug: 'supports-hangers',
        name: 'Supports & Hangers',
        types: [
          { slug: 'hanger-rod', name: 'Hanger Rods & All-Thread' },
          { slug: 'hanger-beam', name: 'Beam / Trapeze Hangers' },
          { slug: 'hanger-pipe', name: 'Pipe Hangers & Clamps' },
          { slug: 'hanger-other', name: 'Other Supports & Hangers' },
        ],
      },
    ],
  },

  // ── 4. Conduit & Raceways (existing — wireways sub added) ─────────────
  {
    slug: 'conduit-raceway',
    name: 'Conduit & Raceway',
    subcategories: [
      {
        slug: 'conduit-by-material',
        name: 'By Material',
        types: [
          { slug: 'conduit-emt', name: 'EMT' },
          { slug: 'conduit-pvc', name: 'PVC' },
          { slug: 'conduit-rmc', name: 'RMC / Rigid Metal' },
          { slug: 'conduit-imc', name: 'IMC' },
          { slug: 'conduit-fmc', name: 'FMC / Flexible Metal' },
          { slug: 'conduit-ent', name: 'ENT / Smurf Tube' },
          { slug: 'conduit-other', name: 'Other Conduit' },
        ],
      },
      {
        slug: 'conduit-fittings',
        name: 'Fittings',
        types: [
          { slug: 'fitting-coupling', name: 'Couplings' },
          { slug: 'fitting-elbow', name: 'Elbows' },
          { slug: 'fitting-connector', name: 'Connectors' },
          { slug: 'fitting-condulet', name: 'Condulets / Conduit Bodies' },
          { slug: 'fitting-strap', name: 'Straps & Hangers' },
          { slug: 'fitting-other', name: 'Other Fittings' },
        ],
      },
      {
        slug: 'wireways-cable-tray',
        name: 'Wireways & Cable Tray',
        types: [
          { slug: 'wireway-metal', name: 'Metal Wireways / Panduit Duct' },
          { slug: 'cable-tray-ladder', name: 'Ladder Cable Tray' },
          { slug: 'cable-tray-solid', name: 'Solid Bottom Cable Tray' },
          { slug: 'wireway-other', name: 'Other Wireways & Cable Tray' },
        ],
      },
    ],
  },

  // ── 5. Controls (existing: motors-controls-sensors — new subs added) ──
  {
    slug: 'motors-controls-sensors',
    name: 'Motors, Controls & Sensors',
    subcategories: [
      {
        slug: 'motor-controls',
        name: 'Motor Controls',
        types: [{ slug: 'motor-control', name: 'Starters / Contactors / VFDs' }],
      },
      {
        slug: 'relays-timers',
        name: 'Relays & Timers',
        types: [
          { slug: 'relay-control', name: 'Control Relays' },
          { slug: 'timer-switch', name: 'Timer Switches & Astronomic Timers' },
          { slug: 'relay-other', name: 'Other Relays & Timers' },
        ],
      },
      {
        slug: 'sensors',
        name: 'Sensors',
        types: [
          { slug: 'sensor-photo', name: 'Photocells / Light Sensors' },
          { slug: 'sensor-temp', name: 'Temperature Sensors & Thermostats' },
          { slug: 'sensor-current', name: 'Current Sensors & CT Clamps' },
          { slug: 'sensor-other', name: 'Other Sensors' },
        ],
      },
      {
        slug: 'pilot-devices',
        name: 'Pilot Devices',
        types: [
          { slug: 'pilot-pushbutton', name: 'Push Buttons' },
          { slug: 'pilot-indicator', name: 'Pilot Lights & Indicators' },
          { slug: 'pilot-selector', name: 'Selector Switches' },
          { slug: 'pilot-other', name: 'Other Pilot Devices' },
        ],
      },
    ],
  },

  // ── 6. Distribution Equipment (existing: panels-distribution + breakers)
  {
    slug: 'breakers',
    name: 'Breakers',
    subcategories: [
      {
        slug: 'breakers-by-type',
        name: 'By Type',
        types: [
          { slug: 'breaker-standard', name: 'Standard Circuit Breakers' },
          { slug: 'breaker-gfci', name: 'GFCI Breakers' },
          { slug: 'breaker-afci', name: 'AFCI Breakers' },
        ],
      },
    ],
  },
  {
    slug: 'panels-distribution',
    name: 'Panels & Distribution',
    subcategories: [
      {
        slug: 'panels-by-type',
        name: 'By Type',
        types: [
          { slug: 'panel-loadcenter', name: 'Load Centers / Panelboards' },
          { slug: 'panel-meter', name: 'Meter Sockets / Meter Mains' },
          { slug: 'panel-other', name: 'Other Panels' },
        ],
      },
      {
        slug: 'disconnects-switches',
        name: 'Disconnects & Safety Switches',
        types: [
          { slug: 'disconnect-fusible', name: 'Fusible Safety Switches' },
          { slug: 'disconnect-nonfusible', name: 'Non-Fusible Safety Switches' },
          { slug: 'disconnect-other', name: 'Other Disconnects' },
        ],
      },
      {
        slug: 'surge-protection',
        name: 'Surge Protection',
        types: [
          { slug: 'surge-protector-panel', name: 'Whole-House / Panel SPDs' },
          { slug: 'surge-protector-point', name: 'Point-of-Use Surge Protectors' },
          { slug: 'surge-other', name: 'Other Surge Protection' },
        ],
      },
      {
        slug: 'transformers',
        name: 'Transformers',
        types: [
          { slug: 'transformer-control', name: 'Control / Buck-Boost Transformers' },
          { slug: 'transformer-other', name: 'Other Transformers' },
        ],
      },
      {
        slug: 'fuses',
        name: 'Fuses',
        types: [
          { slug: 'fuse-cartridge', name: 'Cartridge Fuses' },
          { slug: 'fuse-glass', name: 'Glass / Automotive Fuses' },
          { slug: 'fuse-other', name: 'Other Fuses' },
        ],
      },
    ],
  },

  // ── 7. Fittings (new top-level — plumbing/structural fittings) ─────────
  {
    slug: 'fittings',
    name: 'Fittings',
    subcategories: [
      {
        slug: 'fittings-grounding',
        name: 'Grounding Fittings',
        types: [
          { slug: 'fitting-ground-rod', name: 'Ground Rods & Clamps' },
          { slug: 'fitting-ground-connector', name: 'Grounding Connectors & Clamps' },
          { slug: 'fitting-ground-other', name: 'Other Grounding Fittings' },
        ],
      },
      {
        slug: 'fittings-liquidtight',
        name: 'Liquidtight Fittings',
        types: [
          { slug: 'fitting-liquidtight-connector', name: 'Liquidtight Connectors' },
          { slug: 'fitting-liquidtight-other', name: 'Other Liquidtight Fittings' },
        ],
      },
      {
        slug: 'fittings-reducing',
        name: 'Reducers & Adapters',
        types: [
          { slug: 'fitting-reducer', name: 'Conduit Reducers & Adapters' },
          { slug: 'fitting-nipple', name: 'Nipples & Extensions' },
          { slug: 'fitting-reducer-other', name: 'Other Reducers & Adapters' },
        ],
      },
    ],
  },

  // ── 8. HVAC (new) ─────────────────────────────────────────────────────
  {
    slug: 'hvac',
    name: 'HVAC',
    subcategories: [
      {
        slug: 'hvac-controls',
        name: 'HVAC Controls',
        types: [
          { slug: 'hvac-thermostat', name: 'Thermostats' },
          { slug: 'hvac-contactor', name: 'HVAC Contactors' },
          { slug: 'hvac-control-other', name: 'Other HVAC Controls' },
        ],
      },
      {
        slug: 'hvac-motors',
        name: 'HVAC Motors & Components',
        types: [
          { slug: 'hvac-motor', name: 'HVAC Fan & Blower Motors' },
          { slug: 'hvac-capacitor', name: 'Capacitors (Run / Start)' },
          { slug: 'hvac-component-other', name: 'Other HVAC Components' },
        ],
      },
      {
        slug: 'hvac-disconnect',
        name: 'HVAC Disconnects & Protection',
        types: [
          { slug: 'hvac-disconnect-switch', name: 'AC Disconnect Switches' },
          { slug: 'hvac-fuse-block', name: 'Fuse Holders & Blocks' },
          { slug: 'hvac-protection-other', name: 'Other HVAC Protection' },
        ],
      },
    ],
  },

  // ── 9. Lighting (existing — controls sub added) ────────────────────────
  {
    slug: 'lighting',
    name: 'Lighting',
    subcategories: [
      {
        slug: 'lighting-by-type',
        name: 'By Type',
        types: [
          { slug: 'lighting-led-bulb', name: 'LED Bulbs' },
          { slug: 'lighting-fluorescent', name: 'Fluorescent' },
          { slug: 'lighting-fixture', name: 'Fixtures' },
          { slug: 'lighting-recessed', name: 'Recessed / Cans' },
          { slug: 'lighting-other', name: 'Other Lighting' },
        ],
      },
      {
        slug: 'lighting-controls',
        name: 'Lighting Controls',
        types: [
          { slug: 'lighting-ctrl-daylight', name: 'Daylight / Photocell Controls' },
          { slug: 'lighting-ctrl-motion', name: 'Motion & Occupancy Controls' },
          { slug: 'lighting-ctrl-dimmer', name: 'Dimmer Controls' },
          { slug: 'lighting-ctrl-other', name: 'Other Lighting Controls' },
        ],
      },
      {
        slug: 'emergency-lighting',
        name: 'Emergency & Exit Lighting',
        types: [
          { slug: 'lighting-exit-sign', name: 'Exit Signs' },
          { slug: 'lighting-emergency-unit', name: 'Emergency Lighting Units' },
          { slug: 'lighting-emergency-other', name: 'Other Emergency Lighting' },
        ],
      },
    ],
  },

  // ── 10. Line Construction Material (new) ──────────────────────────────
  {
    slug: 'line-construction',
    name: 'Line Construction Material',
    subcategories: [
      {
        slug: 'overhead-wire',
        name: 'Overhead Wire & Cable',
        types: [
          { slug: 'wire-triplex', name: 'Triplex / Quadruplex URD' },
          { slug: 'wire-aac', name: 'AAC / ACSR Overhead Conductors' },
          { slug: 'wire-overhead-other', name: 'Other Overhead Wire' },
        ],
      },
      {
        slug: 'pole-hardware',
        name: 'Pole Hardware & Insulators',
        types: [
          { slug: 'pole-insulator', name: 'Insulators' },
          { slug: 'pole-clamp', name: 'Deadend & Strain Clamps' },
          { slug: 'pole-hardware-other', name: 'Other Pole Hardware' },
        ],
      },
      {
        slug: 'underground-dist',
        name: 'Underground Distribution',
        types: [
          { slug: 'urd-cable', name: 'URD Cable' },
          { slug: 'urd-splice', name: 'URD Splices & Terminations' },
          { slug: 'urd-other', name: 'Other Underground Distribution' },
        ],
      },
    ],
  },

  // ── 11. Telecom / Datacom (new) ────────────────────────────────────────
  {
    slug: 'telecom',
    name: 'Telecom',
    subcategories: [
      {
        slug: 'datacom-cable',
        name: 'Data & Telecom Cable',
        types: [
          { slug: 'cable-cat5e', name: 'Cat 5e Cable' },
          { slug: 'cable-cat6', name: 'Cat 6 / Cat 6A Cable' },
          { slug: 'cable-fiber', name: 'Fiber Optic Cable' },
          { slug: 'cable-coax', name: 'Coaxial Cable' },
          { slug: 'cable-telecom-other', name: 'Other Telecom Cable' },
        ],
      },
      {
        slug: 'datacom-connectors',
        name: 'Data Connectors & Jacks',
        types: [
          { slug: 'jack-rj45', name: 'RJ45 Jacks & Keystone Modules' },
          { slug: 'jack-coax', name: 'Coax Connectors & Splitters' },
          { slug: 'jack-other', name: 'Other Data Jacks & Connectors' },
        ],
      },
      {
        slug: 'datacom-enclosures',
        name: 'Telecom Enclosures & Patch Panels',
        types: [
          { slug: 'patch-panel', name: 'Patch Panels' },
          { slug: 'telecom-enclosure', name: 'Telecom Enclosures & Brackets' },
          { slug: 'telecom-enclosure-other', name: 'Other Telecom Enclosures' },
        ],
      },
    ],
  },

  // ── 12. Tools & Testers (new) ─────────────────────────────────────────
  {
    slug: 'tools-testers',
    name: 'Tools & Testers',
    subcategories: [
      {
        slug: 'hand-tools',
        name: 'Hand Tools',
        types: [
          { slug: 'tool-pliers', name: 'Pliers & Cutters' },
          { slug: 'tool-screwdriver', name: 'Screwdrivers & Nut Drivers' },
          { slug: 'tool-fish-tape', name: 'Fish Tape & Pull Line' },
          { slug: 'tool-conduit-bender', name: 'Conduit Benders' },
          { slug: 'tool-hand-other', name: 'Other Hand Tools' },
        ],
      },
      {
        slug: 'test-equipment',
        name: 'Test & Measurement',
        types: [
          { slug: 'tester-multimeter', name: 'Multimeters' },
          { slug: 'tester-clamp-meter', name: 'Clamp Meters' },
          { slug: 'tester-circuit', name: 'Circuit Testers & Voltage Detectors' },
          { slug: 'tester-continuity', name: 'Continuity & Wire Testers' },
          { slug: 'tester-other', name: 'Other Test Equipment' },
        ],
      },
      {
        slug: 'power-tools-acc',
        name: 'Power Tool Accessories',
        types: [
          { slug: 'tool-drill-bit', name: 'Drill Bits & Hole Saws' },
          { slug: 'tool-blade', name: 'Saw Blades & Cutting Accessories' },
          { slug: 'tool-power-acc-other', name: 'Other Power Tool Accessories' },
        ],
      },
    ],
  },

  // ── 13. Wire & Cable (existing — specialty sub added) ─────────────────
  {
    slug: 'wire-cable',
    name: 'Wire & Cable',
    subcategories: [
      {
        slug: 'wire-by-type',
        name: 'By Type',
        types: [
          { slug: 'wire-thhn', name: 'THHN / THWN Building Wire' },
          { slug: 'wire-romex', name: 'Romex / NM-B Cable' },
          { slug: 'wire-mc', name: 'MC / Armored Cable' },
          { slug: 'wire-uf', name: 'UF Underground Feeder' },
          { slug: 'wire-ser', name: 'SER / Service Entrance' },
          { slug: 'wire-other', name: 'Other Wire & Cable' },
        ],
      },
      {
        slug: 'wire-specialty',
        name: 'Specialty Wire & Cable',
        types: [
          { slug: 'wire-control', name: 'Control Cable' },
          { slug: 'wire-tray', name: 'Tray Cable (TC)' },
          { slug: 'wire-welding', name: 'Welding Cable' },
          { slug: 'wire-low-voltage', name: 'Low-Voltage / Thermostat Wire' },
          { slug: 'wire-specialty-other', name: 'Other Specialty Cable' },
        ],
      },
    ],
  },

  // ── 14. Wiring Devices (existing: receptacles + switches) ─────────────
  {
    slug: 'receptacles',
    name: 'Receptacles',
    subcategories: [
      {
        slug: 'receptacles-by-type',
        name: 'By Type',
        types: [
          { slug: 'receptacle-duplex', name: 'Duplex Receptacles' },
          { slug: 'receptacle-gfci', name: 'GFCI Receptacles' },
          { slug: 'receptacle-usb', name: 'USB Receptacles' },
          { slug: 'receptacle-twist-lock', name: 'Twist-Lock Receptacles' },
          { slug: 'receptacle-range', name: 'Range / Dryer Receptacles' },
          { slug: 'receptacle-other', name: 'Other Receptacles' },
        ],
      },
    ],
  },
  {
    slug: 'switches',
    name: 'Switches & Dimmers',
    subcategories: [
      {
        slug: 'switches-by-type',
        name: 'By Type',
        types: [
          { slug: 'switch-toggle', name: 'Toggle Switches' },
          { slug: 'switch-3way', name: '3-Way Switches' },
          { slug: 'switch-4way', name: '4-Way Switches' },
          { slug: 'switch-dimmer', name: 'Dimmers' },
          { slug: 'switch-occupancy', name: 'Occupancy Sensors' },
          { slug: 'switch-other', name: 'Other Switches' },
        ],
      },
    ],
  },

  // ── 15. Connectors & Terminations (existing) ──────────────────────────
  {
    slug: 'connectors-terminations',
    name: 'Connectors & Terminations',
    subcategories: [
      {
        slug: 'connectors-by-type',
        name: 'By Type',
        types: [
          { slug: 'connector-wirenut', name: 'Wire Nuts' },
          { slug: 'connector-lug', name: 'Lugs' },
          { slug: 'connector-terminal', name: 'Terminal Blocks' },
          { slug: 'connector-other', name: 'Other Connectors' },
        ],
      },
    ],
  },

  // ── Uncategorized fallback ──────────────────────────────────────────────
  // Every part must map to a Category → Subcategory → Type triple. When the
  // rule classifier (and optional AI fallback) can't place a row, it lands
  // here so it stays visible in Browse instead of silently disappearing.
  {
    slug: 'uncategorized',
    name: 'Uncategorized',
    subcategories: [
      {
        slug: 'uncategorized-general',
        name: 'Needs Review',
        types: [{ slug: 'uncategorized-type', name: 'Unclassified Items' }],
      },
    ],
  },
];

/** Slug of the leaf "type" node every unmatched part is pinned to. */
export const UNCATEGORIZED_TYPE_SLUG = 'uncategorized-type';

/**
 * Idempotent seed of the taxonomy tree.
 *
 * - Missing nodes are inserted.
 * - Existing nodes are upserted on (name, sortOrder); parentId + source
 *   are left intact to preserve references and manual/AI provenance.
 */
// Locate attached_assets/ relative to whichever cwd seed is invoked from.
function attachedAssetsDir(): string | null {
  // Build candidate paths without relying on __dirname (ESM-safe).
  // Covers running from: repo root, artifacts/api-server, or src/seed/.
  const candidates: string[] = [
    path.resolve(process.cwd(), 'attached_assets'),
    path.resolve(process.cwd(), '../../attached_assets'),
    path.resolve(process.cwd(), '../../../attached_assets'),
    path.resolve(process.cwd(), '../../../../attached_assets'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

// Glob-light: list files in dir whose names match any of the patterns.
function findAssets(dir: string, patterns: RegExp[]): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => patterns.some((rx) => rx.test(f)))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// Parse the EES Product Catalog PDF's table of contents into category
// names. The TOC lays out one section per letter (A..K) with the heading
// text on the same or next line — we scan the first few pages of raw text
// for `^[A-K]\s+<heading>` and the continuation line that follows.
function parseEesCatalogPdf(pdfPath: string): string[] | null {
  try {
    const out = execFileSync('pdftotext', ['-raw', '-f', '1', '-l', '2', pdfPath, '-'], {
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const lines = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const cats: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^([A-K])\s+(.+)$/.exec(lines[i]!);
      if (!m) continue;
      let heading = m[2]!;
      // Lines like "C Lighting &" continue on the next line ("Lighting Controls").
      if (/[&,]\s*$/.test(heading) && lines[i + 1] && !/^[A-L]\s/.test(lines[i + 1]!)) {
        heading = `${heading} ${lines[i + 1]}`.trim();
      }
      cats.push(heading.replace(/\s+/g, ' ').trim());
    }
    return cats.length >= 5 ? cats : null;
  } catch (err) {
    console.warn(`[seedTaxonomy] pdftotext failed for ${pdfPath}: ${String(err)}`);
    return null;
  }
}

function fuzzyMatchCategory(target: string, options: SeedCategory[]): SeedCategory | null {
  const tNorm = target
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
  const tWords = new Set(tNorm.split(' ').filter((w) => w.length > 2));
  let best: { cat: SeedCategory; score: number } | null = null;
  for (const c of options) {
    const cNorm = c.name
      .toLowerCase()
      .replace(/[^a-z]+/g, ' ')
      .trim();
    const cWords = new Set(cNorm.split(' ').filter((w) => w.length > 2));
    let overlap = 0;
    for (const w of tWords) if (cWords.has(w)) overlap++;
    const score = overlap / Math.max(1, Math.min(tWords.size, cWords.size));
    if (score >= 0.5 && (!best || score > best.score)) best = { cat: c, score };
  }
  return best?.cat ?? null;
}

// Resolve the taxonomy source. Priority:
//   1. attached_assets/eesTaxonomy.json (operator-supplied override)
//   2. attached_assets/EES*catalog*.pdf — parse TOC, align embedded
//      category names to the catalog's, return a "pdf" source
//   3. embedded SEED_TAXONOMY
function loadTaxonomySource(): { source: 'file' | 'pdf' | 'embedded'; tree: SeedCategory[] } {
  const dir = attachedAssetsDir();
  if (dir) {
    const jsonOverride = path.join(dir, 'eesTaxonomy.json');
    if (fs.existsSync(jsonOverride)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(jsonOverride, 'utf-8')) as unknown;
        const ok =
          Array.isArray(parsed) &&
          parsed.every(
            (c) =>
              typeof c === 'object' &&
              c !== null &&
              typeof (c as SeedCategory).slug === 'string' &&
              typeof (c as SeedCategory).name === 'string' &&
              Array.isArray((c as SeedCategory).subcategories)
          );
        if (ok) {
          console.log(`[seedTaxonomy] using EES override at ${jsonOverride}`);
          return { source: 'file', tree: parsed as SeedCategory[] };
        }
        console.warn(`[seedTaxonomy] ${jsonOverride} invalid — falling through`);
      } catch (err) {
        console.warn(`[seedTaxonomy] parse failed for ${jsonOverride}: ${String(err)}`);
      }
    }
    const pdfs = findAssets(dir, [
      /EES.*catalog.*\.pdf$/i,
      /catalog.*\.pdf$/i,
      /categories.*\.pdf$/i,
    ]);
    if (pdfs.length > 0) {
      const cats = parseEesCatalogPdf(pdfs[0]!);
      if (cats && cats.length > 0) {
        console.log(`[seedTaxonomy] parsed ${cats.length} categories from ${pdfs[0]}`);
        const aligned: SeedCategory[] = [];
        const used = new Set<string>();
        for (const catName of cats) {
          const match = fuzzyMatchCategory(catName, SEED_TAXONOMY);
          if (match) {
            aligned.push({ ...match, name: catName });
            used.add(match.slug);
          } else {
            aligned.push({
              slug: catName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, ''),
              name: catName,
              subcategories: [],
            });
          }
        }
        for (const c of SEED_TAXONOMY) if (!used.has(c.slug)) aligned.push(c);
        return { source: 'pdf', tree: aligned };
      }
    }
  }
  return { source: 'embedded', tree: SEED_TAXONOMY };
}

export async function seedTaxonomy(): Promise<{
  insertedCategories: number;
  insertedSubcategories: number;
  insertedTypes: number;
  updatedNodes: number;
  source: 'file' | 'pdf' | 'embedded';
}> {
  let insertedCategories = 0;
  let insertedSubcategories = 0;
  let insertedTypes = 0;
  let updatedNodes = 0;

  const { source, tree } = loadTaxonomySource();

  // Build a slug → row map from any nodes already present so we don't duplicate.
  const existing = await db.select().from(categoryNodeTable);
  const bySlug = new Map<string, (typeof existing)[number]>();
  for (const n of existing) bySlug.set(n.slug, n);
  const slugToId = new Map<string, number>();
  for (const n of existing) slugToId.set(n.slug, n.id);

  // Helper: refresh name + sortOrder if either differs from what's seeded.
  const upsertExisting = async (slug: string, name: string, sortOrder: number) => {
    const cur = bySlug.get(slug);
    if (!cur) return;
    if (cur.name !== name || cur.sortOrder !== sortOrder) {
      await db
        .update(categoryNodeTable)
        .set({ name, sortOrder, updatedAt: new Date() })
        .where(eq(categoryNodeTable.id, cur.id));
      updatedNodes++;
    }
  };

  for (let ci = 0; ci < tree.length; ci++) {
    const cat = tree[ci]!;
    let catId = slugToId.get(cat.slug);
    if (!catId) {
      const [row] = await db
        .insert(categoryNodeTable)
        .values({
          parentId: null,
          level: 'category',
          name: cat.name,
          slug: cat.slug,
          sortOrder: ci,
          source: 'seed',
        })
        .returning();
      catId = row!.id;
      slugToId.set(cat.slug, catId);
      insertedCategories++;
    } else {
      await upsertExisting(cat.slug, cat.name, ci);
    }

    for (let si = 0; si < cat.subcategories.length; si++) {
      const sub = cat.subcategories[si]!;
      let subId = slugToId.get(sub.slug);
      if (!subId) {
        const [row] = await db
          .insert(categoryNodeTable)
          .values({
            parentId: catId,
            level: 'subcategory',
            name: sub.name,
            slug: sub.slug,
            sortOrder: si,
            source: 'seed',
          })
          .returning();
        subId = row!.id;
        slugToId.set(sub.slug, subId);
        insertedSubcategories++;
      } else {
        await upsertExisting(sub.slug, sub.name, si);
      }

      for (let ti = 0; ti < sub.types.length; ti++) {
        const t = sub.types[ti]!;
        if (slugToId.has(t.slug)) {
          await upsertExisting(t.slug, t.name, ti);
          continue;
        }
        const [row] = await db
          .insert(categoryNodeTable)
          .values({
            parentId: subId,
            level: 'type',
            name: t.name,
            slug: t.slug,
            sortOrder: ti,
            source: 'seed',
          })
          .returning();
        slugToId.set(t.slug, row!.id);
        insertedTypes++;
      }
    }
  }

  // bump updated_at on the table even if no inserts (for the `/version` poll)
  await db.execute(sql`SELECT 1`);

  return { insertedCategories, insertedSubcategories, insertedTypes, updatedNodes, source };
}
