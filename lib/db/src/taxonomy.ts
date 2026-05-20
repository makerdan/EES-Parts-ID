export interface TaxonomyItemType {
  slug: string;
  label: string;
  keywords: string[];
}

export interface TaxonomySubcategory {
  slug: string;
  label: string;
  keywords: string[];
  itemTypes: TaxonomyItemType[];
}

export interface TaxonomyCategory {
  slug: string;
  label: string;
  color: string;
  keywords: string[];
  subcategories: TaxonomySubcategory[];
}

/**
 * Canonical 3-level electrical taxonomy.
 * 17 top-level categories · 44 sub-categories · 131 item types (per spec).
 * Does NOT include the "Uncategorized" catch-all — that is handled separately
 * so it does not interfere with getAllTaxonomyKeywords() inverse matching.
 */
export const TAXONOMY: TaxonomyCategory[] = [
  // ── 1. Anchors & Connectors ──────────────────────────────────────────────
  {
    slug: "anchors-connectors",
    label: "Anchors & Connectors",
    color: "#8B5CF6",
    keywords: [],
    subcategories: [
      {
        slug: "anchors-fasteners",
        label: "Anchors & Fasteners",
        keywords: [],
        itemTypes: [
          {
            slug: "concrete-masonry-anchors",
            label: "Concrete/Masonry Anchors",
            keywords: [
              "concrete anchor", "masonry anchor", "wedge anchor", "sleeve anchor",
              "drop-in anchor", "expansion anchor", "concrete screw", "tapcon",
              "lag shield", "anchor bolt", "masonry bolt",
            ],
          },
          {
            slug: "toggle-hollow-wall-anchors",
            label: "Toggle Bolts & Hollow-Wall Anchors",
            keywords: [
              "toggle bolt", "hollow wall anchor", "molly bolt",
              "butterfly anchor", "snap toggle",
            ],
          },
          {
            slug: "threaded-rod-studs",
            label: "Threaded Rod & Studs",
            keywords: [
              "threaded rod", "all-thread", "all thread rod", "threaded stud",
              "redi-rod", "ATR", "galvanized rod",
            ],
          },
        ],
      },
      {
        slug: "structural-connectors",
        label: "Structural Connectors",
        keywords: [],
        itemTypes: [
          {
            slug: "beam-pipe-clamps",
            label: "Beam Clamps & Pipe Clamps",
            keywords: [
              "beam clamp", "pipe clamp", "C clamp", "I-beam clamp",
              "flange clamp", "cable beam clamp",
            ],
          },
          {
            slug: "cable-tray-connectors",
            label: "Cable Tray Connectors",
            keywords: [
              "cable tray connector", "tray connector", "tray splice",
              "cable tray coupler",
            ],
          },
          {
            slug: "strut-unistrut-connectors",
            label: "Strut/Unistrut Connectors",
            keywords: [
              "strut connector", "unistrut connector", "channel connector",
              "strut splice", "channel splice plate",
            ],
          },
        ],
      },
    ],
  },

  // ── 2. Boxes & Enclosures ────────────────────────────────────────────────
  {
    slug: "boxes-enclosures",
    label: "Boxes & Enclosures",
    color: "#EC4899",
    keywords: [],
    subcategories: [
      {
        slug: "boxes-by-type",
        label: "By Type",
        keywords: [],
        itemTypes: [
          {
            slug: "device-switch-boxes",
            label: "Device/Switch Boxes",
            keywords: [
              "device box", "switch box", "single gang box", "two gang box",
              "outlet box", "old work box", "new work box", "remodel box",
              "switch gang",
            ],
          },
          {
            slug: "junction-pull-boxes",
            label: "Junction/Pull Boxes",
            keywords: [
              "junction box", "pull box", "j-box", "4 square", "4S box",
              "4-11/16 box", "draw box", "pulling box",
            ],
          },
          {
            slug: "weatherproof-boxes",
            label: "Weatherproof Boxes",
            keywords: [
              "weatherproof box", "outdoor box", "WP box", "wet location box",
              "rain tight box",
            ],
          },
          {
            slug: "floor-boxes",
            label: "Floor Boxes",
            keywords: [
              "floor box", "floor outlet", "in-floor box", "raised floor box",
              "flush floor",
            ],
          },
          {
            slug: "fan-rated-boxes",
            label: "Fan-Rated Boxes",
            keywords: [
              "fan box", "fan-rated box", "ceiling fan box", "pancake box fan",
              "fan rated",
            ],
          },
        ],
      },
      {
        slug: "covers-plates",
        label: "Covers & Plates",
        keywords: [],
        itemTypes: [
          {
            slug: "blank-covers",
            label: "Blank Covers",
            keywords: [
              "blank cover", "blank plate", "cover blank", "solid cover",
            ],
          },
          {
            slug: "wall-device-plates",
            label: "Wall Plates & Device Plates",
            keywords: [
              "wall plate", "device plate", "cover plate", "switch plate",
              "outlet cover", "face plate", "decorator plate", "duplex cover",
            ],
          },
          {
            slug: "weatherproof-in-use-covers",
            label: "Weatherproof In-Use Covers",
            keywords: [
              "weatherproof cover", "in-use cover", "while-in-use cover",
              "bubble cover", "WP cover",
            ],
          },
          {
            slug: "box-covers-extension-rings",
            label: "Box Covers & Extension Rings",
            keywords: [
              "box cover", "extension ring", "mud ring", "plaster ring",
              "tile ring", "raised cover",
            ],
          },
        ],
      },
      {
        slug: "nema-enclosures",
        label: "NEMA Enclosures",
        keywords: [],
        itemTypes: [
          {
            slug: "nema-1-indoor",
            label: "NEMA 1 (Indoor)",
            keywords: [
              "NEMA 1", "NEMA type 1", "general purpose enclosure",
              "indoor enclosure",
            ],
          },
          {
            slug: "nema-3r-rainproof",
            label: "NEMA 3R (Rainproof)",
            keywords: [
              "NEMA 3R", "NEMA type 3R", "rainproof enclosure",
              "outdoor enclosure raintight",
            ],
          },
          {
            slug: "nema-4-4x-watertight",
            label: "NEMA 4/4X (Watertight)",
            keywords: [
              "NEMA 4", "NEMA 4X", "watertight enclosure", "stainless enclosure",
              "fiberglass enclosure", "washdown enclosure",
            ],
          },
        ],
      },
    ],
  },

  // ── 3. Builders Products ─────────────────────────────────────────────────
  {
    slug: "builders-products",
    label: "Builders Products",
    color: "#10B981",
    keywords: [],
    subcategories: [
      {
        slug: "strut-framing",
        label: "Strut & Framing",
        keywords: [],
        itemTypes: [
          {
            slug: "strut-channel",
            label: "Strut Channel",
            keywords: [
              "strut channel", "unistrut", "Kindorf", "Superstrut", "B-Line",
              "framing channel", "slotted channel", "1-5/8 channel", "strut rail",
            ],
          },
          {
            slug: "strut-fittings-nuts",
            label: "Strut Fittings & Nuts",
            keywords: [
              "strut fitting", "strut nut", "channel nut", "strut splice",
              "strut bracket", "spring nut", "strut angle",
            ],
          },
        ],
      },
      {
        slug: "cable-management",
        label: "Cable Management",
        keywords: [],
        itemTypes: [
          {
            slug: "cable-ties-zip-ties",
            label: "Cable Ties & Zip Ties",
            keywords: [
              "cable tie", "zip tie", "ty-rap", "ty rap", "nylon tie",
              "locking tie",
            ],
          },
          {
            slug: "cable-staples-clips",
            label: "Cable Staples & Clips",
            keywords: [
              "cable staple", "cable clip", "wire staple", "romex staple",
              "NM staple", "cable cleat",
            ],
          },
          {
            slug: "cable-duct-wiring-duct",
            label: "Cable Duct & Wiring Duct",
            keywords: [
              "cable duct", "wiring duct", "panduit duct", "wire management duct",
              "slotted duct",
            ],
          },
        ],
      },
      {
        slug: "supports-hangers",
        label: "Supports & Hangers",
        keywords: [],
        itemTypes: [
          {
            slug: "hanger-rods-all-thread",
            label: "Hanger Rods & All-Thread",
            keywords: [
              "hanger rod", "all-thread hanger", "rod coupling",
              "hanger coupler",
            ],
          },
          {
            slug: "beam-trapeze-hangers",
            label: "Beam/Trapeze Hangers",
            keywords: [
              "beam hanger", "trapeze hanger", "trapeze assembly",
              "trapeze support", "conduit trapeze",
            ],
          },
          {
            slug: "pipe-hangers-clamps",
            label: "Pipe Hangers & Clamps",
            keywords: [
              "pipe hanger", "conduit hanger", "conduit clamp",
              "clevis hanger", "J hook", "split ring hanger",
            ],
          },
        ],
      },
    ],
  },

  // ── 4. Conduit & Raceway ─────────────────────────────────────────────────
  {
    slug: "conduit-raceway",
    label: "Conduit & Raceway",
    color: "#3B82F6",
    keywords: [],
    subcategories: [
      {
        slug: "conduit-by-material",
        label: "By Material",
        keywords: [],
        itemTypes: [
          {
            slug: "emt",
            label: "EMT",
            keywords: [
              "EMT", "electrical metallic tubing", "thin wall",
              "thinwall conduit", "EMT conduit",
            ],
          },
          {
            slug: "pvc-conduit",
            label: "PVC",
            keywords: [
              "PVC conduit", "schedule 40 conduit", "schedule 80 conduit",
              "rigid PVC conduit",
            ],
          },
          {
            slug: "rmc-rigid-metal",
            label: "RMC/Rigid Metal",
            keywords: [
              "RMC", "GRS", "rigid metallic conduit", "rigid steel conduit",
              "galvanized rigid conduit", "rigid conduit",
            ],
          },
          {
            slug: "imc",
            label: "IMC",
            keywords: [
              "IMC", "intermediate metal conduit", "intermediate conduit",
            ],
          },
          {
            slug: "fmc-flexible-metal",
            label: "FMC/Flexible Metal",
            keywords: [
              "FMC", "flex conduit", "flexible metal conduit", "Greenfield",
              "LFMC", "liquidtight flex metallic",
            ],
          },
          {
            slug: "ent-smurf-tube",
            label: "ENT/Smurf Tube",
            keywords: [
              "ENT", "smurf tube", "corrugated conduit",
              "electrical non-metallic tubing",
            ],
          },
        ],
      },
      {
        slug: "conduit-fittings",
        label: "Fittings",
        keywords: [],
        itemTypes: [
          {
            slug: "couplings",
            label: "Couplings",
            keywords: [
              "coupling", "EMT coupling", "PVC coupling", "compression coupling",
              "set screw coupling",
            ],
          },
          {
            slug: "elbows",
            label: "Elbows",
            keywords: [
              "elbow", "90 degree elbow", "LB", "sweep elbow",
              "45 elbow", "conduit elbow",
            ],
          },
          {
            slug: "conduit-connectors",
            label: "Connectors",
            keywords: [
              "conduit connector", "EMT connector", "set screw connector",
              "compression connector", "flex connector",
            ],
          },
          {
            slug: "condulets-conduit-bodies",
            label: "Condulets/Conduit Bodies",
            keywords: [
              "condulet", "conduit body", "LB fitting", "LL fitting",
              "T body", "C body", "conduit body cover",
            ],
          },
          {
            slug: "straps-hangers",
            label: "Straps & Hangers",
            keywords: [
              "conduit strap", "one-hole strap", "two-hole strap",
              "EMT strap", "conduit clamp strap",
            ],
          },
        ],
      },
      {
        slug: "wireways-cable-tray",
        label: "Wireways & Cable Tray",
        keywords: [],
        itemTypes: [
          {
            slug: "metal-wireways-panduit",
            label: "Metal Wireways/Panduit Duct",
            keywords: [
              "wireway", "wireway fitting", "sheet metal wireway",
              "panduit wireway", "lay-in wireway", "auxiliary gutter",
            ],
          },
          {
            slug: "ladder-cable-tray",
            label: "Ladder Cable Tray",
            keywords: [
              "ladder tray", "cable ladder", "ladder rack",
            ],
          },
          {
            slug: "solid-bottom-cable-tray",
            label: "Solid Bottom Cable Tray",
            keywords: [
              "solid bottom tray", "solid tray", "solid cable tray",
              "perforated tray", "ventilated tray",
            ],
          },
        ],
      },
    ],
  },

  // ── 5. Motors, Controls & Sensors ───────────────────────────────────────
  {
    slug: "motors-controls-sensors",
    label: "Motors, Controls & Sensors",
    color: "#F59E0B",
    keywords: [],
    subcategories: [
      {
        slug: "motor-controls",
        label: "Motor Controls",
        keywords: [],
        itemTypes: [
          {
            slug: "starters-contactors-vfds",
            label: "Starters/Contactors/VFDs",
            keywords: [
              "starter", "contactor", "VFD", "motor starter",
              "variable frequency drive", "AC drive", "soft starter",
            ],
          },
          {
            slug: "other-motor-controls",
            label: "Other Motor Controls",
            keywords: [],
          },
        ],
      },
      {
        slug: "relays-timers",
        label: "Relays & Timers",
        keywords: [],
        itemTypes: [
          {
            slug: "control-relays",
            label: "Control Relays",
            keywords: [
              "relay", "control relay", "ice cube relay", "DPDT relay",
              "latching relay", "general purpose relay",
            ],
          },
          {
            slug: "timer-switches-astronomic",
            label: "Timer Switches & Astronomic Timers",
            keywords: [
              "timer", "timer switch", "astronomic timer", "time clock",
              "digital timer", "7-day timer",
            ],
          },
        ],
      },
      {
        slug: "sensors",
        label: "Sensors",
        keywords: [],
        itemTypes: [
          {
            slug: "photocells-light-sensors",
            label: "Photocells/Light Sensors",
            keywords: [
              "photocell", "photo sensor", "light sensor", "dusk-to-dawn",
              "photocontrol", "photoeye",
            ],
          },
          {
            slug: "temp-sensors-thermostats",
            label: "Temperature Sensors & Thermostats",
            keywords: [
              "temperature sensor", "RTD sensor", "thermocouple",
              "temperature transmitter",
            ],
          },
          {
            slug: "current-sensors-ct-clamps",
            label: "Current Sensors & CT Clamps",
            keywords: [
              "current sensor", "CT clamp", "current transformer",
              "split core CT", "current transducer",
            ],
          },
        ],
      },
      {
        slug: "pilot-devices",
        label: "Pilot Devices",
        keywords: [],
        itemTypes: [
          {
            slug: "push-buttons",
            label: "Push Buttons",
            keywords: [
              "push button", "pushbutton", "momentary switch",
              "start button", "stop button", "E-stop",
            ],
          },
          {
            slug: "pilot-lights-indicators",
            label: "Pilot Lights & Indicators",
            keywords: [
              "pilot light", "indicator light", "LED indicator",
              "tower light", "stack light",
            ],
          },
          {
            slug: "selector-switches",
            label: "Selector Switches",
            keywords: [
              "selector switch", "rotary switch", "key switch",
              "hand-off-auto", "HOA switch",
            ],
          },
        ],
      },
    ],
  },

  // ── 6. Breakers ─────────────────────────────────────────────────────────
  {
    slug: "breakers-panels",
    label: "Breakers",
    color: "#EF4444",
    keywords: [],
    subcategories: [
      {
        slug: "breakers-by-type",
        label: "By Type",
        keywords: [],
        itemTypes: [
          {
            slug: "standard-circuit-breakers",
            label: "Standard Circuit Breakers",
            keywords: [
              "circuit breaker", "breaker", "QO breaker", "HOM breaker",
              "BR breaker", "Eaton breaker", "Square D breaker",
              "Siemens breaker", "single pole breaker", "double pole breaker",
            ],
          },
          {
            slug: "gfci-breakers",
            label: "GFCI Breakers",
            keywords: [
              "GFCI breaker", "ground fault breaker", "GFI breaker",
              "GFCI circuit breaker",
            ],
          },
          {
            slug: "afci-breakers",
            label: "AFCI Breakers",
            keywords: [
              "AFCI breaker", "arc fault breaker",
              "arc fault circuit interrupter", "dual function breaker",
            ],
          },
        ],
      },
    ],
  },

  // ── 7. Panels & Distribution ─────────────────────────────────────────────
  {
    slug: "panels-distribution",
    label: "Panels & Distribution",
    color: "#14B8A6",
    keywords: [],
    subcategories: [
      {
        slug: "panels-by-type",
        label: "By Type",
        keywords: [],
        itemTypes: [
          {
            slug: "load-centers-panelboards",
            label: "Load Centers/Panelboards",
            keywords: [
              "load center", "panelboard", "main panel", "sub panel", "subpanel",
              "residential panel", "main breaker panel", "main lug panel",
            ],
          },
          {
            slug: "meter-sockets-meter-mains",
            label: "Meter Sockets/Meter Mains",
            keywords: [
              "meter socket", "meter main", "meter base", "meter enclosure",
              "ringless meter", "meter combo",
            ],
          },
          {
            slug: "other-panels",
            label: "Other Panels",
            keywords: [],
          },
        ],
      },
      {
        slug: "disconnects-safety-switches",
        label: "Disconnects & Safety Switches",
        keywords: [],
        itemTypes: [
          {
            slug: "fusible-safety-switches",
            label: "Fusible Safety Switches",
            keywords: [
              "fusible safety switch", "fused disconnect", "fusible disconnect",
              "HD fusible", "DH fusible",
            ],
          },
          {
            slug: "non-fusible-safety-switches",
            label: "Non-Fusible Safety Switches",
            keywords: [
              "non-fusible safety switch", "non fusible disconnect",
              "safety switch non-fused", "HD non-fusible",
            ],
          },
        ],
      },
      {
        slug: "surge-protection",
        label: "Surge Protection",
        keywords: [],
        itemTypes: [
          {
            slug: "whole-house-panel-spds",
            label: "Whole-House/Panel SPDs",
            keywords: [
              "SPD", "surge protective device", "whole house surge",
              "panel surge protector", "type 1 SPD", "type 2 SPD",
            ],
          },
          {
            slug: "point-of-use-surge-protectors",
            label: "Point-of-Use Surge Protectors",
            keywords: [
              "surge protector", "point of use surge", "outlet surge strip",
            ],
          },
        ],
      },
      {
        slug: "transformers",
        label: "Transformers",
        keywords: [],
        itemTypes: [
          {
            slug: "control-buck-boost-transformers",
            label: "Control/Buck-Boost Transformers",
            keywords: [
              "transformer", "control transformer", "buck boost transformer",
              "step down transformer", "isolation transformer", "CPT",
            ],
          },
          {
            slug: "other-transformers",
            label: "Other Transformers",
            keywords: [],
          },
        ],
      },
      {
        slug: "fuses",
        label: "Fuses",
        keywords: [],
        itemTypes: [
          {
            slug: "cartridge-fuses",
            label: "Cartridge Fuses",
            keywords: [
              "fuse", "cartridge fuse", "fusetron", "time delay fuse",
              "fast acting fuse", "current limiting fuse", "Class J fuse",
            ],
          },
          {
            slug: "glass-automotive-fuses",
            label: "Glass/Automotive Fuses",
            keywords: [
              "glass fuse", "automotive fuse", "mini fuse", "blade fuse",
              "AGC fuse", "MDL fuse",
            ],
          },
        ],
      },
    ],
  },

  // ── 8. Fittings ─────────────────────────────────────────────────────────
  {
    slug: "fittings",
    label: "Fittings",
    color: "#6366F1",
    keywords: [],
    subcategories: [
      {
        slug: "grounding-fittings",
        label: "Grounding Fittings",
        keywords: [],
        itemTypes: [
          {
            slug: "ground-rods-clamps",
            label: "Ground Rods & Clamps",
            keywords: [
              "ground rod", "grounding rod", "ground clamp",
              "copper ground rod", "rod to wire clamp",
            ],
          },
          {
            slug: "grounding-connectors-clamps",
            label: "Grounding Connectors & Clamps",
            keywords: [
              "grounding connector", "grounding clamp", "ground lug",
              "ground bushing", "acorn connector", "grounding coupling",
            ],
          },
        ],
      },
      {
        slug: "liquidtight-fittings",
        label: "Liquidtight Fittings",
        keywords: [],
        itemTypes: [
          {
            slug: "liquidtight-connectors",
            label: "Liquidtight Connectors",
            keywords: [
              "liquidtight connector", "liquid tight connector",
              "LFMC connector", "LFNC connector", "straight liquidtight",
              "90 liquidtight",
            ],
          },
          {
            slug: "other-liquidtight-fittings",
            label: "Other Liquidtight Fittings",
            keywords: [],
          },
        ],
      },
      {
        slug: "reducers-adapters",
        label: "Reducers & Adapters",
        keywords: [],
        itemTypes: [
          {
            slug: "conduit-reducers-adapters",
            label: "Conduit Reducers & Adapters",
            keywords: [
              "conduit reducer", "conduit adapter", "reducing bushing",
              "conduit bushing", "knockout adapter",
            ],
          },
          {
            slug: "nipples-extensions",
            label: "Nipples & Extensions",
            keywords: [
              "nipple", "conduit nipple", "close nipple",
              "extension nipple",
            ],
          },
        ],
      },
    ],
  },

  // ── 9. HVAC ──────────────────────────────────────────────────────────────
  {
    slug: "hvac",
    label: "HVAC",
    color: "#22D3EE",
    keywords: [],
    subcategories: [
      {
        slug: "hvac-controls",
        label: "HVAC Controls",
        keywords: [],
        itemTypes: [
          {
            slug: "thermostats",
            label: "Thermostats",
            keywords: [
              "thermostat", "HVAC thermostat", "programmable thermostat",
              "line voltage thermostat",
            ],
          },
          {
            slug: "hvac-contactors",
            label: "HVAC Contactors",
            keywords: [
              "HVAC contactor", "air conditioner contactor", "AC contactor",
              "condenser contactor", "compressor contactor",
            ],
          },
        ],
      },
      {
        slug: "hvac-motors-components",
        label: "HVAC Motors & Components",
        keywords: [],
        itemTypes: [
          {
            slug: "hvac-fan-blower-motors",
            label: "HVAC Fan & Blower Motors",
            keywords: [
              "fan motor", "blower motor", "condenser fan motor",
              "furnace blower motor", "ECM motor", "draft inducer motor",
            ],
          },
          {
            slug: "capacitors-run-start",
            label: "Capacitors (Run/Start)",
            keywords: [
              "capacitor", "run capacitor", "start capacitor",
              "HVAC capacitor", "dual run capacitor", "AC capacitor",
            ],
          },
        ],
      },
      {
        slug: "hvac-disconnects-protection",
        label: "HVAC Disconnects & Protection",
        keywords: [],
        itemTypes: [
          {
            slug: "ac-disconnect-switches",
            label: "AC Disconnect Switches",
            keywords: [
              "AC disconnect", "air conditioner disconnect", "pull-out disconnect",
              "HVAC disconnect", "heat pump disconnect",
            ],
          },
          {
            slug: "fuse-holders-blocks",
            label: "Fuse Holders & Blocks",
            keywords: [
              "fuse holder", "fuse block", "inline fuse holder",
              "fuse clip",
            ],
          },
        ],
      },
    ],
  },

  // ── 10. Lighting ─────────────────────────────────────────────────────────
  {
    slug: "lighting",
    label: "Lighting",
    color: "#FBBF24",
    keywords: [],
    subcategories: [
      {
        slug: "lighting-by-type",
        label: "By Type",
        keywords: [],
        itemTypes: [
          {
            slug: "led-bulbs",
            label: "LED Bulbs",
            keywords: [
              "LED bulb", "LED lamp", "LED A19", "LED PAR", "LED MR16",
              "LED retrofit", "LED light bulb",
            ],
          },
          {
            slug: "fluorescent",
            label: "Fluorescent",
            keywords: [
              "fluorescent", "fluorescent lamp", "T8 lamp", "T12 lamp",
              "CFL", "compact fluorescent", "T5 lamp",
            ],
          },
          {
            slug: "fixtures",
            label: "Fixtures",
            keywords: [
              "fixture", "light fixture", "luminaire", "LED fixture",
              "wraparound", "vapor tight", "high bay", "wall pack",
            ],
          },
          {
            slug: "recessed-cans",
            label: "Recessed/Cans",
            keywords: [
              "recessed", "can light", "recessed fixture", "downlight",
              "pot light", "IC rated recessed",
            ],
          },
        ],
      },
      {
        slug: "lighting-controls",
        label: "Lighting Controls",
        keywords: [],
        itemTypes: [
          {
            slug: "daylight-photocell-controls",
            label: "Daylight/Photocell Controls",
            keywords: [
              "photocontrol switch", "daylight sensor", "dusk to dawn control",
              "light sensitive switch",
            ],
          },
          {
            slug: "motion-occupancy-controls",
            label: "Motion & Occupancy Controls",
            keywords: [
              "motion sensor switch", "occupancy sensor switch",
              "vacancy sensor", "PIR switch",
            ],
          },
          {
            slug: "dimmer-controls",
            label: "Dimmer Controls",
            keywords: [
              "dimmer", "dimmer switch", "0-10V dimmer", "LED dimmer",
              "Lutron dimmer", "slide dimmer",
            ],
          },
        ],
      },
      {
        slug: "emergency-exit-lighting",
        label: "Emergency & Exit Lighting",
        keywords: [],
        itemTypes: [
          {
            slug: "exit-signs",
            label: "Exit Signs",
            keywords: [
              "exit sign", "LED exit", "exit light", "combination exit",
            ],
          },
          {
            slug: "emergency-lighting-units",
            label: "Emergency Lighting Units",
            keywords: [
              "emergency light", "emergency lighting", "inverter backup",
              "bug eye light", "emergency ballast",
            ],
          },
        ],
      },
    ],
  },

  // ── 11. Line Construction Material ───────────────────────────────────────
  {
    slug: "line-construction",
    label: "Line Construction Material",
    color: "#84CC16",
    keywords: [],
    subcategories: [
      {
        slug: "overhead-wire-cable",
        label: "Overhead Wire & Cable",
        keywords: [],
        itemTypes: [
          {
            slug: "triplex-quadruplex-urd",
            label: "Triplex/Quadruplex URD",
            keywords: [
              "triplex", "quadruplex", "duplex URD", "overhead triplex",
              "aerial cable",
            ],
          },
          {
            slug: "aac-acsr-overhead",
            label: "AAC/ACSR Overhead Conductors",
            keywords: [
              "AAC", "ACSR", "overhead conductor", "bare conductor",
              "aluminum conductor steel reinforced",
            ],
          },
        ],
      },
      {
        slug: "pole-hardware-insulators",
        label: "Pole Hardware & Insulators",
        keywords: [],
        itemTypes: [
          {
            slug: "insulators",
            label: "Insulators",
            keywords: [
              "insulator", "strain insulator", "line insulator",
              "pin insulator",
            ],
          },
          {
            slug: "deadend-strain-clamps",
            label: "Deadend & Strain Clamps",
            keywords: [
              "deadend", "dead end clamp", "strain clamp",
              "preformed deadend", "compression deadend",
            ],
          },
        ],
      },
      {
        slug: "underground-distribution",
        label: "Underground Distribution",
        keywords: [],
        itemTypes: [
          {
            slug: "urd-cable",
            label: "URD Cable",
            keywords: [
              "URD cable", "underground residential distribution",
              "15kV URD", "25kV URD",
            ],
          },
          {
            slug: "urd-splices-terminations",
            label: "URD Splices & Terminations",
            keywords: [
              "URD splice", "URD termination", "underground splice",
              "cold shrink splice", "loadbreak elbow",
            ],
          },
        ],
      },
    ],
  },

  // ── 12. Telecom ──────────────────────────────────────────────────────────
  {
    slug: "telecom",
    label: "Telecom",
    color: "#F97316",
    keywords: [],
    subcategories: [
      {
        slug: "data-telecom-cable",
        label: "Data & Telecom Cable",
        keywords: [],
        itemTypes: [
          {
            slug: "cat-5e",
            label: "Cat 5e",
            keywords: ["Cat 5e", "Cat5e", "category 5e", "CAT5e cable"],
          },
          {
            slug: "cat-6-6a",
            label: "Cat 6/6A",
            keywords: ["Cat 6", "Cat 6A", "Cat6", "Cat6A", "CAT6 cable"],
          },
          {
            slug: "fiber-optic",
            label: "Fiber Optic",
            keywords: [
              "fiber optic", "fiber cable", "optical fiber", "fibre",
              "OM3", "OM4", "OS2", "singlemode", "multimode fiber",
            ],
          },
          {
            slug: "coaxial",
            label: "Coaxial",
            keywords: [
              "coaxial cable", "coax", "RG6", "RG11", "RG59",
              "CATV cable",
            ],
          },
        ],
      },
      {
        slug: "data-connectors-jacks",
        label: "Data Connectors & Jacks",
        keywords: [],
        itemTypes: [
          {
            slug: "rj45-jacks-keystone",
            label: "RJ45 Jacks & Keystone Modules",
            keywords: [
              "RJ45 jack", "keystone jack", "keystone module",
              "Cat6 jack", "Cat5e jack",
            ],
          },
          {
            slug: "coax-connectors-splitters",
            label: "Coax Connectors & Splitters",
            keywords: [
              "coax connector", "coax splitter", "F connector",
              "BNC connector", "CATV splitter",
            ],
          },
        ],
      },
      {
        slug: "telecom-enclosures-patch-panels",
        label: "Telecom Enclosures & Patch Panels",
        keywords: [],
        itemTypes: [
          {
            slug: "patch-panels",
            label: "Patch Panels",
            keywords: [
              "patch panel", "Cat6 patch panel", "24 port patch", "48 port patch",
            ],
          },
          {
            slug: "telecom-enclosures-brackets",
            label: "Telecom Enclosures & Brackets",
            keywords: [
              "telecom enclosure", "network enclosure", "rack enclosure",
              "wall mount rack", "IDF enclosure",
            ],
          },
        ],
      },
    ],
  },

  // ── 13. Tools & Testers ──────────────────────────────────────────────────
  {
    slug: "tools-testers",
    label: "Tools & Testers",
    color: "#64748B",
    keywords: [],
    subcategories: [
      {
        slug: "hand-tools",
        label: "Hand Tools",
        keywords: [],
        itemTypes: [
          {
            slug: "pliers-cutters",
            label: "Pliers & Cutters",
            keywords: [
              "pliers", "cutter", "linesman pliers", "diagonal cutters",
              "needle nose", "wire cutter", "crimping pliers",
            ],
          },
          {
            slug: "screwdrivers-nut-drivers",
            label: "Screwdrivers & Nut Drivers",
            keywords: [
              "screwdriver", "nut driver", "insulated screwdriver",
              "flathead screwdriver", "Phillips screwdriver",
            ],
          },
          {
            slug: "fish-tape-pull-line",
            label: "Fish Tape & Pull Line",
            keywords: [
              "fish tape", "pull line", "fish line", "cable puller",
              "conduit fish tape",
            ],
          },
          {
            slug: "conduit-benders",
            label: "Conduit Benders",
            keywords: [
              "conduit bender", "bender", "hickey", "hand bender",
              "EMT bender",
            ],
          },
        ],
      },
      {
        slug: "test-measurement",
        label: "Test & Measurement",
        keywords: [],
        itemTypes: [
          {
            slug: "multimeters",
            label: "Multimeters",
            keywords: [
              "multimeter", "volt meter", "digital multimeter", "DMM",
              "Fluke multimeter",
            ],
          },
          {
            slug: "clamp-meters",
            label: "Clamp Meters",
            keywords: [
              "clamp meter", "clamp ammeter", "amp clamp", "Fluke clamp",
            ],
          },
          {
            slug: "circuit-testers-voltage-detectors",
            label: "Circuit Testers & Voltage Detectors",
            keywords: [
              "circuit tester", "voltage tester", "non-contact tester",
              "tick tracer", "solenoid tester",
            ],
          },
          {
            slug: "continuity-wire-testers",
            label: "Continuity & Wire Testers",
            keywords: [
              "continuity tester", "wire tracer", "tone generator",
              "cable tester",
            ],
          },
        ],
      },
      {
        slug: "power-tool-accessories",
        label: "Power Tool Accessories",
        keywords: [],
        itemTypes: [
          {
            slug: "drill-bits-hole-saws",
            label: "Drill Bits & Hole Saws",
            keywords: [
              "drill bit", "hole saw", "spade bit", "ship auger",
              "step bit", "knockout set",
            ],
          },
          {
            slug: "saw-blades-cutting-accessories",
            label: "Saw Blades & Cutting Accessories",
            keywords: [
              "saw blade", "jig saw blade", "reciprocating blade",
              "Sawzall blade",
            ],
          },
        ],
      },
    ],
  },

  // ── 14. Wire & Cable ─────────────────────────────────────────────────────
  {
    slug: "wire-cable",
    label: "Wire & Cable",
    color: "#DC2626",
    keywords: [],
    subcategories: [
      {
        slug: "wire-cable-by-type",
        label: "By Type",
        keywords: [],
        itemTypes: [
          {
            slug: "thhn-thwn",
            label: "THHN/THWN Building Wire",
            keywords: [
              "THHN", "THWN", "THWN-2", "building wire", "stranded wire",
              "copper wire THHN", "aluminum THHN",
            ],
          },
          {
            slug: "romex-nm-b",
            label: "Romex/NM-B Cable",
            keywords: [
              "Romex", "NM-B", "NM cable", "non-metallic sheathed cable",
              "12-2 NM", "14-2 NM", "10-2 NM",
            ],
          },
          {
            slug: "mc-armored-cable",
            label: "MC/Armored Cable",
            keywords: [
              "MC cable", "armored cable", "AC cable", "BX cable",
              "metal clad cable",
            ],
          },
          {
            slug: "uf-underground-feeder",
            label: "UF Underground Feeder",
            keywords: [
              "UF cable", "underground feeder", "UF-B cable",
              "direct burial cable",
            ],
          },
          {
            slug: "ser-service-entrance",
            label: "SER/Service Entrance",
            keywords: [
              "SER cable", "service entrance cable", "SER aluminum",
              "SEU cable",
            ],
          },
        ],
      },
      {
        slug: "specialty-wire-cable",
        label: "Specialty Wire & Cable",
        keywords: [],
        itemTypes: [
          {
            slug: "control-cable",
            label: "Control Cable",
            keywords: [
              "control cable", "multi-conductor cable", "shielded control cable",
              "instrumentation cable",
            ],
          },
          {
            slug: "tray-cable",
            label: "Tray Cable (TC)",
            keywords: [
              "tray cable", "TC cable", "TC-ER cable", "power limited tray cable",
            ],
          },
          {
            slug: "welding-cable",
            label: "Welding Cable",
            keywords: [
              "welding cable", "welding wire", "battery cable",
            ],
          },
          {
            slug: "low-voltage-thermostat-wire",
            label: "Low-Voltage/Thermostat Wire",
            keywords: [
              "thermostat wire", "low voltage wire", "18/2 wire", "18/5 wire",
              "bell wire", "doorbell wire",
            ],
          },
        ],
      },
    ],
  },

  // ── 15. Receptacles ──────────────────────────────────────────────────────
  {
    slug: "receptacles",
    label: "Receptacles",
    color: "#7C3AED",
    keywords: [],
    subcategories: [
      {
        slug: "receptacles-by-type",
        label: "By Type",
        keywords: [],
        itemTypes: [
          {
            slug: "duplex-receptacles",
            label: "Duplex Receptacles",
            keywords: [
              "duplex receptacle", "duplex outlet", "15 amp outlet",
              "20 amp outlet", "standard outlet", "TR receptacle",
            ],
          },
          {
            slug: "gfci-receptacles",
            label: "GFCI Receptacles",
            keywords: [
              "GFCI receptacle", "GFCI outlet", "ground fault receptacle",
              "tamper resistant GFCI",
            ],
          },
          {
            slug: "usb-receptacles",
            label: "USB Receptacles",
            keywords: [
              "USB receptacle", "USB outlet", "USB charger outlet",
              "USB-C outlet",
            ],
          },
          {
            slug: "twist-lock-receptacles",
            label: "Twist-Lock Receptacles",
            keywords: [
              "twist lock", "twistlock", "locking receptacle",
              "NEMA L5", "NEMA L6", "NEMA L14",
            ],
          },
          {
            slug: "range-dryer-receptacles",
            label: "Range/Dryer Receptacles",
            keywords: [
              "range receptacle", "dryer receptacle", "30 amp dryer",
              "50 amp range", "NEMA 14-30", "NEMA 14-50",
            ],
          },
        ],
      },
    ],
  },

  // ── 16. Switches & Dimmers ───────────────────────────────────────────────
  {
    slug: "switches-dimmers",
    label: "Switches & Dimmers",
    color: "#0EA5E9",
    keywords: [],
    subcategories: [
      {
        slug: "switches-by-type",
        label: "By Type",
        keywords: [],
        itemTypes: [
          {
            slug: "toggle-switches",
            label: "Toggle Switches",
            keywords: [
              "toggle switch", "single pole switch", "wall switch",
              "15 amp switch", "standard switch",
            ],
          },
          {
            slug: "3-way-switches",
            label: "3-Way Switches",
            keywords: ["3-way switch", "three way switch", "3 way"],
          },
          {
            slug: "4-way-switches",
            label: "4-Way Switches",
            keywords: ["4-way switch", "four way switch", "4 way"],
          },
          {
            slug: "dimmers",
            label: "Dimmers",
            keywords: [
              "dimmer switch", "dimmer", "slide dimmer", "rotary dimmer",
              "LED dimmer switch",
            ],
          },
          {
            slug: "occupancy-sensors",
            label: "Occupancy Sensors",
            keywords: [
              "occupancy sensor", "motion switch", "vacancy sensor",
              "PIR switch sensor",
            ],
          },
        ],
      },
    ],
  },

  // ── 17. Connectors & Terminations ────────────────────────────────────────
  {
    slug: "connectors-terminations",
    label: "Connectors & Terminations",
    color: "#D97706",
    keywords: [],
    subcategories: [
      {
        slug: "connectors-by-type",
        label: "By Type",
        keywords: [],
        itemTypes: [
          {
            slug: "wire-nuts",
            label: "Wire Nuts",
            keywords: [
              "wire nut", "wire connector", "wire-nut", "twist-on connector",
              "wire cap",
            ],
          },
          {
            slug: "lugs",
            label: "Lugs",
            keywords: [
              "lug", "compression lug", "cable lug", "mechanical lug",
              "aluminum lug", "ring terminal lug",
            ],
          },
          {
            slug: "terminal-blocks",
            label: "Terminal Blocks",
            keywords: [
              "terminal block", "DIN rail terminal", "barrier terminal",
              "feed through terminal",
            ],
          },
        ],
      },
    ],
  },

  // ── 18. Uncategorized (catch-all) ────────────────────────────────────────
  // Keywords are empty so getAllTaxonomyKeywords() naturally skips it.
  {
    slug: "uncategorized",
    label: "Uncategorized",
    color: "#9CA3AF",
    keywords: [],
    subcategories: [
      {
        slug: "needs-review",
        label: "Needs Review",
        keywords: [],
        itemTypes: [
          {
            slug: "unclassified-items",
            label: "Unclassified Items",
            keywords: [],
          },
        ],
      },
    ],
  },
];

