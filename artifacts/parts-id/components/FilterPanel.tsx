/**
 * Server-side filter chips for the Search tab.
 *
 * `CHIP_DIMS` is the canonical list of refinable dimensions (manufacturer,
 * amperage, voltage, …). It's consumed both here (for the visible chips)
 * and by `ResultRefinementBar` (for client-side dim counts) so the two
 * stay in lockstep. Adding a new chip is a one-place change here.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import rawColors from '@/constants/colors';

export interface FilterValues {
  // ── 7 text / numeric search fields ───────────────────────────────────────
  keywords: string;
  catalog: string;
  vendor: string;
  color: string;
  size: string;
  material: string;
  textNumbers: string;
  confidenceThreshold: number;
  // ── 16 structured chip dimensions (AND-logic on server) ───────────────────
  category: string; // Part category / type
  amperage: string; // Current rating
  colorChip: string; // Quick-pick color (separate from free-text color field)
  manufacturer: string; // Major manufacturer quick-pick
  sizeChip: string; // Quick-pick size (conduit/box/wire size)
  rating: string; // NEMA / IP / UL enclosure or equipment rating
  wireType: string; // Wire insulation type
  wireGauge: string; // AWG gauge
  conduitType: string; // Conduit material/type
  conduitSize: string; // Conduit trade size
  boxType: string; // Electrical box type
  boxGangCount: string; // Box gang count
  mountingType: string; // Mounting method
  environment: string; // Installation environment
  voltage: string; // Voltage rating
  poleCount: string; // Pole count (breakers/switches)
}

export type DimensionCounts = Record<string, Record<string, number>>;

interface FilterPanelProps {
  values: FilterValues;
  onChange: (key: keyof FilterValues, value: string | number) => void;
  /** Per-chip counts returned from the last search (key → option → count) */
  dimensionCounts?: DimensionCounts;
}

// ── 16 required chip dimensions (must mirror CHIP_DIMS_SERVER in inventory.ts) ─
export type ChipDim = {
  key: keyof FilterValues;
  label: string;
  options: string[];
};

