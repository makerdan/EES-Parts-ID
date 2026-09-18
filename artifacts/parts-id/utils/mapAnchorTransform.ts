/**
 * Compatibility entrypoint for the mobile app's existing path alias.
 * The implementation lives in the shared zone-validation package so the
 * Warehouse Map and Zone Editor cannot drift apart.
 */
export type {
  AffineMatrix,
  AnchorPoint,
} from "@workspace/zone-validation";
export {
  computeAnchorTransform,
  inverseAnchorPoint,
  matrixToSvgString,
  normalizeAnchorPoints,
} from "@workspace/zone-validation";