export function findNodeBySlug(
  taxonomy: TaxonomyCategory[],
  slug: string,
): TaxonomyCategory | TaxonomySubcategory | TaxonomyItemType | null {
  for (const cat of taxonomy) {
    if (cat.slug === slug) return cat;
    for (const sub of cat.subcategories) {
      if (sub.slug === slug) return sub;
      for (const item of sub.itemTypes) {
        if (item.slug === slug) return item;
      }
    }
  }
  return null;
}

export function collectKeywords(
  node: TaxonomyCategory | TaxonomySubcategory | TaxonomyItemType,
): string[] {
  const kws = new Set<string>();
  const add = (n: TaxonomyCategory | TaxonomySubcategory | TaxonomyItemType) => {
    if ("keywords" in n) for (const k of n.keywords) kws.add(k.toLowerCase());
    if ("subcategories" in n) for (const s of n.subcategories) add(s);
    if ("itemTypes" in n) for (const it of (n as TaxonomySubcategory).itemTypes) add(it);
  };
  add(node);
  return Array.from(kws);
}

/** Returns all keywords from the full taxonomy (uncategorized excluded). */
export function getAllTaxonomyKeywords(taxonomy: TaxonomyCategory[]): string[] {
  const all = new Set<string>();
  for (const cat of taxonomy) {
    if (cat.slug === "uncategorized") continue;
    for (const kw of collectKeywords(cat)) all.add(kw);
  }
  return Array.from(all);
}
