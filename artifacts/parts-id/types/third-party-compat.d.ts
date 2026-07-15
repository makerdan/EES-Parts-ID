/**
 * Ambient type patches for React 19 / TypeScript 5.9 class-based component compatibility.
 *
 * Root cause: react-native-svg's Shape<P> base class declares `[x: string]: unknown`,
 * which prevents TypeScript's JSX class-element check from confirming that inherited
 * React.Component properties (props, state, context, setState, forceUpdate) satisfy
 * `Component<any, any, any>`. The same class-based mismatch exists in expo-camera and
 * expo-blur. Declaring the components as `React.ComponentType<Props>` (which accepts
 * both class and function components) makes them valid JSX elements.
 *
 * This file has NO top-level import or export statements, making it an ambient script.
 * `declare module` blocks in ambient scripts REPLACE (not augment) the module types.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SHIM VERSION BASELINE
 * Update this block (and re-validate internal paths) whenever any of these
 * libraries is upgraded.  The companion script
 * scripts/check-shim-compat-versions.mjs compares installed versions against
 * these baselines and warns on drift before the TypeScript compiler runs.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * react-native-svg  15.12.1
 *   Internal subpaths relied upon by this shim:
 *     lib/typescript/elements/Circle
 *     lib/typescript/elements/ClipPath
 *     lib/typescript/elements/Defs
 *     lib/typescript/elements/Ellipse
 *     lib/typescript/elements/ForeignObject
 *     lib/typescript/elements/G
 *     lib/typescript/elements/Image
 *     lib/typescript/elements/Line
 *     lib/typescript/elements/LinearGradient
 *     lib/typescript/elements/Marker
 *     lib/typescript/elements/Mask
 *     lib/typescript/elements/Path
 *     lib/typescript/elements/Pattern
 *     lib/typescript/elements/Polygon
 *     lib/typescript/elements/Polyline
 *     lib/typescript/elements/RadialGradient
 *     lib/typescript/elements/Rect
 *     lib/typescript/elements/Shape
 *     lib/typescript/elements/Stop
 *     lib/typescript/elements/Svg
 *     lib/typescript/elements/Symbol
 *     lib/typescript/elements/Text
 *     lib/typescript/elements/TextPath
 *     lib/typescript/elements/TSpan
 *     lib/typescript/elements/Use
 *     lib/typescript/elements/filters/FeBlend
 *     lib/typescript/elements/filters/FeColorMatrix
 *     lib/typescript/elements/filters/FeComposite
 *     lib/typescript/elements/filters/FeGaussianBlur
 *     lib/typescript/elements/filters/FeMerge
 *     lib/typescript/elements/filters/FeMergeNode
 *     lib/typescript/elements/filters/FeOffset
 *     lib/typescript/elements/filters/Filter
 *     lib/typescript/elements/filters/FilterPrimitive
 *     lib/typescript/fabric
 *     lib/typescript/lib/extract/types
 *     lib/typescript/xml
 *     lib/typescript/deprecated
 *
 * expo-camera  17.0.10
 *   Internal subpaths relied upon by this shim:
 *     build/Camera.types
 *   (PictureRef, CameraView, useCameraPermissions, useMicrophonePermissions
 *    and standalone permission functions are declared inline because the
 *    Camera.types subpath does not export them.)
 *
 * expo-blur  15.0.8
 *   Internal subpaths relied upon by this shim: none
 *   (BlurView, BlurViewProps, BlurTint, and ExperimentalBlurMethod are
 *    declared entirely inline because expo-blur exposes no stable subpaths.)
 *
 * react-native-gesture-handler  2.28.0
 *   Internal subpaths relied upon by this shim:
 *     lib/typescript/index
 *   (GestureHandlerRootView is also re-declared inline to fix TS2322.)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// react-native-svg
// ─────────────────────────────────────────────────────────────────────────────
declare module "react-native-svg" {
  import type * as React from "react";

  // Re-export all type-only prop interfaces from element subpaths.
  // Using internal subpaths avoids a circular reference back to "react-native-svg".
  export type {
    CircleProps,
  } from "react-native-svg/lib/typescript/elements/Circle";
  export type {
    ClipPathProps,
  } from "react-native-svg/lib/typescript/elements/ClipPath";
  export type {
    DefsProps,
  } from "react-native-svg/lib/typescript/elements/Defs";
  export type {
    EllipseProps,
  } from "react-native-svg/lib/typescript/elements/Ellipse";
  export type {
    ForeignObjectProps,
  } from "react-native-svg/lib/typescript/elements/ForeignObject";
  export type { GProps } from "react-native-svg/lib/typescript/elements/G";
  export type {
    ImageProps,
  } from "react-native-svg/lib/typescript/elements/Image";
  export type {
    LineProps,
  } from "react-native-svg/lib/typescript/elements/Line";
  export type {
    LinearGradientProps,
  } from "react-native-svg/lib/typescript/elements/LinearGradient";
  export type {
    MarkerProps,
  } from "react-native-svg/lib/typescript/elements/Marker";
  export type {
    MaskProps,
  } from "react-native-svg/lib/typescript/elements/Mask";
  export type {
    PathProps,
  } from "react-native-svg/lib/typescript/elements/Path";
  export type {
    PatternProps,
  } from "react-native-svg/lib/typescript/elements/Pattern";
  export type {
    PolygonProps,
  } from "react-native-svg/lib/typescript/elements/Polygon";
  export type {
    PolylineProps,
  } from "react-native-svg/lib/typescript/elements/Polyline";
  export type {
    RadialGradientProps,
  } from "react-native-svg/lib/typescript/elements/RadialGradient";
  export type {
    RectProps,
  } from "react-native-svg/lib/typescript/elements/Rect";
  export type {
    StopProps,
  } from "react-native-svg/lib/typescript/elements/Stop";
  export type {
    SvgProps,
  } from "react-native-svg/lib/typescript/elements/Svg";
  export type {
    SymbolProps,
  } from "react-native-svg/lib/typescript/elements/Symbol";
  export type {
    TextProps,
  } from "react-native-svg/lib/typescript/elements/Text";
  export type {
    TextPathProps,
  } from "react-native-svg/lib/typescript/elements/TextPath";
  export type {
    TSpanProps,
  } from "react-native-svg/lib/typescript/elements/TSpan";
  export type { UseProps } from "react-native-svg/lib/typescript/elements/Use";

  // Re-export filter prop types
  export type {
    FeBlendProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeBlend";
  export type {
    FeColorMatrixProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeColorMatrix";
  export type {
    FeCompositeProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeComposite";
  export type {
    FeGaussianBlurProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeGaussianBlur";
  export type {
    FeMergeProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeMerge";
  export type {
    FeMergeNodeProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeMergeNode";
  export type {
    FeOffsetProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeOffset";
  export type {
    FilterProps,
  } from "react-native-svg/lib/typescript/elements/filters/Filter";
  export type {
    FilterPrimitiveCommonProps,
  } from "react-native-svg/lib/typescript/elements/filters/FilterPrimitive";

  // Re-export extract/lib types (NumberProp, Color, etc.)
  export * from "react-native-svg/lib/typescript/lib/extract/types";

  // Re-export XML utilities (SvgXml, SvgUri, SvgFromXml, SvgFromUri, SvgAst, etc.)
  // These are already function components so they don't need patching.
  export * from "react-native-svg/lib/typescript/xml";

  // Re-export Shape base class and utility exports
  export {
    default as Shape,
  } from "react-native-svg/lib/typescript/elements/Shape";

  // Re-export native module references
  export {
    RNSVGCircle,
    RNSVGClipPath,
    RNSVGDefs,
    RNSVGEllipse,
    RNSVGFeColorMatrix,
    RNSVGFeComposite,
    RNSVGFeGaussianBlur,
    RNSVGFeMerge,
    RNSVGFeOffset,
    RNSVGFilter,
    RNSVGForeignObject,
    RNSVGGroup,
    RNSVGImage,
    RNSVGLine,
    RNSVGLinearGradient,
    RNSVGMarker,
    RNSVGMask,
    RNSVGPath,
    RNSVGPattern,
    RNSVGRadialGradient,
    RNSVGRect,
    RNSVGSvgAndroid,
    RNSVGSvgIOS,
    RNSVGSymbol,
    RNSVGText,
    RNSVGTextPath,
    RNSVGTSpan,
    RNSVGUse,
  } from "react-native-svg/lib/typescript/fabric";

  // Re-export deprecated helpers
  export {
    inlineStyles,
    loadLocalRawResource,
    LocalSvg,
    SvgCss,
    SvgCssUri,
    SvgWithCss,
    SvgWithCssUri,
    WithLocalSvg,
  } from "react-native-svg/lib/typescript/deprecated";

  // Re-export utilities
  export {
    camelCase,
    fetchText,
    parse,
  } from "react-native-svg/lib/typescript/xml";

  // ── Class-based SVG components re-declared as React.ComponentType ──────────
  // React.ComponentType<P> = ComponentClass<P> | FunctionComponent<P>.
  // Both branches satisfy JSXElementConstructor<P>, so these are valid JSX elements
  // regardless of whether the runtime value is a class or function.

  import type {
    CircleProps,
  } from "react-native-svg/lib/typescript/elements/Circle";
  import type {
    ClipPathProps,
  } from "react-native-svg/lib/typescript/elements/ClipPath";
  import type {
    DefsProps,
  } from "react-native-svg/lib/typescript/elements/Defs";
  import type {
    EllipseProps,
  } from "react-native-svg/lib/typescript/elements/Ellipse";
  import type {
    FeBlendProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeBlend";
  import type {
    FeColorMatrixProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeColorMatrix";
  import type {
    FeCompositeProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeComposite";
  import type {
    FeGaussianBlurProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeGaussianBlur";
  import type {
    FeMergeProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeMerge";
  import type {
    FeMergeNodeProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeMergeNode";
  import type {
    FeOffsetProps,
  } from "react-native-svg/lib/typescript/elements/filters/FeOffset";
  import type {
    FilterProps,
  } from "react-native-svg/lib/typescript/elements/filters/Filter";
  import type {
    FilterPrimitiveCommonProps,
  } from "react-native-svg/lib/typescript/elements/filters/FilterPrimitive";
  import type {
    ForeignObjectProps,
  } from "react-native-svg/lib/typescript/elements/ForeignObject";
  import type { GProps } from "react-native-svg/lib/typescript/elements/G";
  import type {
    ImageProps,
  } from "react-native-svg/lib/typescript/elements/Image";
  import type {
    LineProps,
  } from "react-native-svg/lib/typescript/elements/Line";
  import type {
    LinearGradientProps,
  } from "react-native-svg/lib/typescript/elements/LinearGradient";
  import type {
    MarkerProps,
  } from "react-native-svg/lib/typescript/elements/Marker";
  import type {
    MaskProps,
  } from "react-native-svg/lib/typescript/elements/Mask";
  import type {
    PathProps,
  } from "react-native-svg/lib/typescript/elements/Path";
  import type {
    PatternProps,
  } from "react-native-svg/lib/typescript/elements/Pattern";
  import type {
    PolygonProps,
  } from "react-native-svg/lib/typescript/elements/Polygon";
  import type {
    PolylineProps,
  } from "react-native-svg/lib/typescript/elements/Polyline";
  import type {
    RadialGradientProps,
  } from "react-native-svg/lib/typescript/elements/RadialGradient";
  import type {
    RectProps,
  } from "react-native-svg/lib/typescript/elements/Rect";
  import type {
    StopProps,
  } from "react-native-svg/lib/typescript/elements/Stop";
  import type { SvgProps } from "react-native-svg/lib/typescript/elements/Svg";
  import type {
    SymbolProps,
  } from "react-native-svg/lib/typescript/elements/Symbol";
  import type {
    TextProps,
  } from "react-native-svg/lib/typescript/elements/Text";
  import type {
    TextPathProps,
  } from "react-native-svg/lib/typescript/elements/TextPath";
  import type {
    TSpanProps,
  } from "react-native-svg/lib/typescript/elements/TSpan";
  import type { UseProps } from "react-native-svg/lib/typescript/elements/Use";

  export declare const Svg: React.ComponentType<SvgProps>;
  export declare const G: React.ComponentType<GProps>;
  export declare const Path: React.ComponentType<PathProps>;
  export declare const Ellipse: React.ComponentType<EllipseProps>;
  export declare const Text: React.ComponentType<TextProps>;
  export declare const Rect: React.ComponentType<RectProps>;
  export declare const Circle: React.ComponentType<CircleProps>;
  export declare const Line: React.ComponentType<LineProps>;
  export declare const Polygon: React.ComponentType<PolygonProps>;
  export declare const Polyline: React.ComponentType<PolylineProps>;
  export declare const TSpan: React.ComponentType<TSpanProps>;
  export declare const TextPath: React.ComponentType<TextPathProps>;
  export declare const ClipPath: React.ComponentType<ClipPathProps>;
  export declare const LinearGradient: React.ComponentType<LinearGradientProps>;
  export declare const RadialGradient: React.ComponentType<RadialGradientProps>;
  export declare const Defs: React.ComponentType<DefsProps>;
  export declare const Symbol: React.ComponentType<SymbolProps>;
  export declare const Use: React.ComponentType<UseProps>;
  export declare const Mask: React.ComponentType<MaskProps>;
  export declare const Pattern: React.ComponentType<PatternProps>;
  export declare const Image: React.ComponentType<ImageProps>;
  export declare const Marker: React.ComponentType<MarkerProps>;
  export declare const ForeignObject: React.ComponentType<ForeignObjectProps>;
  export declare const Stop: React.ComponentType<StopProps>;
  export declare const Filter: React.ComponentType<FilterProps>;
  export declare const FeColorMatrix: React.ComponentType<FeColorMatrixProps>;
  export declare const FeComposite: React.ComponentType<FeCompositeProps>;
  export declare const FeGaussianBlur: React.ComponentType<FeGaussianBlurProps>;
  export declare const FeMerge: React.ComponentType<FeMergeProps>;
  export declare const FeMergeNode: React.ComponentType<FeMergeNodeProps>;
  export declare const FeOffset: React.ComponentType<FeOffsetProps>;
  export declare const FilterPrimitive: React.ComponentType<FilterPrimitiveCommonProps>;
  export declare const FeBlend: React.ComponentType<FeBlendProps>;

  // Svg is also the default export
  export { Svg as default };
}

// ─────────────────────────────────────────────────────────────────────────────
// expo-camera
// ─────────────────────────────────────────────────────────────────────────────
declare module "expo-camera" {
  import type {
    CameraViewProps,
    CameraViewRef,
  } from "expo-camera/build/Camera.types";
  import type { PermissionHookOptions,PermissionResponse } from "expo-modules-core";
  import type * as React from "react";

  // Re-export all types from Camera.types subpath
  export * from "expo-camera/build/Camera.types";

  // PictureRef — types-only JS module (no runtime named exports); declare inline
  import type { SharedRef } from "expo";
  import type { PhotoResult, SavePictureOptions } from "expo-camera/build/Camera.types";
  export declare class PictureRef extends SharedRef<"image"> {
    width: number;
    height: number;
    savePictureAsync(options?: SavePictureOptions): Promise<PhotoResult>;
  }

  // Re-export hooks / utilities
  export declare const useCameraPermissions: (
    options?: PermissionHookOptions<object> | undefined
  ) => [
    PermissionResponse | null,
    () => Promise<PermissionResponse>,
    () => Promise<PermissionResponse>,
  ];
  export declare const useMicrophonePermissions: (
    options?: PermissionHookOptions<object> | undefined
  ) => [
    PermissionResponse | null,
    () => Promise<PermissionResponse>,
    () => Promise<PermissionResponse>,
  ];

  export declare function getCameraPermissionsAsync(): Promise<PermissionResponse>;
  export declare function requestCameraPermissionsAsync(): Promise<PermissionResponse>;
  export declare function getMicrophonePermissionsAsync(): Promise<PermissionResponse>;
  export declare function requestMicrophonePermissionsAsync(): Promise<PermissionResponse>;

  // CameraView re-declared using ForwardRefExoticComponent so that:
  //   1. <CameraView ref={cameraRef} ...> is valid JSX (ref accepted)
  //   2. The component passes React 19's JSX class-element check
  //   3. useRef<CameraView>(null) works because we also export type CameraView = CameraViewRef
  export declare const CameraView: React.ForwardRefExoticComponent<
    CameraViewProps & React.RefAttributes<CameraViewRef>
  > & {
    isModernBarcodeScannerAvailable: boolean;
    isAvailableAsync(): Promise<boolean>;
  };

  // Allow `useRef<CameraView>` as a type alias for CameraViewRef
  export type CameraView = CameraViewRef;
}

// ─────────────────────────────────────────────────────────────────────────────
// expo-blur
// ─────────────────────────────────────────────────────────────────────────────
declare module "expo-blur" {
  import type * as React from "react";

  // BlurView types — types-only JS module (no runtime named exports); declare inline
  export type ExperimentalBlurMethod = "none" | "dimezisBlurView";
  export type BlurTint =
    | "light" | "dark" | "default" | "extraLight" | "regular" | "prominent"
    | "systemUltraThinMaterial" | "systemThinMaterial" | "systemMaterial"
    | "systemThickMaterial" | "systemChromeMaterial"
    | "systemUltraThinMaterialLight" | "systemThinMaterialLight"
    | "systemMaterialLight" | "systemThickMaterialLight"
    | "systemChromeMaterialLight" | "systemUltraThinMaterialDark"
    | "systemThinMaterialDark" | "systemMaterialDark" | "systemThickMaterialDark"
    | "systemChromeMaterialDark";
  export type BlurViewProps = {
    tint?: BlurTint;
    intensity?: number;
    blurReductionFactor?: number;
    experimentalBlurMethod?: ExperimentalBlurMethod;
  } & import("react-native").ViewProps;

  // BlurView re-declared as ComponentType for React 19 JSX compatibility
  export declare const BlurView: React.ComponentType<BlurViewProps> & {
    getAnimatableRef?(): React.ComponentType<unknown> | null | undefined;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// react-native-gesture-handler
// ─────────────────────────────────────────────────────────────────────────────
declare module "react-native-gesture-handler" {
  import type * as React from "react";

  // Re-export everything from the library's typed index (no exports field,
  // so the subpath resolves directly to the .d.ts file).
  export * from "react-native-gesture-handler/lib/typescript/index";

  // GestureHandlerRootViewProps extends PropsWithChildren<ViewProps>, which
  // should include both children and all ViewProps (style, etc.). TypeScript
  // 5.9 + @types/react@19 fails to surface these through the intersection when
  // checking JSX usage. Declaring GestureHandlerRootView as a ComponentType
  // that accepts ViewProps & { children? } directly fixes the TS2322 error
  // without losing any props that the real component supports.
  export declare const GestureHandlerRootView: React.ComponentType<
    import("react-native").ViewProps & { children?: React.ReactNode }
  >;
}
