export interface TaxonomyItemType {
  slug: string;
  label: string;
  keywords: string[];
}

export interface TaxonomySubcategory {
  slug: string;
  label: string;
  itemTypes: TaxonomyItemType[];
}

export interface TaxonomyCategory {
  slug: string;
  label: string;
  color: string;
  subcategories: TaxonomySubcategory[];
}

export const TAXONOMY: TaxonomyCategory[] = [
  // ── 1. Anchors & Connectors ──────────────────────────────────────────────
  {
    slug: "anchors-connectors",
    label: "Anchors & Connectors",
    color: "#8B5CF6",
    subcategories: [
      {
        slug: "anchors-fasteners",
        label: "Anchors & Fasteners",
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
              "toggle bolt", "hollow wall anchor", "toggle", "molly bolt",
              "butterfly anchor", "snap toggle", "wall anchor hollow",
            ],
          },
          {
            slug: "threaded-rod-studs",
            label: "Threaded Rod & Studs",
            keywords: [
              "threaded rod", "all-thread", "all thread rod", "threaded stud",
              "rod hanger", "B7 rod", "galvanized rod", "ATR", "redi-rod",
            ],
          },
          {
            slug: "other-anchors-fasteners",
            label: "Other Anchors & Fasteners",
            keywords: [
              "anchor", "fastener", "screw anchor", "drywall anchor",
            ],
          },
        ],
      },
      {
        slug: "structural-connectors",
        label: "Structural Connectors",
        itemTypes: [
          {
            slug: "beam-pipe-clamps",
            label: "Beam Clamps & Pipe Clamps",
            keywords: [
              "beam clamp", "pipe clamp", "C clamp", "I-beam clamp",
              "flange clamp", "beam trolley", "cable beam clamp",
            ],
          },
          {
            slug: "cable-tray-connectors",
            label: "Cable Tray Connectors",
            keywords: [
              "cable tray connector", "tray connector", "tray splice",
              "cable tray coupler", "tray hardware",
            ],
          },
          {
            slug: "strut-unistrut-connectors",
            label: "Strut/Unistrut Connectors",
            keywords: [
              "strut connector", "unistrut connector", "channel connector",
              "strut splice", "channel splice plate", "strut cross",
            ],
          },
          {
            slug: "other-structural-connectors",
            label: "Other Structural Connectors",
            keywords: [
              "structural connector", "beam connector", "joist clamp",
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
    subcategories: [
      {
        slug: "boxes-by-type",
        label: "By Type",
        itemTypes: [
          {
            slug: "device-switch-boxes",
            label: "Device/Switch Boxes",
            keywords: [
              "device box", "switch box", "single gang box", "two gang box",
              "outlet box", "old work box", "new work box", "remodel box",
              "plastic box", "switch gang", "electrical box device",
            ],
          },
          {
            slug: "junction-pull-boxes",
            label: "Junction/Pull Boxes",
            keywords: [
              "junction box", "pull box", "j-box", "4 square", "4S box",
              "4-11/16 box", "draw box", "pulling box", "square box",
            ],
          },
          {
            slug: "weatherproof-boxes",
            label: "Weatherproof Boxes",
            keywords: [
              "weatherproof box", "outdoor box", "WP box", "wet location box",
              "rain tight box", "outdoor outlet box",
            ],
          },
          {
            slug: "floor-boxes",
            label: "Floor Boxes",
            keywords: [
              "floor box", "floor outlet", "in-floor box", "raised floor box",
              "flush floor", "carpet floor box",
            ],
          },
          {
            slug: "fan-rated-boxes",
            label: "Fan-Rated Boxes",
            keywords: [
              "fan box", "fan-rated box", "ceiling fan box", "fan support box",
              "pancake box fan", "brace fan", "fan rated",
            ],
          },
          {
            slug: "other-boxes-enclosures",
            label: "Other Boxes & Enclosures",
            keywords: [
              "electrical box", "metal box", "plastic electrical box",
            ],
          },
        ],
      },
      {
        slug: "covers-plates",
        label: "Covers & Plates",
        itemTypes: [
          {
            slug: "blank-covers",
            label: "Blank Covers",
            keywords: [
              "blank cover", "blank plate", "blank face plate", "cover blank",
              "solid cover", "junction box cover blank",
            ],
          },
          {
            slug: "wall-device-plates",
            label: "Wall Plates & Device Plates",
            keywords: [
              "wall plate", "device plate", "cover plate", "switch plate",
              "outlet cover", "face plate", "decorator plate", "duplex cover",
              "single gang plate", "double gang plate",
            ],
          },
          {
            slug: "weatherproof-in-use-covers",
            label: "Weatherproof In-Use Covers",
            keywords: [
              "weatherproof cover", "in-use cover", "while-in-use cover",
              "bubble cover", "outdoor cover", "WP cover", "extra deep cover",
            ],
          },
          {
            slug: "box-covers-extension-rings",
            label: "Box Covers & Extension Rings",
            keywords: [
              "box cover", "extension ring", "mud ring", "plaster ring",
              "tile ring", "depth ring", "raised cover", "4S cover",
            ],
          },
          {
            slug: "other-covers-plates",
            label: "Other Covers & Plates",
            keywords: [
              "cover", "plate", "knockout seal", "KO seal", "snap-in",
            ],
          },
        ],
      },
      {
        slug: "nema-enclosures",
        label: "NEMA Enclosures",
        itemTypes: [
          {
            slug: "nema-1-indoor",
            label: "NEMA 1 (Indoor)",
            keywords: [
              "NEMA 1", "NEMA type 1", "general purpose enclosure",
              "indoor enclosure", "steel enclosure indoor",
            ],
          },
          {
            slug: "nema-3r-rainproof",
            label: "NEMA 3R (Rainproof)",
            keywords: [
              "NEMA 3R", "NEMA type 3R", "rainproof enclosure",
              "outdoor enclosure raintight", "3R enclosure",
            ],
          },
          {
            slug: "nema-4-4x-watertight",
            label: "NEMA 4/4X (Watertight)",
            keywords: [
              "NEMA 4", "NEMA 4X", "watertight enclosure", "stainless enclosure",
              "fiberglass enclosure", "washdown enclosure", "4X enclosure",
            ],
          },
          {
            slug: "other-nema-enclosures",
            label: "Other NEMA Enclosures",
            keywords: [
              "NEMA enclosure", "NEMA 12", "NEMA 7", "hazardous location enclosure",
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
    subcategories: [
      {
        slug: "strut-framing",
        label: "Strut & Framing",
        itemTypes: [
          {
            slug: "strut-channel",
            label: "Strut Channel",
            keywords: [
              "strut channel", "unistrut", "Kindorf", "Superstrut", "B-Line",
              "framing channel", "slotted channel", "1-5/8 channel",
              "3/4 strut", "half slot strut", "strut rail",
            ],
          },
          {
            slug: "strut-fittings-nuts",
            label: "Strut Fittings & Nuts",
            keywords: [
              "strut fitting", "strut nut", "channel nut", "strut splice",
              "strut bracket", "strut plate", "strut angle", "strut post base",
              "channel connector nut", "spring nut",
            ],
          },
          {
            slug: "other-strut-framing",
            label: "Other Strut & Framing",
            keywords: [
              "strut framing", "framing hardware", "strut accessory",
            ],
          },
        ],
      },
      {
        slug: "cable-management",
        label: "Cable Management",
        itemTypes: [
          {
            slug: "cable-ties-zip-ties",
            label: "Cable Ties & Zip Ties",
            keywords: [
              "cable tie", "zip tie", "ty-rap", "ty rap", "nylon tie",
              "locking tie", "cable strap tie",
            ],
          },
          {
            slug: "cable-staples-clips",
            label: "Cable Staples & Clips",
            keywords: [
              "cable staple", "cable clip", "wire staple", "romex staple",
              "NM staple", "cable cleat", "cable fastener clip",
            ],
          },
          {
            slug: "cable-duct-wiring-duct",
            label: "Cable Duct & Wiring Duct",
            keywords: [
              "cable duct", "wiring duct", "panduit duct", "wire management duct",
              "slotted duct", "louvered duct",
            ],
          },
          {
            slug: "other-cable-management",
            label: "Other Cable Management",
            keywords: [
              "cable management", "cable lacing", "hook and loop",
            ],
          },
        ],
      },
      {
        slug: "supports-hangers",
        label: "Supports & Hangers",
        itemTypes: [
          {
            slug: "hanger-rods-all-thread",
            label: "Hanger Rods & All-Thread",
            keywords: [
              "hanger rod", "all-thread hanger", "threaded rod hanger",
              "ATR hanger", "rod coupling", "hanger coupler",
            ],
          },
          {
            slug: "beam-trapeze-hangers",
            label: "Beam/Trapeze Hangers",
            keywords: [
              "beam hanger", "trapeze hanger", "trapeze assembly",
              "trapeze support", "conduit trapeze", "beam hanger strap",
            ],
          },
          {
            slug: "pipe-hangers-clamps",
            label: "Pipe Hangers & Clamps",
            keywords: [
              "pipe hanger", "pipe clamp", "conduit hanger", "conduit clamp",
              "pipe support", "clevis hanger", "J hook", "split ring hanger",
            ],
          },
          {
            slug: "other-supports-hangers",
            label: "Other Supports & Hangers",
            keywords: [
              "support hanger", "suspension", "wiring support",
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
    subcategories: [
      {
        slug: "conduit-by-material",
        label: "By Material",
        itemTypes: [
          {
            slug: "emt",
            label: "EMT",
            keywords: [
              "EMT", "electrical metallic tubing", "thin wall",
              "thin-wall conduit", "steel conduit EMT", "EMT conduit",
              "thinwall conduit",
            ],
          },
          {
            slug: "pvc-conduit",
            label: "PVC",
            keywords: [
              "PVC conduit", "PVC pipe conduit", "schedule 40 conduit",
              "schedule 80 conduit", "rigid PVC conduit",
            ],
          },
          {
            slug: "rmc-rigid-metal",
            label: "RMC/Rigid Metal",
            keywords: [
              "RMC", "GRS", "rigid metallic conduit", "rigid steel conduit",
              "rigid threaded conduit", "galvanized rigid conduit",
              "heavy wall conduit", "rigid conduit",
            ],
          },
          {
            slug: "imc",
            label: "IMC",
            keywords: [
              "IMC", "intermediate metal conduit", "rigid steel IMC",
              "intermediate conduit",
            ],
          },
          {
            slug: "fmc-flexible-metal",
            label: "FMC/Flexible Metal",
            keywords: [
              "FMC", "flex conduit", "flexible metal conduit", "Greenfield",
              "steel flex", "LFMC", "liquidtight metallic conduit",
              "liquidtight flex metallic", "flexible metallic",
            ],
          },
          {
            slug: "ent-smurf-tube",
            label: "ENT/Smurf Tube",
            keywords: [
              "ENT", "smurf tube", "corrugated conduit", "blue flex",
              "electrical non-metallic tubing", "Carlon ENT",
            ],
          },
          {
            slug: "other-conduit",
            label: "Other Conduit",
            keywords: [
              "LFNC", "non-metallic liquid tight", "conduit",
            ],
          },
        ],
      },
      {
        slug: "conduit-fittings",
        label: "Fittings",
        itemTypes: [
          {
            slug: "couplings",
            label: "Couplings",
            keywords: [
              "coupling", "EMT coupling", "PVC coupling", "conduit coupling",
              "compression coupling", "set screw coupling",
            ],
          },
          {
            slug: "elbows",
            label: "Elbows",
            keywords: [
              "elbow", "90 degree elbow", "LB", "sweep elbow",
              "45 elbow", "conduit elbow", "EMT elbow", "PVC elbow",
            ],
          },
          {
            slug: "conduit-connectors",
            label: "Connectors",
            keywords: [
              "conduit connector", "EMT connector", "set screw connector",
              "compression connector", "snap-in connector", "flex connector",
              "liquidtight connector",
            ],
          },
          {
            slug: "condulets-conduit-bodies",
            label: "Condulets/Conduit Bodies",
            keywords: [
              "condulet", "conduit body", "LB fitting", "LL fitting", "LR fitting",
              "T body", "C body", "conduit body cover",
            ],
          },
          {
            slug: "straps-hangers",
            label: "Straps & Hangers",
            keywords: [
              "conduit strap", "one-hole strap", "two-hole strap",
              "EMT strap", "PVC strap", "conduit clamp strap",
              "rigid strap",
            ],
          },
          {
            slug: "other-conduit-fittings",
            label: "Other Fittings",
            keywords: [
              "conduit fitting", "offset", "conduit saddle", "conduit locator",
            ],
          },
        ],
      },
      {
        slug: "wireways-cable-tray",
        label: "Wireways & Cable Tray",
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
              "ladder tray", "cable ladder", "ladder rack", "cable tray ladder",
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
          {
            slug: "other-wireways-cable-tray",
            label: "Other Wireways & Cable Tray",
            keywords: [
              "cable tray", "wire tray", "tray fitting",
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
    subcategories: [
      {
        slug: "motor-controls",
        label: "Motor Controls",
        itemTypes: [
          {
            slug: "starters-contactors-vfds",
            label: "Starters/Contactors/VFDs",
            keywords: [
              "starter", "contactor", "VFD", "motor starter", "variable frequency drive",
              "AC drive", "motor drive", "soft starter", "across-the-line starter",
            ],
          },
        ],
      },
      {
        slug: "relays-timers",
        label: "Relays & Timers",
        itemTypes: [
          {
            slug: "control-relays",
            label: "Control Relays",
            keywords: [
              "relay", "control relay", "ice cube relay", "DPDT relay",
              "latching relay", "coil relay", "general purpose relay",
            ],
          },
          {
            slug: "timer-switches-astronomic",
            label: "Timer Switches & Astronomic Timers",
            keywords: [
              "timer", "timer switch", "astronomic timer", "time clock",
              "digital timer", "mechanical timer", "7-day timer",
            ],
          },
          {
            slug: "other-relays-timers",
            label: "Other Relays & Timers",
            keywords: [
              "relay module", "solid state relay", "sequencer",
            ],
          },
        ],
      },
      {
        slug: "sensors",
        label: "Sensors",
        itemTypes: [
          {
            slug: "photocells-light-sensors",
            label: "Photocells/Light Sensors",
            keywords: [
              "photocell", "photo sensor", "light sensor", "dusk-to-dawn",
              "photocontrol", "daylight sensor", "photoeye",
            ],
          },
          {
            slug: "temp-sensors-thermostats",
            label: "Temperature Sensors & Thermostats",
            keywords: [
              "temperature sensor", "thermostat sensor", "temp sensor",
              "RTD sensor", "thermocouple", "temperature transmitter",
            ],
          },
          {
            slug: "current-sensors-ct-clamps",
            label: "Current Sensors & CT Clamps",
            keywords: [
              "current sensor", "CT clamp", "current transformer",
              "split core CT", "solid core CT", "current transducer",
            ],
          },
          {
            slug: "other-sensors",
            label: "Other Sensors",
            keywords: [
              "proximity sensor", "pressure sensor", "flow sensor",
              "level sensor", "sensor module",
            ],
          },
        ],
      },
      {
        slug: "pilot-devices",
        label: "Pilot Devices",
        itemTypes: [
          {
            slug: "push-buttons",
            label: "Push Buttons",
            keywords: [
              "push button", "pushbutton", "momentary switch",
              "start button", "stop button", "E-stop", "emergency stop button",
            ],
          },
          {
            slug: "pilot-lights-indicators",
            label: "Pilot Lights & Indicators",
            keywords: [
              "pilot light", "indicator light", "LED indicator",
              "tower light", "stack light", "signal light",
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
          {
            slug: "other-pilot-devices",
            label: "Other Pilot Devices",
            keywords: [
              "pilot device", "control station", "pendant station",
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
    subcategories: [
      {
        slug: "breakers-by-type",
        label: "By Type",
        itemTypes: [
          {
            slug: "standard-circuit-breakers",
            label: "Standard Circuit Breakers",
            keywords: [
              "circuit breaker", "breaker", "QO breaker", "HOM breaker",
              "BR breaker", "Eaton breaker", "Square D breaker",
              "Siemens breaker", "GE breaker", "Murray breaker",
              "thermal magnetic breaker", "single pole breaker", "double pole breaker",
            ],
          },
          {
            slug: "gfci-breakers",
            label: "GFCI Breakers",
            keywords: [
              "GFCI breaker", "ground fault breaker", "GFI breaker",
              "GFCI circuit breaker", "ground fault circuit interrupter breaker",
            ],
          },
          {
            slug: "afci-breakers",
            label: "AFCI Breakers",
            keywords: [
              "AFCI breaker", "arc fault breaker", "arc fault circuit interrupter",
              "AFCI circuit breaker", "dual function breaker",
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
    subcategories: [
      {
        slug: "panels-by-type",
        label: "By Type",
        itemTypes: [
          {
            slug: "load-centers-panelboards",
            label: "Load Centers/Panelboards",
            keywords: [
              "load center", "panelboard", "main panel", "sub panel", "subpanel",
              "residential panel", "commercial panel", "main breaker panel",
              "main lug panel", "distribution panel",
            ],
          },
          {
            slug: "meter-sockets-meter-mains",
            label: "Meter Sockets/Meter Mains",
            keywords: [
              "meter socket", "meter main", "meter base", "meter enclosure",
              "ringless meter", "lever bypass meter", "meter combo",
            ],
          },
          {
            slug: "other-panels",
            label: "Other Panels",
            keywords: [
              "switchboard", "switchgear", "distribution board", "PDU",
            ],
          },
        ],
      },
      {
        slug: "disconnects-safety-switches",
        label: "Disconnects & Safety Switches",
        itemTypes: [
          {
            slug: "fusible-safety-switches",
            label: "Fusible Safety Switches",
            keywords: [
              "fusible safety switch", "fused disconnect", "fusible disconnect",
              "safety switch fused", "HD fusible", "DH fusible", "GD fusible",
            ],
          },
          {
            slug: "non-fusible-safety-switches",
            label: "Non-Fusible Safety Switches",
            keywords: [
              "non-fusible safety switch", "non fusible disconnect",
              "safety switch non-fused", "HD non-fusible", "AC disconnect switch",
            ],
          },
          {
            slug: "other-disconnects",
            label: "Other Disconnects",
            keywords: [
              "disconnect switch", "motor disconnect", "enclosed disconnect",
            ],
          },
        ],
      },
      {
        slug: "surge-protection",
        label: "Surge Protection",
        itemTypes: [
          {
            slug: "whole-house-panel-spds",
            label: "Whole-House/Panel SPDs",
            keywords: [
              "SPD", "surge protective device", "whole house surge",
              "panel surge protector", "type 1 SPD", "type 2 SPD",
              "service entrance surge",
            ],
          },
          {
            slug: "point-of-use-surge-protectors",
            label: "Point-of-Use Surge Protectors",
            keywords: [
              "surge protector", "point of use surge", "outlet surge strip",
              "power strip surge",
            ],
          },
          {
            slug: "other-surge-protection",
            label: "Other Surge Protection",
            keywords: [
              "transient voltage suppressor", "MOV", "TVS diode",
            ],
          },
        ],
      },
      {
        slug: "transformers",
        label: "Transformers",
        itemTypes: [
          {
            slug: "control-buck-boost-transformers",
            label: "Control/Buck-Boost Transformers",
            keywords: [
              "transformer", "control transformer", "buck boost transformer",
              "step down transformer", "isolation transformer",
              "machine tool transformer", "CPT",
            ],
          },
          {
            slug: "other-transformers",
            label: "Other Transformers",
            keywords: [
              "dry type transformer", "distribution transformer",
              "autotransformer",
            ],
          },
        ],
      },
      {
        slug: "fuses",
        label: "Fuses",
        itemTypes: [
          {
            slug: "cartridge-fuses",
            label: "Cartridge Fuses",
            keywords: [
              "fuse", "cartridge fuse", "fusetron", "time delay fuse",
              "fast acting fuse", "current limiting fuse", "RK5 fuse",
              "Class J fuse", "Class CC fuse", "Fusetron fuse",
            ],
          },
          {
            slug: "glass-automotive-fuses",
            label: "Glass/Automotive Fuses",
            keywords: [
              "glass fuse", "automotive fuse", "mini fuse", "blade fuse",
              "AGC fuse", "MDL fuse", "ABC fuse",
            ],
          },
          {
            slug: "other-fuses",
            label: "Other Fuses",
            keywords: [
              "fuse block replacement", "fuse kit",
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
    subcategories: [
      {
        slug: "grounding-fittings",
        label: "Grounding Fittings",
        itemTypes: [
          {
            slug: "ground-rods-clamps",
            label: "Ground Rods & Clamps",
            keywords: [
              "ground rod", "grounding rod", "ground clamp", "earth rod",
              "copper ground rod", "ground rod clamp", "rod to wire clamp",
            ],
          },
          {
            slug: "grounding-connectors-clamps",
            label: "Grounding Connectors & Clamps",
            keywords: [
              "grounding connector", "grounding clamp", "ground lug",
              "ground bushing", "grounding wedge clamp", "acorn connector",
              "grounding coupling",
            ],
          },
          {
            slug: "other-grounding-fittings",
            label: "Other Grounding Fittings",
            keywords: [
              "grounding fitting", "ground pigtail", "EGB",
            ],
          },
        ],
      },
      {
        slug: "liquidtight-fittings",
        label: "Liquidtight Fittings",
        itemTypes: [
          {
            slug: "liquidtight-connectors",
            label: "Liquidtight Connectors",
            keywords: [
              "liquidtight connector", "liquid tight connector",
              "LFMC connector", "LFNC connector", "straight liquidtight",
              "90 liquidtight", "flex liquidtight",
            ],
          },
          {
            slug: "other-liquidtight-fittings",
            label: "Other Liquidtight Fittings",
            keywords: [
              "liquidtight fitting", "liquid tight fitting",
            ],
          },
        ],
      },
      {
        slug: "reducers-adapters",
        label: "Reducers & Adapters",
        itemTypes: [
          {
            slug: "conduit-reducers-adapters",
            label: "Conduit Reducers & Adapters",
            keywords: [
              "conduit reducer", "conduit adapter", "reducing bushing",
              "conduit bushing", "knockout adapter", "conduit chase nipple",
            ],
          },
          {
            slug: "nipples-extensions",
            label: "Nipples & Extensions",
            keywords: [
              "nipple", "conduit nipple", "close nipple",
              "extension nipple", "conduit extension",
            ],
          },
          {
            slug: "other-reducers-adapters",
            label: "Other Reducers & Adapters",
            keywords: [
              "conduit union", "conduit offset", "offset fitting",
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
    subcategories: [
      {
        slug: "hvac-controls",
        label: "HVAC Controls",
        itemTypes: [
          {
            slug: "thermostats",
            label: "Thermostats",
            keywords: [
              "thermostat", "HVAC thermostat", "programmable thermostat",
              "smart thermostat", "line voltage thermostat", "Honeywell thermostat",
              "White Rodgers thermostat",
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
          {
            slug: "other-hvac-controls",
            label: "Other HVAC Controls",
            keywords: [
              "HVAC control board", "defrost timer", "sequencer HVAC",
            ],
          },
        ],
      },
      {
        slug: "hvac-motors-components",
        label: "HVAC Motors & Components",
        itemTypes: [
          {
            slug: "hvac-fan-blower-motors",
            label: "HVAC Fan & Blower Motors",
            keywords: [
              "fan motor", "blower motor", "condenser fan motor",
              "furnace blower motor", "ECM motor", "draft inducer motor",
              "HVAC motor",
            ],
          },
          {
            slug: "capacitors-run-start",
            label: "Capacitors (Run/Start)",
            keywords: [
              "capacitor", "run capacitor", "start capacitor",
              "HVAC capacitor", "dual run capacitor", "round capacitor",
              "oval capacitor", "AC capacitor",
            ],
          },
          {
            slug: "other-hvac-components",
            label: "Other HVAC Components",
            keywords: [
              "HVAC component", "crankcase heater", "hard start kit",
            ],
          },
        ],
      },
      {
        slug: "hvac-disconnects-protection",
        label: "HVAC Disconnects & Protection",
        itemTypes: [
          {
            slug: "ac-disconnect-switches",
            label: "AC Disconnect Switches",
            keywords: [
              "AC disconnect", "air conditioner disconnect", "pull-out disconnect",
              "HVAC disconnect", "air handler disconnect", "heat pump disconnect",
            ],
          },
          {
            slug: "fuse-holders-blocks",
            label: "Fuse Holders & Blocks",
            keywords: [
              "fuse holder", "fuse block", "fuse holder block",
              "inline fuse holder", "fuse clip", "class R fuse block",
            ],
          },
          {
            slug: "other-hvac-protection",
            label: "Other HVAC Protection",
            keywords: [
              "HVAC protection", "surge protection HVAC", "overvoltage HVAC",
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
    subcategories: [
      {
        slug: "lighting-by-type",
        label: "By Type",
        itemTypes: [
          {
            slug: "led-bulbs",
            label: "LED Bulbs",
            keywords: [
              "LED bulb", "LED lamp", "LED A19", "LED PAR", "LED MR16",
              "LED GU10", "LED filament", "LED retrofit", "LED light bulb",
            ],
          },
          {
            slug: "fluorescent",
            label: "Fluorescent",
            keywords: [
              "fluorescent", "fluorescent lamp", "T8 lamp", "T12 lamp",
              "CFL", "compact fluorescent", "T5 lamp", "F32T8",
            ],
          },
          {
            slug: "fixtures",
            label: "Fixtures",
            keywords: [
              "fixture", "light fixture", "luminaire", "LED fixture",
              "wraparound", "strip fixture", "vapor tight", "high bay",
              "low bay", "wall pack", "area light",
            ],
          },
          {
            slug: "recessed-cans",
            label: "Recessed/Cans",
            keywords: [
              "recessed", "can light", "recessed fixture", "downlight",
              "pot light", "recess housing", "LED can", "IC rated recessed",
            ],
          },
          {
            slug: "other-lighting",
            label: "Other Lighting",
            keywords: [
              "HID lamp", "metal halide", "high pressure sodium", "ballast",
            ],
          },
        ],
      },
      {
        slug: "lighting-controls",
        label: "Lighting Controls",
        itemTypes: [
          {
            slug: "daylight-photocell-controls",
            label: "Daylight/Photocell Controls",
            keywords: [
              "photocell control", "daylight sensor", "photocontrol switch",
              "dusk to dawn control", "light sensitive switch",
            ],
          },
          {
            slug: "motion-occupancy-controls",
            label: "Motion & Occupancy Controls",
            keywords: [
              "motion sensor switch", "occupancy sensor switch",
              "vacancy sensor", "PIR switch", "motion lighting switch",
            ],
          },
          {
            slug: "dimmer-controls",
            label: "Dimmer Controls",
            keywords: [
              "dimmer", "dimmer switch", "0-10V dimmer", "LED dimmer",
              "Lutron dimmer", "Leviton dimmer", "slide dimmer",
            ],
          },
          {
            slug: "other-lighting-controls",
            label: "Other Lighting Controls",
            keywords: [
              "lighting control system", "relay panel lighting",
            ],
          },
        ],
      },
      {
        slug: "emergency-exit-lighting",
        label: "Emergency & Exit Lighting",
        itemTypes: [
          {
            slug: "exit-signs",
            label: "Exit Signs",
            keywords: [
              "exit sign", "LED exit", "exit light", "combination exit",
              "exit sign battery", "illuminated exit",
            ],
          },
          {
            slug: "emergency-lighting-units",
            label: "Emergency Lighting Units",
            keywords: [
              "emergency light", "emergency lighting", "inverter backup",
              "bug eye light", "emergency light fixture",
              "emergency ballast", "self-contained emergency",
            ],
          },
          {
            slug: "other-emergency-lighting",
            label: "Other Emergency Lighting",
            keywords: [
              "emergency backup", "central inverter", "emergency transfer",
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
    subcategories: [
      {
        slug: "overhead-wire-cable",
        label: "Overhead Wire & Cable",
        itemTypes: [
          {
            slug: "triplex-quadruplex-urd",
            label: "Triplex/Quadruplex URD",
            keywords: [
              "triplex", "quadruplex", "duplex URD", "overhead triplex",
              "aerial cable", "service drop triplex",
            ],
          },
          {
            slug: "aac-acsr-overhead",
            label: "AAC/ACSR Overhead Conductors",
            keywords: [
              "AAC", "ACSR", "overhead conductor", "bare conductor",
              "aluminum conductor steel reinforced", "all aluminum conductor",
              "stranded overhead",
            ],
          },
          {
            slug: "other-overhead-wire",
            label: "Other Overhead Wire",
            keywords: [
              "messenger cable", "overhead wire", "aerial bundled cable",
            ],
          },
        ],
      },
      {
        slug: "pole-hardware-insulators",
        label: "Pole Hardware & Insulators",
        itemTypes: [
          {
            slug: "insulators",
            label: "Insulators",
            keywords: [
              "insulator", "strain insulator", "line insulator",
              "pin insulator", "disc insulator", "suspension insulator",
            ],
          },
          {
            slug: "deadend-strain-clamps",
            label: "Deadend & Strain Clamps",
            keywords: [
              "deadend", "dead end clamp", "strain clamp", "preformed deadend",
              "compression deadend",
            ],
          },
          {
            slug: "other-pole-hardware",
            label: "Other Pole Hardware",
            keywords: [
              "pole hardware", "cross arm", "pole band", "guy wire",
            ],
          },
        ],
      },
      {
        slug: "underground-distribution",
        label: "Underground Distribution",
        itemTypes: [
          {
            slug: "urd-cable",
            label: "URD Cable",
            keywords: [
              "URD cable", "underground residential distribution",
              "secondary URD", "underground distribution cable",
              "15kV URD", "25kV URD",
            ],
          },
          {
            slug: "urd-splices-terminations",
            label: "URD Splices & Terminations",
            keywords: [
              "URD splice", "URD termination", "underground splice",
              "cold shrink splice", "heat shrink splice",
              "elbow termination", "loadbreak elbow",
            ],
          },
          {
            slug: "other-underground-distribution",
            label: "Other Underground Distribution",
            keywords: [
              "underground distribution", "duct bank", "cable vault",
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
    subcategories: [
      {
        slug: "data-telecom-cable",
        label: "Data & Telecom Cable",
        itemTypes: [
          {
            slug: "cat-5e",
            label: "Cat 5e",
            keywords: [
              "Cat 5e", "Cat5e", "category 5e", "CAT5e cable",
              "UTP Cat5e", "STP Cat5e",
            ],
          },
          {
            slug: "cat-6-6a",
            label: "Cat 6/6A",
            keywords: [
              "Cat 6", "Cat 6A", "Cat6", "Cat6A", "category 6",
              "CAT6 cable", "10GbE cable",
            ],
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
              "quad shield coax", "CATV cable",
            ],
          },
          {
            slug: "other-telecom-cable",
            label: "Other Telecom Cable",
            keywords: [
              "alarm cable", "security cable", "speaker wire",
              "telephone cable", "Cat 3",
            ],
          },
        ],
      },
      {
        slug: "data-connectors-jacks",
        label: "Data Connectors & Jacks",
        itemTypes: [
          {
            slug: "rj45-jacks-keystone",
            label: "RJ45 Jacks & Keystone Modules",
            keywords: [
              "RJ45 jack", "keystone jack", "keystone module",
              "Cat6 jack", "Cat5e jack", "patch panel jack",
            ],
          },
          {
            slug: "coax-connectors-splitters",
            label: "Coax Connectors & Splitters",
            keywords: [
              "coax connector", "coax splitter", "F connector",
              "BNC connector", "coax coupler", "CATV splitter",
            ],
          },
          {
            slug: "other-data-jacks-connectors",
            label: "Other Data Jacks & Connectors",
            keywords: [
              "data connector", "data jack", "LC connector", "SC connector",
              "ST connector", "fiber connector",
            ],
          },
        ],
      },
      {
        slug: "telecom-enclosures-patch-panels",
        label: "Telecom Enclosures & Patch Panels",
        itemTypes: [
          {
            slug: "patch-panels",
            label: "Patch Panels",
            keywords: [
              "patch panel", "Cat6 patch panel", "24 port patch",
              "48 port patch", "1U patch", "2U patch",
            ],
          },
          {
            slug: "telecom-enclosures-brackets",
            label: "Telecom Enclosures & Brackets",
            keywords: [
              "telecom enclosure", "network enclosure", "rack enclosure",
              "wall mount rack", "IDF enclosure", "data rack",
            ],
          },
          {
            slug: "other-telecom-enclosures",
            label: "Other Telecom Enclosures",
            keywords: [
              "patch panel enclosure", "telecom bracket",
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
    subcategories: [
      {
        slug: "hand-tools",
        label: "Hand Tools",
        itemTypes: [
          {
            slug: "pliers-cutters",
            label: "Pliers & Cutters",
            keywords: [
              "pliers", "cutter", "linesman pliers", "diagonal cutters",
              "needle nose", "wire cutter", "side cutters", "crimping pliers",
            ],
          },
          {
            slug: "screwdrivers-nut-drivers",
            label: "Screwdrivers & Nut Drivers",
            keywords: [
              "screwdriver", "nut driver", "insulated screwdriver",
              "flathead screwdriver", "Phillips screwdriver", "cabinet tip",
            ],
          },
          {
            slug: "fish-tape-pull-line",
            label: "Fish Tape & Pull Line",
            keywords: [
              "fish tape", "pull line", "fish line", "cable puller",
              "wire pulling line", "conduit fish tape", "fiberglass fish stick",
            ],
          },
          {
            slug: "conduit-benders",
            label: "Conduit Benders",
            keywords: [
              "conduit bender", "bender", "hickey", "hand bender",
              "EMT bender", "mechanical bender",
            ],
          },
          {
            slug: "other-hand-tools",
            label: "Other Hand Tools",
            keywords: [
              "wire stripper", "cable stripper", "BX cutter",
              "knockout punch", "reaming tool",
            ],
          },
        ],
      },
      {
        slug: "test-measurement",
        label: "Test & Measurement",
        itemTypes: [
          {
            slug: "multimeters",
            label: "Multimeters",
            keywords: [
              "multimeter", "volt meter", "digital multimeter", "DMM",
              "Fluke multimeter", "Klein multimeter",
            ],
          },
          {
            slug: "clamp-meters",
            label: "Clamp Meters",
            keywords: [
              "clamp meter", "clamp ammeter", "amp clamp",
              "clamp on meter", "Fluke clamp",
            ],
          },
          {
            slug: "circuit-testers-voltage-detectors",
            label: "Circuit Testers & Voltage Detectors",
            keywords: [
              "circuit tester", "voltage tester", "non-contact tester",
              "tick tracer", "solenoid tester", "wiggy",
            ],
          },
          {
            slug: "continuity-wire-testers",
            label: "Continuity & Wire Testers",
            keywords: [
              "continuity tester", "wire tracer", "tone generator",
              "cable tester", "wire locator",
            ],
          },
          {
            slug: "other-test-equipment",
            label: "Other Test Equipment",
            keywords: [
              "power quality meter", "oscilloscope", "insulation tester",
              "megger", "ground tester",
            ],
          },
        ],
      },
      {
        slug: "power-tool-accessories",
        label: "Power Tool Accessories",
        itemTypes: [
          {
            slug: "drill-bits-hole-saws",
            label: "Drill Bits & Hole Saws",
            keywords: [
              "drill bit", "hole saw", "spade bit", "ship auger",
              "self-feed bit", "step bit", "knockout set",
            ],
          },
          {
            slug: "saw-blades-cutting-accessories",
            label: "Saw Blades & Cutting Accessories",
            keywords: [
              "saw blade", "jig saw blade", "reciprocating blade",
              "Sawzall blade", "metal cutting blade",
            ],
          },
          {
            slug: "other-power-tool-accessories",
            label: "Other Power Tool Accessories",
            keywords: [
              "right angle drill", "right angle attachment",
              "flexible extension", "impact driver bit",
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
    subcategories: [
      {
        slug: "wire-cable-by-type",
        label: "By Type",
        itemTypes: [
          {
            slug: "thhn-thwn",
            label: "THHN/THWN Building Wire",
            keywords: [
              "THHN", "THWN", "THWN-2", "building wire", "stranded wire",
              "solid wire", "copper wire THHN", "aluminum THHN",
            ],
          },
          {
            slug: "romex-nm-b",
            label: "Romex/NM-B Cable",
            keywords: [
              "Romex", "NM-B", "NM cable", "non-metallic sheathed cable",
              "12-2 NM", "14-2 NM", "10-2 NM", "14-3 NM", "12-3 NM",
            ],
          },
          {
            slug: "mc-armored-cable",
            label: "MC/Armored Cable",
            keywords: [
              "MC cable", "armored cable", "AC cable", "BX cable",
              "metal clad cable", "12-2 MC", "12-3 MC", "14-2 MC",
            ],
          },
          {
            slug: "uf-underground-feeder",
            label: "UF Underground Feeder",
            keywords: [
              "UF cable", "underground feeder", "UF-B cable",
              "direct burial cable", "burial wire",
            ],
          },
          {
            slug: "ser-service-entrance",
            label: "SER/Service Entrance",
            keywords: [
              "SER cable", "service entrance cable", "SER aluminum",
              "service entrance conductor", "SEU cable",
            ],
          },
          {
            slug: "other-wire-cable",
            label: "Other Wire & Cable",
            keywords: [
              "SO cord", "SOOW", "flexible cord", "extension cord cable",
            ],
          },
        ],
      },
      {
        slug: "specialty-wire-cable",
        label: "Specialty Wire & Cable",
        itemTypes: [
          {
            slug: "control-cable",
            label: "Control Cable",
            keywords: [
              "control cable", "multi-conductor cable", "control wire",
              "shielded control cable", "instrumentation cable",
            ],
          },
          {
            slug: "tray-cable",
            label: "Tray Cable (TC)",
            keywords: [
              "tray cable", "TC cable", "TC-ER cable",
              "cable tray wire", "power limited tray cable", "PLTC",
            ],
          },
          {
            slug: "welding-cable",
            label: "Welding Cable",
            keywords: [
              "welding cable", "welding wire", "battery cable",
              "booster cable wire",
            ],
          },
          {
            slug: "low-voltage-thermostat-wire",
            label: "Low-Voltage/Thermostat Wire",
            keywords: [
              "thermostat wire", "low voltage wire", "18/2 wire", "18/5 wire",
              "bell wire", "doorbell wire", "irrigation wire",
            ],
          },
          {
            slug: "other-specialty-cable",
            label: "Other Specialty Cable",
            keywords: [
              "interlock armored", "fire alarm cable", "security cable specialty",
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
    subcategories: [
      {
        slug: "receptacles-by-type",
        label: "By Type",
        itemTypes: [
          {
            slug: "duplex-receptacles",
            label: "Duplex Receptacles",
            keywords: [
              "duplex receptacle", "duplex outlet", "15 amp outlet",
              "20 amp outlet", "standard outlet", "tamper resistant outlet",
              "TR receptacle",
            ],
          },
          {
            slug: "gfci-receptacles",
            label: "GFCI Receptacles",
            keywords: [
              "GFCI receptacle", "GFCI outlet", "ground fault receptacle",
              "GFI outlet", "GFCI duplex", "tamper resistant GFCI",
            ],
          },
          {
            slug: "usb-receptacles",
            label: "USB Receptacles",
            keywords: [
              "USB receptacle", "USB outlet", "USB charger outlet",
              "USB-A outlet", "USB-C outlet", "dual USB outlet",
            ],
          },
          {
            slug: "twist-lock-receptacles",
            label: "Twist-Lock Receptacles",
            keywords: [
              "twist lock", "twistlock", "locking receptacle",
              "NEMA L5", "NEMA L6", "NEMA L14", "NEMA L15",
              "30 amp locking", "20 amp locking",
            ],
          },
          {
            slug: "range-dryer-receptacles",
            label: "Range/Dryer Receptacles",
            keywords: [
              "range receptacle", "dryer receptacle", "30 amp dryer",
              "50 amp range", "NEMA 10-30", "NEMA 14-30", "NEMA 14-50",
              "dryer outlet", "range outlet",
            ],
          },
          {
            slug: "other-receptacles",
            label: "Other Receptacles",
            keywords: [
              "isolated ground receptacle", "hospital grade outlet",
              "single receptacle", "flush mount receptacle",
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
    subcategories: [
      {
        slug: "switches-by-type",
        label: "By Type",
        itemTypes: [
          {
            slug: "toggle-switches",
            label: "Toggle Switches",
            keywords: [
              "toggle switch", "single pole switch", "wall switch",
              "15 amp switch", "20 amp switch", "standard switch",
              "tamper resistant switch",
            ],
          },
          {
            slug: "3-way-switches",
            label: "3-Way Switches",
            keywords: [
              "3-way switch", "three way switch", "3 way",
              "three-way toggle",
            ],
          },
          {
            slug: "4-way-switches",
            label: "4-Way Switches",
            keywords: [
              "4-way switch", "four way switch", "4 way",
              "four-way toggle",
            ],
          },
          {
            slug: "dimmers",
            label: "Dimmers",
            keywords: [
              "dimmer switch", "dimmer", "slide dimmer", "rotary dimmer",
              "LED dimmer switch", "0-10V dim switch",
            ],
          },
          {
            slug: "occupancy-sensors",
            label: "Occupancy Sensors",
            keywords: [
              "occupancy sensor", "motion switch", "vacancy sensor",
              "PIR switch sensor", "occupancy sensor switch",
            ],
          },
          {
            slug: "other-switches",
            label: "Other Switches",
            keywords: [
              "double pole switch", "DPST switch", "SPST switch",
              "combination switch", "decorator switch",
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
    subcategories: [
      {
        slug: "connectors-by-type",
        label: "By Type",
        itemTypes: [
          {
            slug: "wire-nuts",
            label: "Wire Nuts",
            keywords: [
              "wire nut", "wire connector", "wire-nut", "twist-on connector",
              "wire cap", "Ideal wire nut", "3M scotchlok",
            ],
          },
          {
            slug: "lugs",
            label: "Lugs",
            keywords: [
              "lug", "compression lug", "cable lug", "mechanical lug",
              "aluminum lug", "copper lug", "ring terminal lug",
              "set screw lug",
            ],
          },
          {
            slug: "terminal-blocks",
            label: "Terminal Blocks",
            keywords: [
              "terminal block", "DIN rail terminal", "barrier terminal",
              "screw terminal block", "feed through terminal",
            ],
          },
          {
            slug: "other-connectors",
            label: "Other Connectors",
            keywords: [
              "connector", "termination", "splice", "butt splice",
              "push-in connector", "WAGO connector",
            ],
          },
        ],
      },
    ],
  },

  // ── 18. Uncategorized (catch-all) ─────────────────────────────────────────
  {
    slug: "uncategorized",
    label: "Uncategorized",
    color: "#9CA3AF",
    subcategories: [
      {
        slug: "needs-review",
        label: "Needs Review",
        itemTypes: [
          {
            slug: "unclassified-items",
            label: "Unclassified Items",
            keywords: [], // No keywords — items that match NOTHING else
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

/** Returns all keywords from the taxonomy, excluding the uncategorized catch-all. */
export function getAllTaxonomyKeywords(taxonomy: TaxonomyCategory[]): string[] {
  const all = new Set<string>();
  for (const cat of taxonomy) {
    if (cat.slug === "uncategorized") continue;
    for (const kw of collectKeywords(cat)) all.add(kw);
  }
  return Array.from(all);
}