export const CHIP_DIMS: ChipDim[] = [
  {
    key: 'category',
    label: 'Keywords:',
    options: [
      'Receptacle',
      'Switch',
      'Breaker',
      'Wire',
      'Conduit',
      'Fitting',
      'Box',
      'Panel',
      'Transformer',
      'Fuse',
      'Lighting',
      'Motor',
      'Connector',
      'Dimmer',
      'Sensor',
      'Enclosure',
    ],
  },
  {
    key: 'amperage',
    label: 'Amperage',
    options: ['15A', '20A', '30A', '40A', '50A', '60A', '100A', '150A', '200A', '400A'],
  },
  {
    key: 'colorChip',
    label: 'Color',
    options: [
      'White',
      'Black',
      'Gray',
      'Ivory',
      'Almond',
      'Red',
      'Blue',
      'Brown',
      'Orange',
      'Yellow',
    ],
  },
  {
    key: 'manufacturer',
    label: 'Manufacturer',
    options: [
      'Eaton',
      'Square D',
      'Hubbell',
      'Leviton',
      'Siemens',
      'GE',
      'Legrand',
      'Cooper',
      'Lutron',
      '3M',
      'Panduit',
      'T&B',
      'Belden',
      'Southwire',
      'ABB',
      'Rockwell',
    ],
  },
  {
    key: 'sizeChip',
    label: 'Size',
    options: [
      '1/2"',
      '3/4"',
      '1"',
      '1-1/4"',
      '1-1/2"',
      '2"',
      '2-1/2"',
      '3"',
      '4"',
      '6"',
      '12.7mm',
      '19.1mm',
      '25.4mm',
      '31.8mm',
      '38.1mm',
      '50.8mm',
      '63.5mm',
      '76.2mm',
      '101.6mm',
      '152.4mm',
    ],
  },
  {
    key: 'rating',
    label: 'Rating',
    options: [
      'NEMA 1',
      'NEMA 3R',
      'NEMA 4',
      'NEMA 4X',
      'NEMA 12',
      'NEMA 7',
      'IP65',
      'IP67',
      'UL Listed',
      'CSA',
    ],
  },
  {
    key: 'wireType',
    label: 'Wire Type',
    options: ['THHN', 'THWN', 'NM-B', 'MC', 'UF', 'SER', 'Armored', 'Plenum', 'URD', 'USE'],
  },
  {
    key: 'wireGauge',
    label: 'Wire Gauge',
    options: [
      '#14',
      '#12',
      '#10',
      '#8',
      '#6',
      '#4',
      '#2',
      '1/0',
      '2/0',
      '3/0',
      '4/0',
      '350',
      '500',
    ],
  },
  {
    key: 'conduitType',
    label: 'Conduit Type',
    options: ['EMT', 'PVC', 'RMC', 'IMC', 'FMC', 'LFMC', 'ENT', 'HDPE', 'RTRC', 'GRC'],
  },
  {
    // Reused as the generic Trade Size chip — applies to conduit, pipe,
    // and any conduit-family fitting whose catalog ends in a trade size.
    // The aiKeywords backfill (api-server/src/seed/backfill-trade-size.ts)
    // writes these exact strings into matching inventory rows.
    key: 'conduitSize',
    label: 'Trade Size',
    options: [
      '1/2"',
      '3/4"',
      '1"',
      '1-1/4"',
      '1-1/2"',
      '2"',
      '2-1/2"',
      '3"',
      '4"',
      '12.7mm',
      '19.1mm',
      '25.4mm',
      '31.8mm',
      '38.1mm',
      '50.8mm',
      '63.5mm',
      '76.2mm',
      '101.6mm',
    ],
  },
  {
    key: 'boxType',
    label: 'Box Type',
    options: [
      'New Work',
      'Old Work',
      'Junction',
      'Weatherproof',
      'Fan Box',
      'Handy',
      'Pull Box',
      'Extension',
    ],
  },
  {
    key: 'boxGangCount',
    label: 'Box Gang Count',
    options: ['1-Gang', '2-Gang', '3-Gang', '4-Gang', 'Multi-Gang'],
  },
  {
    key: 'mountingType',
    label: 'Mounting Type',
    options: ['Surface', 'Flush', 'DIN Rail', 'Panel Mount', 'Pole Mount', 'Pendant', 'Track'],
  },
  {
    key: 'environment',
    label: 'Environment',
    options: ['Indoor', 'Outdoor', 'Wet', 'Damp', 'Plenum', 'Direct Burial', 'Hazardous'],
  },
  {
    key: 'voltage',
    label: 'Voltage',
    options: ['120V', '240V', '208V', '277V', '480V', '24V', '12V', '600V'],
  },
  {
    key: 'poleCount',
    label: 'Pole Count',
    options: ['1 Pole', '2 Pole', '3 Pole', '4 Pole'],
  },
];

