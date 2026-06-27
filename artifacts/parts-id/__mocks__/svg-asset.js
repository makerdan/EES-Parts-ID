// Stub for require("*.svg") in Jest.
// Metro uses a numeric asset ID; returning 1 satisfies Asset.loadAsync's
// type signature and avoids the SyntaxError Jest would get parsing SVG XML.
module.exports = 1;
