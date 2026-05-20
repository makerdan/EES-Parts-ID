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
              "drop-in anchor", "strike anchor", "Tapcon", "expansion anchor",
              "hilti", "ramset", "concrete screw", "masonry screw",
            ],
          },
          {
            slug: "wood-screws-anchors",
            label: "Wood Screws & Anchors",
            keywords: [
              "wood screw", "lag bolt", "lag screw", "structural screw",
              "hex head wood screw", "self-tapping screw", "sheet metal screw",
            ],
          },
          {
            slug: "hollow-wall-anchors",
            label: "Hollow Wall Anchors",
            keywords: [
              "hollow wall anchor", "drywall anchor", "toggle bolt", "molly bolt",
              "SnapToggle", "wall anchor", "plastic anchor",
            ],
          },
          {
            slug: "strut-nuts-bolts",
            label: "Strut Nuts & Bolts",
            keywords: [
              "strut nut", "channel nut", "spring nut", "strut bolt",
              "framing fastener", "Kindorf nut", "Unistrut nut", "channel bolt",
            ],
          },
        ],
      },
      {
        slug: "hangers-supports",
        label: "Hangers & Supports",
        itemTypes: [
          {
            slug: "pipe-conduit-hangers",
            label: "Pipe & Conduit Hangers",
            keywords: [
              "conduit hanger", "pipe hanger", "strut clamp", "conduit strap",
              "one-hole strap", "two-hole strap", "EMT strap", "IMC strap",
              "RMC strap", "pipe strap", "conduit clamp", "hanger strap",
            ],
          },
          {
            slug: "j-hooks-cable-support",
            label: "J-Hooks & Cable Support",
            keywords: [
              "J-hook", "cable hook", "cable support", "wire support",
              "bridle ring", "cable J hook", "cable tray hook",
            ],
          },
          {
            slug: "beam-clamps",
            label: "Beam Clamps",
            keywords: [
              "beam clamp", "I-beam clamp", "C-clamp beam", "flange clamp",
              "beam attachment", "structural beam clamp",
            ],
          },
          {
            slug: "threaded-rod-kits",
            label: "Threaded Rod & Hanger Kits",
            keywords: [
              "threaded rod", "hanger kit", "all-thread rod", "rod hanger",
              "hanger rod", "drop rod", "conduit hanger kit",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "boxes-enclosures",
    label: "Boxes & Enclosures",
    color: "#F59E0B",
    subcategories: [
      {
        slug: "electrical-boxes",
        label: "Electrical Boxes",
        itemTypes: [
          {
            slug: "single-gang-boxes",
            label: "Single Gang Device Boxes",
            keywords: [
              "old work box", "cut-in box", "remodel box", "new work box",
              "single gang box", "plastic device box", "1 gang box",
              "device box single", "blue box single gang",
            ],
          },
          {
            slug: "multi-gang-boxes",
            label: "Multi-Gang Device Boxes",
            keywords: [
              "two gang box", "three gang box", "multi gang box",
              "2 gang box", "3 gang box", "4 gang box", "multi-gang device box",
            ],
          },
          {
            slug: "weatherproof-boxes",
            label: "Weatherproof Boxes",
            keywords: [
              "weatherproof box", "outdoor box", "in-use box",
              "WP box", "outdoor device box", "wet location box",
              "exterior box", "RACO outdoor",
            ],
          },
          {
            slug: "octagon-boxes",
            label: "Octagon & Ceiling Boxes",
            keywords: [
              "octagon box", "round box", "4-inch round box", "4 inch octagon",
              "fixture box", "pancake box", "ceiling box", "round pan",
              "4 octagon", "ceiling fixture box",
            ],
          },
          {
            slug: "square-boxes-mud-rings",
            label: "Square Boxes & Mud Rings",
            keywords: [
              "square box", "4-inch square box", "4 square", "4-11/16 square",
              "plaster ring", "mud ring", "extension ring", "raised cover",
              "4S box", "flat box square",
            ],
          },
        ],
      },
      {
        slug: "enclosures-cabinets",
        label: "Enclosures & Cabinets",
        itemTypes: [
          {
            slug: "nema1-enclosures",
            label: "NEMA 1 Enclosures",
            keywords: [
              "NEMA 1 enclosure", "indoor enclosure", "pull box",
              "splice box", "hinged cover enclosure", "junction box enclosure",
              "sheet metal enclosure", "surface mount enclosure",
            ],
          },
          {
            slug: "nema3r-4x-enclosures",
            label: "NEMA 3R / 4 / 4X Enclosures",
            keywords: [
              "NEMA 3R", "NEMA 4", "NEMA 4X", "weatherproof enclosure",
              "outdoor enclosure", "fiberglass enclosure", "stainless enclosure",
              "rainproof enclosure", "IP66 enclosure",
            ],
          },
          {
            slug: "underground-boxes",
            label: "Underground & Concrete Boxes",
            keywords: [
              "underground box", "concrete box", "direct burial box",
              "tier 15", "polymer concrete box", "handhole",
              "underground pull box", "in-ground box",
            ],
          },
        ],
      },
      {
        slug: "covers-accessories",
        label: "Covers & Accessories",
        itemTypes: [
          {
            slug: "device-box-covers",
            label: "Device Box Covers & Wall Plates",
            keywords: [
              "blank cover", "device cover", "outlet cover", "switch plate",
              "wall plate", "face plate", "cover plate single gang",
              "cover plate two gang", "decorator plate", "duplex cover",
            ],
          },
          {
            slug: "weatherproof-covers",
            label: "Weatherproof Covers",
            keywords: [
              "weatherproof cover", "while-in-use cover", "in-use cover",
              "extra deep cover", "outdoor outlet cover", "WP cover",
              "in-use weatherproof cover",
            ],
          },
          {
            slug: "knockout-seals-plugs",
            label: "Knockout Seals & Plugs",
            keywords: [
              "knockout seal", "KO seal", "knockout plug", "snap-in connector",
              "blank plug", "conduit knockout seal", "Romex connector",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "builders-products",
    label: "Builders Products",
    color: "#10B981",
    subcategories: [
      {
        slug: "residential-construction",
        label: "Residential Construction",
        itemTypes: [
          {
            slug: "vapor-barriers-wrap",
            label: "Vapor Barriers & Wrap",
            keywords: [
              "vapor barrier", "house wrap", "poly sheeting", "plastic sheeting",
              "Tyvek", "water resistive barrier", "WRB",
            ],
          },
          {
            slug: "sealants-flashing",
            label: "Sealants & Flashing",
            keywords: [
              "electrical tape", "silicone sealant", "caulk", "mastic sealant",
              "sealing tape", "waterproof tape", "flashing tape",
            ],
          },
          {
            slug: "mud-plates",
            label: "Mud Rings & Plaster Rings",
            keywords: [
              "mud ring", "plaster ring", "tile ring", "ceramic tile ring",
              "mud plate", "depth ring", "tile adapter",
            ],
          },
        ],
      },
      {
        slug: "strut-support-systems",
        label: "Strut & Support Systems",
        itemTypes: [
          {
            slug: "strut-channel",
            label: "Strut Channel",
            keywords: [
              "strut channel", "Unistrut", "Kindorf", "Superstrut",
              "framing channel", "slotted channel", "B-Line", "1-5/8 channel",
              "3/4 strut", "half slot strut", "strut rail",
            ],
          },
          {
            slug: "strut-fittings",
            label: "Strut Fittings",
            keywords: [
              "strut fitting", "strut bracket", "strut plate", "strut angle",
              "channel connector", "pipe clamp strut", "beam fitting",
              "strut post base", "channel nut plate",
            ],
          },
          {
            slug: "seismic-bracing",
            label: "Seismic Bracing",
            keywords: [
              "seismic brace", "sway brace", "earthquake brace",
              "seismic clamp", "seismic strap", "sway strut", "seismic support",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "conduit-raceway",
    label: "Conduit & Raceway",
    color: "#3B82F6",
    subcategories: [
      {
        slug: "metal-conduit",
        label: "Metal Conduit",
        itemTypes: [
          {
            slug: "emt",
            label: "EMT",
            keywords: [
              "EMT", "electrical metallic tubing", "thin wall",
              "thin-wall conduit", "steel conduit EMT", "EMT conduit",
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
            slug: "rigid-grs-rmc",
            label: "Rigid (GRS/RMC)",
            keywords: [
              "RMC", "GRS", "rigid metallic conduit", "rigid steel conduit",
              "rigid threaded conduit", "galvanized rigid conduit",
              "heavy wall conduit", "rigid conduit",
            ],
          },
          {
            slug: "flexible-metallic",
            label: "Flexible Metallic Conduit",
            keywords: [
              "FMC", "flex conduit", "flexible metal conduit", "Greenfield",
              "steel flex", "LFMC", "liquidtight metallic conduit",
              "liquidtight flex metallic",
            ],
          },
        ],
      },
      {
        slug: "non-metallic-conduit",
        label: "Non-Metallic Conduit",
        itemTypes: [
          {
            slug: "ent",
            label: "ENT",
            keywords: [
              "ENT", "smurf tube", "corrugated ENT", "non-metallic flex",
              "coil conduit", "flexible ENT", "orange flex conduit",
              "electrical non-metallic tubing",
            ],
          },
          {
            slug: "pvc-conduit",
            label: "PVC Conduit",
            keywords: [
              "PVC conduit", "schedule 40 PVC", "schedule 80 PVC",
              "gray PVC", "rigid PVC conduit", "sch 40 PVC", "sch 80 PVC",
            ],
          },
          {
            slug: "hdpe-cpvc",
            label: "HDPE / CPVC / DB Conduit",
            keywords: [
              "HDPE conduit", "CPVC conduit", "direct burial conduit",
              "underground conduit", "DB60", "DB120", "plastic duct",
            ],
          },
          {
            slug: "lfnc",
            label: "LFNC",
            keywords: [
              "LFNC", "liquidtight non-metallic", "non-metallic liquidtight",
              "liquid tight non-metallic flex",
            ],
          },
        ],
      },
      {
        slug: "raceway-duct",
        label: "Raceway & Duct",
        itemTypes: [
          {
            slug: "wireway-gutter",
            label: "Wireway & Gutter",
            keywords: [
              "wireway", "wire gutter", "lay-in wireway", "hinged wireway",
              "screw-cover wireway", "auxiliary gutter", "pull-through",
              "trough wireway",
            ],
          },
          {
            slug: "cable-tray",
            label: "Cable Tray",
            keywords: [
              "cable tray", "ladder tray", "ventilated trough",
              "perforated tray", "cable tray section", "wire basket tray",
              "center spine tray",
            ],
          },
          {
            slug: "surface-raceway",
            label: "Surface Raceway",
            keywords: [
              "surface raceway", "Wiremold", "raceway duct", "pvc raceway",
              "floor raceway", "cord cover", "cable cover", "baseboard raceway",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "motors-controls-sensors",
    label: "Motors, Controls & Sensors",
    color: "#EF4444",
    subcategories: [
      {
        slug: "starters-contactors",
        label: "Motor Starters & Contactors",
        itemTypes: [
          {
            slug: "manual-motor-starters",
            label: "Manual Motor Starters",
            keywords: [
              "manual motor starter", "motor disconnect switch",
              "motor protection switch", "pushbutton motor starter",
              "manual starter", "fractional motor starter",
            ],
          },
          {
            slug: "magnetic-motor-starters",
            label: "Magnetic Motor Starters",
            keywords: [
              "magnetic motor starter", "NEMA motor starter",
              "full voltage starter", "across-the-line starter",
              "motor starter", "motor starter kit", "combination starter",
            ],
          },
          {
            slug: "contactors",
            label: "Contactors",
            keywords: [
              "contactor", "definite purpose contactor", "lighting contactor",
              "IEC contactor", "NEMA contactor", "3-pole contactor",
              "power contactor", "DP contactor",
            ],
          },
        ],
      },
      {
        slug: "variable-frequency-drives",
        label: "Variable Frequency Drives",
        itemTypes: [
          {
            slug: "vfd",
            label: "Variable Frequency Drives",
            keywords: [
              "variable frequency drive", "VFD", "variable speed drive",
              "AC drive", "inverter drive", "frequency inverter",
              "adjustable speed drive", "soft starter",
            ],
          },
        ],
      },
      {
        slug: "push-buttons-pilot",
        label: "Push Buttons & Pilot Devices",
        itemTypes: [
          {
            slug: "push-buttons",
            label: "Push Buttons & Operator Stations",
            keywords: [
              "push button", "pushbutton", "pilot light", "selector switch",
              "pilot device", "stop start button", "pushbutton station",
              "operator station",
            ],
          },
          {
            slug: "estop-operators",
            label: "E-Stop & Enclosure Operators",
            keywords: [
              "E-stop", "emergency stop", "maintained contact",
              "indicating light", "selector", "operator", "enclosure operator",
              "mushroom head", "palm button",
            ],
          },
        ],
      },
      {
        slug: "sensors-timers",
        label: "Sensors & Timers",
        itemTypes: [
          {
            slug: "occupancy-sensors",
            label: "Occupancy & Motion Sensors",
            keywords: [
              "occupancy sensor", "motion sensor", "PIR sensor",
              "passive infrared", "vacancy sensor", "dual tech sensor",
              "wall switch sensor", "ceiling sensor", "line voltage sensor",
            ],
          },
          {
            slug: "timers-clocks",
            label: "Timers & Time Clocks",
            keywords: [
              "timer", "time clock", "astronomical timer",
              "mechanical timer", "digital timer", "7-day timer",
              "24-hour timer", "NSI timer", "outdoor timer",
            ],
          },
          {
            slug: "photocontrols",
            label: "Photocontrols & Photocells",
            keywords: [
              "photocell", "photocontrol", "dusk to dawn",
              "twist-lock photocell", "photoelectric control",
              "dusk-to-dawn control", "photo eye",
            ],
          },
          {
            slug: "proximity-limit-switches",
            label: "Proximity & Limit Switches",
            keywords: [
              "proximity switch", "limit switch", "float switch",
              "level switch", "reed switch", "snap action switch",
              "prox switch",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "breakers-fuses",
    label: "Breakers & Fuses",
    color: "#F97316",
    subcategories: [
      {
        slug: "circuit-breakers",
        label: "Circuit Breakers",
        itemTypes: [
          {
            slug: "single-pole-breakers",
            label: "Single Pole Breakers",
            keywords: [
              "single pole breaker", "1 pole breaker", "1P breaker",
              "single pole circuit breaker", "SP breaker",
              "BR120", "BR115", "QO120", "QO115", "CH120", "CH115",
              "HOM115", "HOM120",
            ],
          },
          {
            slug: "double-pole-breakers",
            label: "Double Pole Breakers",
            keywords: [
              "double pole breaker", "2 pole breaker", "2P breaker",
              "240V breaker", "double pole circuit breaker",
              "BR230", "BR240", "QO230", "QO240", "CH230", "CH240",
              "HOM230", "HOM260",
            ],
          },
          {
            slug: "three-pole-breakers",
            label: "3-Pole Breakers",
            keywords: [
              "3 pole breaker", "three pole breaker", "3P breaker",
              "motor branch breaker", "three phase breaker",
              "3 pole circuit breaker", "3P circuit breaker",
            ],
          },
          {
            slug: "afci-breakers",
            label: "AFCI Breakers",
            keywords: [
              "AFCI breaker", "arc fault breaker", "arc fault circuit interrupter",
              "CAFCI", "combination arc fault", "arc fault breaker",
            ],
          },
          {
            slug: "gfci-breakers",
            label: "GFCI Breakers",
            keywords: [
              "GFCI breaker", "GFCI circuit breaker", "ground fault breaker",
              "GF breaker", "ground fault circuit interrupter breaker",
            ],
          },
          {
            slug: "afci-gfci-combo-breakers",
            label: "Dual Function AFCI/GFCI Breakers",
            keywords: [
              "dual function breaker", "AFCI GFCI breaker",
              "combination AFCI GFCI", "dual function circuit interrupter",
            ],
          },
          {
            slug: "tandem-breakers",
            label: "Tandem / Duplex Breakers",
            keywords: [
              "tandem breaker", "duplex breaker", "slimline breaker",
              "twin breaker", "half-size breaker", "CTL breaker",
            ],
          },
          {
            slug: "main-breakers",
            label: "Main Breakers",
            keywords: [
              "main breaker", "main circuit breaker", "main lug breaker",
              "200A main breaker", "100A main breaker", "main disconnect breaker",
              "service entrance breaker",
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
              "cartridge fuse", "Class J fuse", "Class CC fuse",
              "Class RK1 fuse", "Class RK5 fuse", "Buss fuse",
              "LPS fuse", "LPN fuse", "Fusetron fuse",
              "current limiting fuse", "time delay fuse",
            ],
          },
          {
            slug: "plug-fuses",
            label: "Plug Fuses",
            keywords: [
              "plug fuse", "Edison fuse", "type T fuse", "type P fuse",
              "rejection fuse", "S-type fuse", "tamper-proof fuse",
              "screw in fuse",
            ],
          },
          {
            slug: "fuse-holders",
            label: "Fuse Holders & Pullers",
            keywords: [
              "fuse holder", "fuse block", "fuse puller", "fuse clip",
              "fuse panel holder", "cartridge fuse holder", "midget fuse block",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "panels-distribution",
    label: "Panels & Distribution",
    color: "#06B6D4",
    subcategories: [
      {
        slug: "load-centers",
        label: "Load Centers & Panelboards",
        itemTypes: [
          {
            slug: "residential-load-centers",
            label: "Residential Load Centers",
            keywords: [
              "load center", "electrical panel", "breaker panel",
              "main panel", "sub panel", "subpanel",
              "200A panel", "100A panel", "main breaker load center",
              "main lug panel", "QO panel", "BR panel", "CH panel", "HOM panel",
            ],
          },
          {
            slug: "commercial-panelboards",
            label: "Commercial Panelboards",
            keywords: [
              "NEMA 1 panel", "lighting and appliance panelboard",
              "panelboard", "NQ panel", "NF panel", "LP panel",
              "circuit directory panel", "commercial panel",
            ],
          },
        ],
      },
      {
        slug: "meter-service",
        label: "Meter Sockets & Service Entrance",
        itemTypes: [
          {
            slug: "meter-sockets",
            label: "Meter Sockets",
            keywords: [
              "meter socket", "meter base", "meter can", "meter box",
              "ringless meter socket", "overhead meter socket",
              "underground meter socket", "200A meter base", "200A meter socket",
            ],
          },
          {
            slug: "ct-cabinets",
            label: "CT Cabinets",
            keywords: [
              "CT cabinet", "current transformer cabinet",
              "metering cabinet", "CT metering enclosure",
            ],
          },
          {
            slug: "service-entrance",
            label: "Service Entrance Equipment",
            keywords: [
              "service entrance equipment", "service disconnect",
              "main service", "utility meter disconnect",
              "master disconnect", "weatherhead assembly",
            ],
          },
        ],
      },
      {
        slug: "transfer-accessories",
        label: "Transfer Switches & Bus Accessories",
        itemTypes: [
          {
            slug: "transfer-switches",
            label: "Transfer Switches",
            keywords: [
              "transfer switch", "automatic transfer switch", "ATS",
              "manual transfer switch", "generator transfer switch",
              "interlock kit", "generator interlock", "MTS",
            ],
          },
          {
            slug: "bus-bars",
            label: "Bus Bars & Neutral Kits",
            keywords: [
              "bus bar", "neutral bar", "ground bar", "neutral kit",
              "grounding bar", "main bonding jumper", "bonding screw",
              "neutral assembly",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "fittings",
    label: "Fittings",
    color: "#84CC16",
    subcategories: [
      {
        slug: "emt-fittings",
        label: "EMT Fittings",
        itemTypes: [
          {
            slug: "emt-couplings",
            label: "EMT Couplings",
            keywords: [
              "EMT coupling", "set screw coupling EMT", "compression coupling EMT",
              "EMT set screw coupling", "EMT compression coupling",
            ],
          },
          {
            slug: "emt-connectors",
            label: "EMT Connectors",
            keywords: [
              "EMT connector", "EMT set screw connector",
              "EMT compression connector", "snap-in connector EMT",
              "EMT connector for box",
            ],
          },
          {
            slug: "conduit-nipples",
            label: "Conduit Nipples & Chase",
            keywords: [
              "conduit nipple", "close nipple", "chase nipple",
              "offset nipple", "hex nipple conduit",
              "chase conduit", "all-thread nipple",
            ],
          },
        ],
      },
      {
        slug: "rigid-imc-fittings",
        label: "Rigid / IMC Fittings",
        itemTypes: [
          {
            slug: "rigid-couplings",
            label: "Rigid / IMC Couplings",
            keywords: [
              "rigid coupling", "IMC coupling", "GRS coupling",
              "threaded coupling rigid", "threaded IMC coupling",
            ],
          },
          {
            slug: "rigid-connectors",
            label: "Rigid / IMC Connectors",
            keywords: [
              "rigid connector", "IMC connector",
              "insulated throat connector rigid",
              "rigid conduit connector",
            ],
          },
          {
            slug: "erickson-couplings",
            label: "Erickson / Union Couplings",
            keywords: [
              "Erickson coupling", "union coupling",
              "three-piece coupling", "3-piece coupling", "raintight coupling",
            ],
          },
          {
            slug: "rigid-elbows-bodies",
            label: "Rigid Elbows & Bodies",
            keywords: [
              "rigid elbow", "IMC elbow", "GRS elbow",
              "90 degree rigid", "45 degree rigid", "condulet rigid",
            ],
          },
        ],
      },
      {
        slug: "pvc-fittings",
        label: "PVC Fittings",
        itemTypes: [
          {
            slug: "pvc-couplings-adapters",
            label: "PVC Couplings & Adapters",
            keywords: [
              "PVC coupling", "PVC conduit coupling", "PVC male adapter",
              "PVC female adapter", "PVC terminal adapter",
            ],
          },
          {
            slug: "pvc-bodies",
            label: "PVC Conduit Bodies",
            keywords: [
              "PVC LB", "conduit body PVC", "LB body PVC", "LR body PVC",
              "LL body PVC", "T body PVC", "condulet PVC", "PVC conduit body",
            ],
          },
          {
            slug: "pvc-elbows",
            label: "PVC Elbows",
            keywords: [
              "PVC elbow", "PVC conduit elbow", "PVC 90", "PVC sweep elbow",
              "bell end elbow PVC", "PVC 45 elbow", "sch 40 elbow PVC",
            ],
          },
        ],
      },
      {
        slug: "flexible-fittings",
        label: "Flexible Fittings",
        itemTypes: [
          {
            slug: "liquidtight-connectors",
            label: "Liquid-Tight Connectors",
            keywords: [
              "liquidtight connector", "liquid tight fitting",
              "LFMC connector", "LFNC connector",
              "flex conduit connector liquidtight",
              "liquidtight straight connector", "liquidtight 90 connector",
            ],
          },
          {
            slug: "fmc-connectors",
            label: "FMC Connectors",
            keywords: [
              "FMC connector", "flexible conduit connector",
              "Greenfield connector", "flex conduit fitting",
              "flexible metallic connector",
            ],
          },
          {
            slug: "strain-relief",
            label: "Strain Relief & Cord Grips",
            keywords: [
              "strain relief", "cord grip", "cable grip",
              "kellems grip", "wire mesh grip", "cord connector strain",
              "nylon strain relief", "metal strain relief",
            ],
          },
        ],
      },
      {
        slug: "conduit-bodies-seals",
        label: "Conduit Bodies & Seals",
        itemTypes: [
          {
            slug: "lb-lr-ll-bodies",
            label: "LB / LR / LL Bodies",
            keywords: [
              "LB body", "LR body", "LL body", "condulet",
              "conduit body", "Form 35", "Form 8", "unilet body",
              "mogul conduit body", "conduit elbow body",
            ],
          },
          {
            slug: "t-c-bodies",
            label: "T & C Bodies",
            keywords: [
              "T body", "C body", "condulet T", "condulet C",
              "straight pull body", "conduit body T", "conduit body C",
            ],
          },
          {
            slug: "sealing-fittings",
            label: "Sealing Fittings",
            keywords: [
              "sealing fitting", "sealtite", "EYS sealing fitting",
              "EYD sealing fitting", "explosionproof sealing fitting",
              "drain seal", "mogul seal", "EZS seal",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "hvac",
    label: "HVAC Electrical",
    color: "#EC4899",
    subcategories: [
      {
        slug: "hvac-electrical",
        label: "HVAC Controls & Wiring",
        itemTypes: [
          {
            slug: "hvac-disconnects",
            label: "HVAC Disconnect Switches",
            keywords: [
              "HVAC disconnect", "AC disconnect", "air conditioner disconnect",
              "non-fused disconnect", "fused disconnect", "pull-out disconnect",
              "60A disconnect", "30A disconnect", "safety switch HVAC",
              "air conditioner safety switch",
            ],
          },
          {
            slug: "hvac-contactors-capacitors",
            label: "Contactors & Capacitors",
            keywords: [
              "HVAC contactor", "run capacitor", "start capacitor",
              "motor capacitor", "dual run capacitor", "run and start capacitor",
              "AC capacitor", "HVAC run capacitor",
            ],
          },
          {
            slug: "thermostat-wire",
            label: "Thermostat Wire & Cable",
            keywords: [
              "thermostat wire", "thermostat cable",
              "18-5 thermostat", "18-8 thermostat", "low voltage wire",
              "stat wire", "2 wire thermostat", "thermostat control wire",
            ],
          },
          {
            slug: "low-voltage-controls",
            label: "Low Voltage Controls",
            keywords: [
              "thermostat relay", "24V relay", "HVAC relay",
              "low voltage control", "zone valve", "zone controller",
              "24 volt relay", "low voltage switching relay",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "lighting",
    label: "Lighting",
    color: "#FBBF24",
    subcategories: [
      {
        slug: "commercial-luminaires",
        label: "Commercial Luminaires",
        itemTypes: [
          {
            slug: "led-fixtures",
            label: "LED Fixtures",
            keywords: [
              "LED fixture", "LED luminaire", "LED troffer", "LED panel light",
              "LED wrap", "LED strip light fixture", "LED high bay",
              "vapor tight LED", "LED shop light", "LED area light",
              "LED flood light",
            ],
          },
          {
            slug: "hid-fixtures",
            label: "HID Fixtures",
            keywords: [
              "HID fixture", "metal halide fixture", "high pressure sodium fixture",
              "HPS fixture", "MH fixture", "high bay HID", "shoebox fixture HID",
              "HID area light",
            ],
          },
          {
            slug: "fluorescent-fixtures",
            label: "Fluorescent Fixtures",
            keywords: [
              "fluorescent fixture", "T8 fixture", "T5 fixture",
              "shop light fluorescent", "strip fixture",
              "vapor tight fluorescent", "2x4 fluorescent", "4ft fluorescent",
            ],
          },
          {
            slug: "exit-emergency-lights",
            label: "Exit & Emergency Lights",
            keywords: [
              "exit light", "emergency light", "exit sign",
              "combo exit emergency", "LED exit sign", "bug eye emergency",
              "twin head emergency", "emergency unit",
            ],
          },
        ],
      },
      {
        slug: "lamps-bulbs",
        label: "Lamps & Bulbs",
        itemTypes: [
          {
            slug: "led-lamps",
            label: "LED Lamps",
            keywords: [
              "LED bulb", "LED lamp", "A19 LED", "BR30 LED", "PAR38 LED",
              "LED tube", "T8 LED tube", "LED retrofit lamp", "LED MR16",
              "LED corn lamp",
            ],
          },
          {
            slug: "hid-lamps",
            label: "HID Lamps",
            keywords: [
              "metal halide lamp", "high pressure sodium lamp",
              "mercury vapor lamp", "HID lamp", "MH lamp", "HPS lamp", "MV lamp",
              "ED28 lamp", "ED37 lamp",
            ],
          },
          {
            slug: "fluorescent-lamps",
            label: "Fluorescent Lamps",
            keywords: [
              "fluorescent lamp", "T8 lamp", "T12 lamp", "T5 lamp",
              "linear fluorescent", "CFL lamp", "compact fluorescent",
              "F32T8 lamp", "F40T12 lamp",
            ],
          },
        ],
      },
      {
        slug: "lighting-controls",
        label: "Lighting Controls & Ballasts",
        itemTypes: [
          {
            slug: "led-drivers",
            label: "LED Drivers",
            keywords: [
              "LED driver", "constant current driver", "constant voltage driver",
              "emergency driver", "LED power supply", "dimmable LED driver",
            ],
          },
          {
            slug: "ballasts",
            label: "Ballasts",
            keywords: [
              "ballast", "T8 ballast", "fluorescent ballast",
              "electronic ballast", "magnetic ballast", "HID ballast",
              "CWA ballast", "HX-HPF ballast", "F32T8 ballast",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "line-construction",
    label: "Line Construction",
    color: "#6366F1",
    subcategories: [
      {
        slug: "utility-hardware",
        label: "Utility Hardware",
        itemTypes: [
          {
            slug: "insulators",
            label: "Insulators",
            keywords: [
              "insulator", "dead end insulator", "strain insulator",
              "suspension insulator", "porcelain insulator", "glass insulator",
              "standoff insulator", "guy insulator",
            ],
          },
          {
            slug: "crossarms-hardware",
            label: "Crossarms & Hardware",
            keywords: [
              "crossarm", "crossarm brace", "cross arm bolt", "gain mounting",
              "lag screw insulator", "rack insulator", "crossarm strap",
            ],
          },
          {
            slug: "cutouts-arresters",
            label: "Cutouts & Arresters",
            keywords: [
              "cutout", "fuse cutout", "dropout fuse", "expulsion fuse",
              "lightning arrester", "surge arrester", "MOV arrester",
              "dead front arrester", "distribution arrester",
            ],
          },
        ],
      },
      {
        slug: "service-entry",
        label: "Service Entry",
        itemTypes: [
          {
            slug: "weatherheads-risers",
            label: "Weatherheads & Risers",
            keywords: [
              "weatherhead", "mast head", "service head",
              "service entrance cap", "service mast", "EMT mast",
              "riser conduit", "service entrance conduit", "service riser",
            ],
          },
          {
            slug: "service-entry-conductors",
            label: "Service Entrance Conductors",
            keywords: [
              "service entrance cable", "SE cable", "SER cable",
              "SER aluminum cable", "service entrance wire", "URD cable",
              "SEU cable", "underground service conductor",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "telecom-data",
    label: "Telecom & Data",
    color: "#14B8A6",
    subcategories: [
      {
        slug: "low-voltage-cable",
        label: "Low Voltage Cable",
        itemTypes: [
          {
            slug: "data-cables",
            label: "Data & Network Cables",
            keywords: [
              "Cat5e", "Cat6", "Cat6A", "ethernet cable", "network cable",
              "patch cable", "data cable", "structured wiring cable",
              "plenum data cable", "Cat5", "UTP cable",
            ],
          },
          {
            slug: "coaxial-cable",
            label: "Coaxial Cable",
            keywords: [
              "coaxial cable", "RG6 cable", "RG11 cable", "coax cable",
              "CATV cable", "satellite cable", "quad shield coax",
            ],
          },
          {
            slug: "av-speaker-wire",
            label: "AV & Speaker Wire",
            keywords: [
              "speaker wire", "AV cable", "16/2 speaker", "18/2 speaker",
              "lamp cord", "parallel cord", "audio cable",
            ],
          },
        ],
      },
      {
        slug: "telecom-hardware",
        label: "Telecom Hardware",
        itemTypes: [
          {
            slug: "faceplates-jacks",
            label: "Faceplates & Data Jacks",
            keywords: [
              "data jack", "keystone jack", "data faceplate", "RJ45 jack",
              "Cat6 jack", "data outlet", "telecommunication outlet",
              "low voltage faceplate",
            ],
          },
          {
            slug: "low-voltage-boxes",
            label: "Low Voltage Brackets & Boxes",
            keywords: [
              "low voltage bracket", "low voltage ring", "old work bracket",
              "low voltage box", "data mounting bracket", "comm bracket",
              "LV mounting bracket",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "tools-testers",
    label: "Tools & Testers",
    color: "#64748B",
    subcategories: [
      {
        slug: "test-equipment",
        label: "Test Equipment",
        itemTypes: [
          {
            slug: "multimeters-clamp-meters",
            label: "Multimeters & Clamp Meters",
            keywords: [
              "multimeter", "clamp meter", "digital multimeter", "volt meter",
              "current clamp", "DMM", "ampere clamp", "Fluke meter",
              "clamp ammeter", "True RMS meter",
            ],
          },
          {
            slug: "circuit-voltage-testers",
            label: "Voltage & Circuit Testers",
            keywords: [
              "circuit tester", "non-contact voltage tester", "voltage tester",
              "wiggy tester", "circuit tracer", "Solenoid tester",
              "outlet tester", "GFCI tester", "receptacle tester",
            ],
          },
          {
            slug: "cable-identifiers",
            label: "Cable Identifiers & Tracers",
            keywords: [
              "cable identifier", "cable tracer", "tone generator",
              "tone probe", "circuit identifier", "cable locator",
              "fox and hound", "wire tracing kit",
            ],
          },
        ],
      },
      {
        slug: "hand-tools",
        label: "Hand Tools",
        itemTypes: [
          {
            slug: "wire-strippers-cutters",
            label: "Wire Strippers & Cutters",
            keywords: [
              "wire stripper", "wire cutter", "lineman pliers",
              "diagonal cutter", "Romex stripper", "cable ripper",
              "multi-stripper", "Klein stripper", "stripping tool",
            ],
          },
          {
            slug: "punch-crimp-tools",
            label: "Punch Down & Crimp Tools",
            keywords: [
              "punch down tool", "crimp tool", "ratchet crimper",
              "impact tool", "RJ45 crimper", "modular crimper",
              "wire termination tool", "Krone tool",
            ],
          },
          {
            slug: "conduit-tools",
            label: "Conduit Tools",
            keywords: [
              "conduit bender", "hickey bender", "half saddle bender",
              "mechanical bender", "hydraulic bender", "knockout punch",
              "slug buster", "conduit reamer", "pipe threader",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "wire-cable",
    label: "Wire & Cable",
    color: "#D97706",
    subcategories: [
      {
        slug: "building-wire",
        label: "Building Wire",
        itemTypes: [
          {
            slug: "thhn-thwn",
            label: "THHN / THWN Building Wire",
            keywords: [
              "THHN", "THWN", "building wire", "THHN wire", "THWN wire",
              "MTW wire", "600V wire", "THHN copper wire",
              "stranded THHN", "solid THHN",
            ],
          },
          {
            slug: "nm-b",
            label: "NM-B (Romex)",
            keywords: [
              "NM-B", "Romex", "non-metallic sheathed cable", "NMC cable",
              "house wire", "NM cable", "12/2 NM", "14/2 NM", "10/2 NM",
              "12/3 NM", "14/3 NM",
            ],
          },
          {
            slug: "uf-b",
            label: "UF-B Underground Feeder",
            keywords: [
              "UF-B cable", "underground feeder cable", "UF cable",
              "direct burial cable", "underground cable UF",
              "12/2 UF", "14/2 UF",
            ],
          },
        ],
      },
      {
        slug: "flexible-cord-cable",
        label: "Flexible Cord & Cable",
        itemTypes: [
          {
            slug: "so-soow-cord",
            label: "SO / SOOW Cord",
            keywords: [
              "SOOW cord", "SO cord", "portable cord", "flexible cord",
              "SJO cord", "SJOW cord", "rubber cord", "extension cord wire",
              "portable power cord",
            ],
          },
          {
            slug: "mc-cable",
            label: "MC Cable",
            keywords: [
              "MC cable", "metal clad cable", "armored cable", "BX cable",
              "MC Luminary", "12/2 MC", "14/2 MC", "12/3 MC", "14/3 MC",
              "10/3 MC", "AC90 cable",
            ],
          },
          {
            slug: "tc-cable",
            label: "TC Cable",
            keywords: [
              "TC cable", "tray cable", "power control tray cable",
              "multiconductor tray cable", "600V tray cable",
            ],
          },
        ],
      },
      {
        slug: "special-purpose-cable",
        label: "Special Purpose Cable",
        itemTypes: [
          {
            slug: "fire-alarm-cable",
            label: "Fire Alarm Cable",
            keywords: [
              "fire alarm cable", "FPLR cable", "FPLT cable", "FPL cable",
              "fire alarm wire", "2 conductor fire alarm", "4 conductor fire alarm",
              "18 AWG fire alarm", "14 AWG fire alarm",
            ],
          },
          {
            slug: "security-control-cable",
            label: "Security & Control Cable",
            keywords: [
              "security cable", "control cable", "security alarm cable",
              "multipair control cable", "plenum control cable",
              "alarm cable", "8 conductor security cable",
            ],
          },
          {
            slug: "vfd-cable",
            label: "VFD Cable",
            keywords: [
              "VFD cable", "variable frequency drive cable",
              "shielded control cable", "inverter duty cable",
              "drive cable", "VFD rated cable",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "receptacles",
    label: "Receptacles & GFCI",
    color: "#7C3AED",
    subcategories: [
      {
        slug: "standard-receptacles",
        label: "Standard Receptacles",
        itemTypes: [
          {
            slug: "15a-duplex",
            label: "15A Duplex Outlets",
            keywords: [
              "15A duplex", "15 amp duplex", "15A outlet",
              "NEMA 5-15R", "standard duplex white", "standard duplex ivory",
              "straight blade 15A", "15 amp receptacle",
            ],
          },
          {
            slug: "20a-duplex",
            label: "20A Duplex Outlets",
            keywords: [
              "20A duplex", "20 amp duplex", "20A outlet",
              "NEMA 5-20R", "20A T-slot", "20 amp receptacle",
              "20A straight blade outlet",
            ],
          },
          {
            slug: "single-outlets",
            label: "Single Outlets",
            keywords: [
              "single outlet", "single receptacle", "single flush",
              "15A single", "20A single", "NEMA 5-15 single", "NEMA 5-20 single",
              "single pole outlet",
            ],
          },
        ],
      },
      {
        slug: "gfci-afci-receptacles",
        label: "GFCI & AFCI Receptacles",
        itemTypes: [
          {
            slug: "gfci-outlets",
            label: "GFCI Outlets",
            keywords: [
              "GFCI outlet", "GFCI receptacle", "ground fault outlet",
              "GFCI 15A", "GFCI 20A", "GFCI duplex",
              "tamper resistant GFCI", "weather resistant GFCI",
            ],
          },
          {
            slug: "afci-outlets",
            label: "AFCI Outlets",
            keywords: [
              "AFCI outlet", "AFCI receptacle", "arc fault outlet",
              "AFCI 15A", "AFCI 20A",
            ],
          },
          {
            slug: "combo-afci-gfci-receptacles",
            label: "Dual Function AFCI/GFCI Outlets",
            keywords: [
              "dual function receptacle", "combination AFCI GFCI outlet",
              "AFCI GFCI receptacle", "dual function outlet",
            ],
          },
        ],
      },
      {
        slug: "special-purpose-receptacles",
        label: "Special Purpose Receptacles",
        itemTypes: [
          {
            slug: "30a-higher",
            label: "30A & Higher Power Outlets",
            keywords: [
              "30A outlet", "30A receptacle", "NEMA 14-30", "NEMA 6-30",
              "dryer outlet", "range outlet", "50A outlet", "NEMA 14-50",
              "3-pole outlet", "4-wire outlet",
            ],
          },
          {
            slug: "twist-lock",
            label: "Twist-Lock Receptacles & Plugs",
            keywords: [
              "twist lock outlet", "twist-lock receptacle", "locking outlet",
              "NEMA L5-30", "NEMA L6-20", "NEMA L14-30",
              "locking connector", "locking plug", "hubbell twist lock",
            ],
          },
          {
            slug: "usb-receptacles",
            label: "USB Receptacles",
            keywords: [
              "USB outlet", "USB receptacle", "USB charging outlet",
              "USB A outlet", "USB C outlet", "USB duplex",
              "USB combo outlet",
            ],
          },
          {
            slug: "weather-resistant-outlets",
            label: "Weather Resistant Outlets",
            keywords: [
              "weather resistant outlet", "WR outlet", "WR GFCI",
              "outdoor receptacle", "outdoor outlet",
              "weather resistant receptacle",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "switches-dimmers",
    label: "Switches & Dimmers",
    color: "#059669",
    subcategories: [
      {
        slug: "general-purpose-switches",
        label: "General Purpose Switches",
        itemTypes: [
          {
            slug: "single-pole-switches",
            label: "Single Pole Switches",
            keywords: [
              "single pole switch", "on/off switch", "toggle switch 15A",
              "SP switch", "15A single pole switch",
              "20A single pole", "light switch", "wall switch",
            ],
          },
          {
            slug: "3-way-4-way-switches",
            label: "3-Way & 4-Way Switches",
            keywords: [
              "3-way switch", "three way switch", "4-way switch",
              "four way switch", "traveler switch", "3 way toggle",
            ],
          },
          {
            slug: "double-pole-switches",
            label: "Double Pole Switches",
            keywords: [
              "double pole switch", "DP switch", "double throw switch",
              "DP 20A switch", "double pole toggle", "DP toggle switch",
            ],
          },
          {
            slug: "specialty-switches",
            label: "Specialty Switches",
            keywords: [
              "pilot light switch", "combination switch outlet",
              "switch outlet combo", "decorator switch",
              "lighted switch", "fan switch", "switch receptacle combo",
            ],
          },
        ],
      },
      {
        slug: "dimmers-fan-controls",
        label: "Dimmers & Fan Controls",
        itemTypes: [
          {
            slug: "standard-dimmers",
            label: "Standard Dimmers",
            keywords: [
              "dimmer", "wall dimmer", "incandescent dimmer",
              "CFL LED dimmer", "single pole dimmer", "3-way dimmer",
              "Lutron dimmer", "Leviton dimmer", "slide dimmer",
            ],
          },
          {
            slug: "smart-dimmers-switches",
            label: "Smart Dimmers & Switches",
            keywords: [
              "smart dimmer", "wi-fi dimmer", "Z-wave dimmer",
              "ZigBee dimmer", "smart switch", "smart lighting control",
              "wifi switch", "app controlled dimmer",
            ],
          },
          {
            slug: "fan-speed-controls",
            label: "Fan Speed Controls",
            keywords: [
              "fan speed control", "fan control", "ceiling fan switch",
              "3-speed fan control", "fan controller", "fan dimmer",
              "ceiling fan control",
            ],
          },
        ],
      },
    ],
  },
  {
    slug: "wire-connectors-terminations",
    label: "Wire Connectors & Terminations",
    color: "#DC2626",
    subcategories: [
      {
        slug: "wire-connectors",
        label: "Wire Connectors",
        itemTypes: [
          {
            slug: "wire-nuts",
            label: "Wire Nuts",
            keywords: [
              "wire nut", "wire connector", "twist-on connector",
              "marrette", "Ideal wire nut", "3M connector",
              "orange wire nut", "red wire nut", "yellow wire nut", "gray wire nut",
            ],
          },
          {
            slug: "push-in-connectors",
            label: "Push-In Connectors",
            keywords: [
              "push-in connector", "lever nut", "WAGO connector",
              "Ideal In-Sure", "push wire connector", "backstab connector",
              "quick connect", "push in wire", "push-in terminal",
            ],
          },
          {
            slug: "butt-splices",
            label: "Butt Splices",
            keywords: [
              "butt splice", "butt connector", "crimp butt splice",
              "insulated butt connector", "nylon butt splice",
              "heat shrink butt splice",
            ],
          },
        ],
      },
      {
        slug: "lugs-terminals",
        label: "Lugs & Terminals",
        itemTypes: [
          {
            slug: "compression-lugs",
            label: "Compression Lugs",
            keywords: [
              "compression lug", "copper lug", "aluminum lug",
              "crimp lug", "solderless lug", "terminal lug",
              "two-hole lug", "one-hole lug", "Burndy lug", "ILSCO lug",
            ],
          },
          {
            slug: "set-screw-lugs",
            label: "Set Screw Lugs & Mechanical Connectors",
            keywords: [
              "set screw lug", "mechanical lug", "set screw connector",
              "mechanical connector", "split bolt", "split bolt connector",
              "Burndy connector", "ILSCO mechanical",
            ],
          },
          {
            slug: "terminal-blocks",
            label: "Terminal Blocks",
            keywords: [
              "terminal block", "terminal strip", "DIN rail terminal",
              "wire terminal", "ground terminal block", "neutral terminal block",
              "terminal barrier", "rail mount terminal",
            ],
          },
        ],
      },
      {
        slug: "grounding-accessories",
        label: "Grounding Accessories",
        itemTypes: [
          {
            slug: "grounding-clamps",
            label: "Grounding Clamps",
            keywords: [
              "grounding clamp", "ground clamp", "GRC clamp",
              "grounding connector", "concrete encased grounding clamp",
              "rod clamp ground", "pipe clamp ground", "rebar clamp",
              "acorn clamp",
            ],
          },
          {
            slug: "grounding-bushings",
            label: "Grounding Bushings",
            keywords: [
              "grounding bushing", "insulated grounding bushing",
              "GIB bushing", "grounding locknut bushing",
              "bonding bushing", "bonding locknut", "insulated bushing ground",
            ],
          },
          {
            slug: "ground-rods",
            label: "Ground Rods & Accessories",
            keywords: [
              "ground rod", "copper ground rod", "galvanized rod",
              "driven rod", "8 foot ground rod", "5/8 ground rod",
              "1/2 ground rod", "ground rod clamp", "ground rod coupler",
            ],
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

export function getAllTaxonomyKeywords(taxonomy: TaxonomyCategory[]): string[] {
  const all = new Set<string>();
  for (const cat of taxonomy) {
    for (const kw of collectKeywords(cat)) all.add(kw);
  }
  return Array.from(all);
}
