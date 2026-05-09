# Enrichment Collapsible Section — Design Spec

Date: 2026-05-05

## What

Group the four enrichment feature cards (Enrichment Coverage, Measurement Enrichment, Quick Enrich, Catalog PDF) that live in the New Inventory subtab's `ListHeaderComponent` into a single collapsible section. The section starts collapsed. Opening/closing animates smoothly using `LayoutAnimation`.

## Where

`artifacts/parts-id/app/(tabs)/upload.tsx` — `ListHeaderComponent` of the inventory `FlatList`.

## State

```ts
const [enrichOpen, setEnrichOpen] = useState(false);
```

Added alongside existing state declarations. No persistence — resets on tab remount, matching every other toggle in the file.

## Toggle header

Tappable full-width row at the top of the `ListHeaderComponent` (above the 4 cards, inside the outer `<View>`).

- Left side: `▾` / `▸` chevron + **"Enrichment"** label (`Inter_600SemiBold`, `foreground` color)
- Right side: nothing (no badge/count — state changes constantly and would be noisy)
- Bottom border shown only when section is open, separating the header from the first card
- `accessibilityRole="button"`, `accessibilityLabel` toggling between "Expand enrichment tools" / "Collapse enrichment tools"

## Animation

```ts
import { LayoutAnimation, Platform, UIManager } from 'react-native';

// On Android, enable the LayoutAnimation API (iOS has it by default)
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Before each state flip:
LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
setEnrichOpen((v) => !v);
```

## Body

```tsx
{
  enrichOpen && <View>{/* all 4 enrichCard Views, unchanged */}</View>;
}
```

## Inventory count row

Stays below the collapsible section, always visible regardless of open/closed state.

## No style additions needed

The toggle header uses inline styles (matching the `catalogRunsExpanded` header pattern already in the file). No new `StyleSheet` entries.

## Out of scope

- Persisting open/closed state across navigation
- Showing live status (running/pending counts) in the collapsed header
- Animating individual cards within the section