function ChipRow({
  label,
  options,
  value,
  onChange,
  colors,
  counts,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
  colors: ReturnType<typeof useColors>;
  /** Live per-option match counts from last search; undefined = not yet searched */
  counts?: Record<string, number>;
}) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={[chipStyles.rowLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', gap: 6, paddingVertical: 2 }}>
          {options.map((opt) => {
            const active = value === opt;
            const count = counts?.[opt];
            const hasCount = count !== undefined;
            const disabled = hasCount && count === 0 && !active;
            return (
              <Pressable
                key={opt}
                onPress={() => !disabled && onChange(active ? '' : opt)}
                style={[
                  chipStyles.chip,
                  {
                    backgroundColor: active
                      ? colors.primary
                      : disabled
                        ? colors.muted + '55'
                        : colors.muted,
                    borderColor: active
                      ? colors.primary
                      : disabled
                        ? colors.border + '55'
                        : colors.border,
                    opacity: disabled ? 0.45 : 1,
                  },
                ]}
              >
                <Text
                  style={[
                    chipStyles.chipText,
                    {
                      color: active
                        ? colors.primaryForeground
                        : disabled
                          ? colors.mutedForeground
                          : colors.foreground,
                    },
                  ]}
                >
                  {opt}
                </Text>
                {hasCount && (
                  <Text
                    style={[
                      chipStyles.countBadge,
                      { color: active ? colors.primaryForeground + 'cc' : colors.mutedForeground },
                    ]}
                  >
                    {count > 99 ? '99+' : count}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  colors,
  autoCapitalize = 'none',
  onSubmitEditing,
  returnKeyType,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  colors: ReturnType<typeof useColors>;
  autoCapitalize?: 'none' | 'words' | 'sentences' | 'characters';
  onSubmitEditing?: () => void;
  returnKeyType?: 'search' | 'done' | 'go' | 'next' | 'send';
}) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        style={[
          fieldStyles.input,
          {
            backgroundColor: colors.muted,
            borderColor: value ? colors.primary : colors.border,
            color: colors.foreground,
          },
        ]}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
      />
    </View>
  );
}

// Continuous 0–100 confidence slider using PanResponder (no native module needed)
export function ConfidenceSlider({
  value,
  onChange,
  colors,
  presets = [0, 20, 40, 60, 80],
}: {
  value: number;
  onChange: (v: number) => void;
  colors: ReturnType<typeof useColors>;
  /** Quick-pick preset values. Defaults to [0,20,40,60,80]. Pass a custom list to hide 0/"All". */
  presets?: number[];
}) {
  // value is 0–100 (integer percentage)
  const pct = Math.round(value);
  const trackWidth = useRef(0);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        if (trackWidth.current === 0) return;
        const x = e.nativeEvent.locationX;
        onChangeRef.current(clamp((x / trackWidth.current) * 100));
      },
      onPanResponderMove: (e) => {
        if (trackWidth.current === 0) return;
        const x = e.nativeEvent.locationX;
        onChangeRef.current(clamp((x / trackWidth.current) * 100));
      },
    })
  ).current;

  const thumbPos = pct;

  return (
    <View style={{ marginBottom: 16 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
        <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>MIN CONFIDENCE</Text>
        <View style={[sliderStyles.pctBadge, { backgroundColor: colors.primary + '22' }]}>
          <Text style={[sliderStyles.pctLabel, { color: colors.primary }]}>{pct}%</Text>
        </View>
      </View>

      {/* Track */}
      <View
        style={sliderStyles.trackContainer}
        onLayout={(e: LayoutChangeEvent) => {
          trackWidth.current = e.nativeEvent.layout.width;
        }}
        {...panResponder.panHandlers}
      >
        <View
          style={[
            sliderStyles.trackBg,
            { backgroundColor: colors.muted, borderColor: colors.border },
          ]}
        >
          <View
            style={[
              sliderStyles.trackFill,
              { backgroundColor: colors.primary, width: `${thumbPos}%` },
            ]}
          />
          <View
            style={[
              sliderStyles.thumb,
              {
                backgroundColor: colors.primary,
                borderColor: colors.primaryForeground,
                left: `${thumbPos}%`,
              },
            ]}
          />
        </View>
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
        <Text style={[sliderStyles.rangeLabel, { color: colors.mutedForeground }]}>0% lenient</Text>
        <Text style={[sliderStyles.rangeLabel, { color: colors.mutedForeground }]}>
          100% strict
        </Text>
      </View>

      {/* Quick presets */}
      <View style={{ flexDirection: 'row', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        {presets.map((s) => (
          <Pressable
            key={s}
            onPress={() => onChange(s)}
            style={[
              sliderStyles.presetChip,
              {
                backgroundColor: pct === s ? colors.primary : colors.muted,
                borderColor: pct === s ? colors.primary : colors.border,
              },
            ]}
          >
            <Text
              style={[
                sliderStyles.presetText,
                { color: pct === s ? colors.primaryForeground : colors.mutedForeground },
              ]}
            >
              {s === 0 ? 'All' : `${s}%`}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function FilterPanel({ values, onChange, dimensionCounts }: FilterPanelProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const TEXT_FIELD_KEYS = [
    'catalog',
    'vendor',
    'color',
    'size',
    'material',
    'textNumbers',
  ] as const;

  const activeTextFieldCount = TEXT_FIELD_KEYS.filter((k) => values[k].trim() !== '').length;
  const activeChipOnlyCount = CHIP_DIMS.filter((d) => values[d.key]).length;

  const activeChipCount = activeChipOnlyCount + activeTextFieldCount;

  const resetChips = useCallback(() => {
    CHIP_DIMS.forEach((d) => onChange(d.key, ''));
  }, [onChange]);

  const resetTextFields = useCallback(() => {
    TEXT_FIELD_KEYS.forEach((k) => onChange(k, ''));
  }, [onChange]);

  const resetAllFilters = useCallback(() => {
    CHIP_DIMS.forEach((d) => onChange(d.key, ''));
    TEXT_FIELD_KEYS.forEach((k) => onChange(k, ''));
  }, [onChange]);

  // ── Modal open/close state ────────────────────────────────────────────────
  const [filtersOpen, setFiltersOpen] = useState(false);

  // ── Swipe-to-dismiss: animated sheet Y position ───────────────────────────
  // `useWindowDimensions` re-renders on rotation so SCREEN_H stays current.
  // We also mirror it into a ref so the PanResponder (created once) always
  // reads the latest height without a stale closure.
  const { height: SCREEN_H } = useWindowDimensions();
  const screenHRef = useRef(SCREEN_H);
  screenHRef.current = SCREEN_H;

  const sheetY = useRef(new Animated.Value(SCREEN_H)).current;

  // Animate sheet in after the native Modal has fully presented.
  // Using onShow (not useEffect) avoids the iOS race where the spring starts
  // before the modal is on-screen, leaving the sheet stuck near the bottom.
  const startOpenAnimation = useCallback(() => {
    sheetY.setValue(screenHRef.current);
    Animated.spring(sheetY, {
      toValue: 0,
      tension: 60,
      friction: 12,
      useNativeDriver: true,
    }).start();
  }, [sheetY]);

  // Animate sheet out, then close the modal.
  // `sheetY` is a stable ref value; `screenHRef` is updated on every render,
  // so no stale-height risk even after an orientation change.
  const dismissModal = useCallback(() => {
    Animated.timing(sheetY, {
      toValue: screenHRef.current,
      duration: 260,
      useNativeDriver: true,
    }).start(() => setFiltersOpen(false));
  }, [sheetY]);

  // Keep a ref to `dismissModal` so the PanResponder (created once via useRef)
  // always invokes the current version of the callback.
  const dismissModalRef = useRef(dismissModal);
  useEffect(() => {
    dismissModalRef.current = dismissModal;
  }, [dismissModal]);

  // ── Drag-handle PanResponder (attached only to the pill strip) ────────────
  // Attached to a dedicated strip — keeps ScrollView scroll and the
  // ConfidenceSlider PanResponder completely uninterrupted.
  // All mutable values accessed through refs to avoid stale closures.
  const dragPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_, gs) => {
        // Only allow downward movement; clamp to 0 so the sheet can't go up.
        sheetY.setValue(Math.max(0, gs.dy));
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > 80 || gs.vy > 0.5) {
          dismissModalRef.current();
        } else {
          // Not enough — spring back to resting position.
          Animated.spring(sheetY, {
            toValue: 0,
            tension: 60,
            friction: 12,
            useNativeDriver: true,
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(sheetY, {
          toValue: 0,
          tension: 60,
          friction: 12,
          useNativeDriver: true,
        }).start();
      },
    })
  ).current;

  return (
    <View>
      {/* ── Advanced Filters trigger row (button + optional clear link) ── */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pressable
          style={[
            chipAreaStyles.triggerBtn,
            { flex: 1, borderColor: 'rgba(0,0,0,0.75)', backgroundColor: colors.card },
          ]}
          onPress={() => setFiltersOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Open advanced filters"
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Feather name="sliders" size={14} color={colors.foreground} />
            <Text style={[chipAreaStyles.triggerTitle, { color: colors.foreground }]}>
              Advanced Filters
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            {activeChipCount > 0 && (
              <View style={[chipAreaStyles.badge, { backgroundColor: colors.primary }]}>
                <Text style={[chipAreaStyles.badgeText, { color: colors.primaryForeground }]}>
                  {activeChipCount} active
                </Text>
              </View>
            )}
            <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
          </View>
        </Pressable>
        {activeChipCount > 0 && (
          <Pressable
            onPress={resetAllFilters}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear all active filters"
          >
            <Text style={[chipAreaStyles.clearFiltersBtn, { color: colors.primary }]}>
              Clear filters
            </Text>
          </Pressable>
        )}
      </View>

      {/* ── Advanced Filters modal overlay ── */}
      {/*
        transparent={true} so the search results beneath are visible while the
        user drags the sheet down. animationType="none" lets our Animated.spring
        handle the entrance/exit without fighting the native animation.
      */}
      <Modal
        visible={filtersOpen}
        animationType="none"
        transparent={true}
        onRequestClose={dismissModal}
        onShow={startOpenAnimation}
        statusBarTranslucent
      >
        {/* Full-screen container: backdrop + animated sheet */}
        <View style={modalStyles.backdrop}>
          {/* Tapping outside the sheet dismisses it */}
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={dismissModal}
            accessibilityRole="button"
            accessibilityLabel="Close advanced filters"
          />

          {/* Animated sheet */}
          <Animated.View
            style={[
              modalStyles.sheet,
              {
                backgroundColor: colors.background,
                transform: [{ translateY: sheetY }],
              },
            ]}
          >
            {/* ── Drag handle pill ── */}
            <View
              {...dragPan.panHandlers}
              style={modalStyles.dragHandleArea}
              accessibilityRole="adjustable"
              accessibilityLabel="Drag down to close"
            >
              <View style={[modalStyles.dragPill, { backgroundColor: colors.border }]} />
            </View>

            <KeyboardAvoidingView
              style={{ flex: 1 }}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
              {/* Modal header */}
              <View
                style={[
                  modalStyles.header,
                  {
                    borderBottomColor: colors.border,
                    paddingTop: 12,
                    backgroundColor: colors.card,
                  },
                ]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Feather name="sliders" size={16} color={colors.foreground} />
                  <Text style={[modalStyles.headerTitle, { color: colors.foreground }]}>
                    Advanced Filters
                  </Text>
                  {activeChipCount > 0 && (
                    <View style={[chipAreaStyles.badge, { backgroundColor: colors.primary }]}>
                      <Text style={[chipAreaStyles.badgeText, { color: colors.primaryForeground }]}>
                        {activeChipCount} active
                      </Text>
                    </View>
                  )}
                </View>
                <Pressable
                  onPress={dismissModal}
                  style={[modalStyles.doneBtn, { backgroundColor: colors.primary }]}
                  accessibilityRole="button"
                  accessibilityLabel="Close advanced filters"
                >
                  <Text style={[modalStyles.doneBtnText, { color: colors.primaryForeground }]}>
                    Done
                  </Text>
                </Pressable>
              </View>

              {/* Scrollable filter content */}
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={[modalStyles.content, { paddingBottom: insets.bottom + 24 }]}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {/* ── Text fields header + clear button ── */}
                <View style={chipAreaStyles.dimHeader}>
                  <Text style={[chipAreaStyles.dimHeaderLabel, { color: colors.mutedForeground }]}>
                    TEXT FILTERS
                  </Text>
                  {activeTextFieldCount > 0 && (
                    <Pressable onPress={resetTextFields} hitSlop={8}>
                      <Text style={[chipAreaStyles.resetBtn, { color: colors.primary }]}>
                        Clear text
                      </Text>
                    </Pressable>
                  )}
                </View>

                {/* ── Text fields ── */}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="Catalog #"
                      value={values.catalog}
                      onChange={(v) => onChange('catalog', v)}
                      placeholder="e.g. BR120..."
                      colors={colors}
                      autoCapitalize="characters"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="Vendor"
                      value={values.vendor}
                      onChange={(v) => onChange('vendor', v)}
                      placeholder="Eaton, SQD..."
                      colors={colors}
                      autoCapitalize="words"
                    />
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="Color"
                      value={values.color}
                      onChange={(v) => onChange('color', v)}
                      placeholder="White, Black..."
                      colors={colors}
                      autoCapitalize="words"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="Size / Rating"
                      value={values.size}
                      onChange={(v) => onChange('size', v)}
                      placeholder={'20A, 1/2", #12...'}
                      colors={colors}
                    />
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="Material"
                      value={values.material}
                      onChange={(v) => onChange('material', v)}
                      placeholder="Steel, PVC, Copper..."
                      colors={colors}
                      autoCapitalize="words"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="Text / Numbers"
                      value={values.textNumbers}
                      onChange={(v) => onChange('textNumbers', v)}
                      placeholder="Markings, UPC..."
                      colors={colors}
                    />
                  </View>
                </View>

                {/* ── Chip dimensions header + reset button ── */}
                <View style={chipAreaStyles.dimHeader}>
                  <Text style={[chipAreaStyles.dimHeaderLabel, { color: colors.mutedForeground }]}>
                    DIMENSIONS
                  </Text>
                  {activeChipOnlyCount > 0 && (
                    <Pressable onPress={resetChips} hitSlop={8}>
                      <Text style={[chipAreaStyles.resetBtn, { color: colors.primary }]}>
                        Reset chips
                      </Text>
                    </Pressable>
                  )}
                </View>

                {/* ── Chip dimensions ── */}
                {CHIP_DIMS.map((dim) => (
                  <ChipRow
                    key={dim.key}
                    label={dim.label}
                    options={dim.options}
                    value={String(values[dim.key] ?? '')}
                    onChange={(v) => onChange(dim.key, v)}
                    colors={colors}
                    counts={dimensionCounts?.[dim.key]}
                  />
                ))}
                <ConfidenceSlider
                  value={values.confidenceThreshold}
                  onChange={(v) => onChange('confidenceThreshold', v)}
                  colors={colors}
                />
              </ScrollView>
            </KeyboardAvoidingView>
          </Animated.View>
        </View>
      </Modal>
    </View>
  );
}

const chipStyles = StyleSheet.create({
  rowLabel: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 5,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: rawColors.chipRadius,
    paddingHorizontal: 11,
    paddingVertical: 8,
    minHeight: 36,
  },
  chipText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  countBadge: { fontSize: 10, fontFamily: 'Inter_400Regular' },
});

const chipAreaStyles = StyleSheet.create({
  triggerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 0,
  },
  triggerTitle: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  dimHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    marginTop: 4,
  },
  dimHeaderLabel: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
  },
  resetBtn: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  clearFiltersBtn: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  badgeText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
});

const modalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    maxHeight: '96%',
    borderTopLeftRadius: rawColors.sheetRadius,
    borderTopRightRadius: rawColors.sheetRadius,
    overflow: 'hidden',
  },
  dragHandleArea: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  dragPill: {
    width: 36,
    height: 4,
    borderRadius: 2,
    opacity: 0.5,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
  },
  doneBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 8,
  },
  doneBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
});

const sliderStyles = StyleSheet.create({
  pctBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  pctLabel: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  trackContainer: { height: 44, justifyContent: 'center' },
  trackBg: {
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    overflow: 'visible',
    position: 'relative',
  },
  trackFill: { height: '100%', borderRadius: 4 },
  thumb: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    top: -7,
    marginLeft: -11,
  },
  rangeLabel: { fontSize: 10, fontFamily: 'Inter_400Regular' },
  presetChip: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  presetText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
});

const fieldStyles = StyleSheet.create({
  label: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 5,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
});
