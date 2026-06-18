/**
 * React Native 0.76+ added `filter` to ViewStyle but @types/react-native may lag.
 * This augmentation covers the subset of filter functions used in the project.
 */
import "react-native";

declare module "react-native" {
  interface ViewStyle {
    filter?: ReadonlyArray<| { invert: number }
      | { brightness: number }
      | { contrast: number }
      | { saturate: number }
      | { sepia: number }
      | { opacity: number }
      | { grayscale: number }>;
  }
}
