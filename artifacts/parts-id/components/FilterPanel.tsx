/**
 * Server-side filter chips for the Search tab.
 *
 * `CHIP_DIMS` is the canonical list of refinable dimensions (manufacturer,
 * amperage, voltage, …). It's consumed both here (for the visible chips)
 * and by `ResultRefinementBar` (for client-side dim counts) so the two
 * stay in lockstep. Adding a new chip is a one-place change here.
 */
import React, { useCallback, useEffect, useRef } from "react";
import { usePersistedCollapse } from "@/hooks/usePersistedCollapse";
import {
  Animated,
  LayoutAnimation,
  LayoutChangeEvent,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

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
  category: string;       // Part category / type
  amperage: string;       // Current rating
  colorChip: string;      // Quick-pick color (separate from free-text color field)
  manufacturer: string;   // Major manufacturer quick-pick
  sizeChip: string;       // Quick-pick size (conduit/box/wire size)
  rating: string;         // NEMA / IP / UL enclosure or equipment rating
  wireType: string;       // Wire insulation type
  wireGauge: string;      // AWG gauge
  conduitType: string;    // Conduit material/type
  conduitSize: string;    // Conduit trade size
  boxType: string;        // Electrical box type
  boxGangCount: string;   // Box gang count
  mountingType: string;   // Mounting method
  environment: string;    // Installation environment
  voltage: string;        // Voltage rating
  poleCount: string;      // Pole count (breakers/switches)
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
    key: "category",
    label: "Category",
    options: ["Receptacle","Switch","Breaker","Wire","Conduit","Fitting","Box","Panel","Transformer","Fuse","Lighting","Motor","Connector","Dimmer","Sensor","Enclosure"],
  },
  {
    key: "amperage",
    label: "Amperage",
    options: ["15A","20A","30A","40A","50A","60A","100A","150A","200A","400A"],
  },
  {
    key: "colorChip",
    label: "Color",
    options: ["White","Black","Gray","Ivory","Almond","Red","Blue","Brown","Orange","Yellow"],
  },
  {
    key: "manufacturer",
    label: "Manufacturer",
    options: ["Eaton","Square D","Hubbell","Leviton","Siemens","GE","Legrand","Cooper","Lutron","3M","Panduit","T&B","Belden","Southwire","ABB","Rockwell"],
  },
  {
    key: "sizeChip",
    label: "Size",
    options: ['1/2"','3/4"','1"','1-1/4"','1-1/2"','2"','2-1/2"','3"','4"','6"','12.7mm','19.1mm','25.4mm','31.8mm','38.1mm','50.8mm','63.5mm','76.2mm','101.6mm','152.4mm'],
  },
  {
    key: "rating",
    label: "Rating",
    options: ["NEMA 1","NEMA 3R","NEMA 4","NEMA 4X","NEMA 12","NEMA 7","IP65","IP67","UL Listed","CSA"],
  },
  {
    key: "wireType",
    label: "Wire Type",
    options: ["THHN","THWN","NM-B","MC","UF","SER","Armored","Plenum","URD","USE"],
  },
  {
    key: "wireGauge",
    label: "Wire Gauge",
    options: ["#14","#12","#10","#8","#6","#4","#2","1/0","2/0","3/0","4/0","350","500"],
  },
  {
    key: "conduitType",
    label: "Conduit Type",
    options: ["EMT","PVC","RMC","IMC","FMC","LFMC","ENT","HDPE","RTRC","GRC"],
  },
  {
    // Reused as the generic Trade Size chip — applies to conduit, pipe,
    // and any conduit-family fitting whose catalog ends in a trade size.
    // The aiKeywords backfill (api-server/src/seed/backfill-trade-size.ts)
    // writes these exact strings into matching inventory rows.
    key: "conduitSize",
    label: "Trade Size",
    options: ['1/2"','3/4"','1"','1-1/4"','1-1/2"','2"','2-1/2"','3"','4"','12.7mm','19.1mm','25.4mm','31.8mm','38.1mm','50.8mm','63.5mm','76.2mm','101.6mm'],
  },
  {
    key: "boxType",
    label: "Box Type",
    options: ["New Work","Old Work","Junction","Weatherproof","Fan Box","Handy","Pull Box","Extension"],
  },
  {
    key: "boxGangCount",
    label: "Box Gang Count",
    options: ["1-Gang","2-Gang","3-Gang","4-Gang","Multi-Gang"],
  },
  {
    key: "mountingType",
    label: "Mounting Type",
    options: ["Surface","Flush","DIN Rail","Panel Mount","Pole Mount","Pendant","Track"],
  },
  {
    key: "environment",
    label: "Environment",
    options: ["Indoor","Outdoor","Wet","Damp","Plenum","Direct Burial","Hazardous"],
  },
  {
    key: "voltage",
    label: "Voltage",
    options: ["120V","240V","208V","277V","480V","24V","12V","600V"],
  },
  {
    key: "poleCount",
    label: "Pole Count",
    options: ["1 Pole","2 Pole","3 Pole","4 Pole"],
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
        <View style={{ flexDirection: "row", gap: 6, paddingVertical: 2 }}>
          {options.map((opt) => {
            const active = value === opt;
            const count = counts?.[opt];
            const hasCount = count !== undefined;
            const disabled = hasCount && count === 0 && !active;
            return (
              <Pressable
                key={opt}
                onPress={() => !disabled && onChange(active ? "" : opt)}
                style={[
                  chipStyles.chip,
                  {
                    backgroundColor: active ? colors.primary : disabled ? colors.muted + "55" : colors.muted,
                    borderColor: active ? colors.primary : disabled ? colors.border + "55" : colors.border,
                    opacity: disabled ? 0.45 : 1,
                  },
                ]}
              >
                <Text
                  style={[
                    chipStyles.chipText,
                    { color: active ? colors.primaryForeground : disabled ? colors.mutedForeground : colors.foreground },
                  ]}
                >
                  {opt}
                </Text>
                {hasCount && (
                  <Text
                    style={[
                      chipStyles.countBadge,
                      { color: active ? colors.primaryForeground + "cc" : colors.mutedForeground },
                    ]}
                  >
                    {count > 99 ? "99+" : count}
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
  autoCapitalize = "none",
  onSubmitEditing,
  returnKeyType,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  colors: ReturnType<typeof useColors>;
  autoCapitalize?: "none" | "words" | "sentences" | "characters";
  onSubmitEditing?: () => void;
  returnKeyType?: "search" | "done" | "go" | "next" | "send";
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
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

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
    }),
  ).current;

  const thumbPos = pct;

  return (
    <View style={{ marginBottom: 16 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 10 }}>
        <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>MIN CONFIDENCE</Text>
        <View style={[sliderStyles.pctBadge, { backgroundColor: colors.primary + "22" }]}>
          <Text style={[sliderStyles.pctLabel, { color: colors.primary }]}>{pct}%</Text>
        </View>
      </View>

      {/* Track */}
      <View
        style={sliderStyles.trackContainer}
        onLayout={(e: LayoutChangeEvent) => { trackWidth.current = e.nativeEvent.layout.width; }}
        {...panResponder.panHandlers}
      >
        <View style={[sliderStyles.trackBg, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <View style={[sliderStyles.trackFill, { backgroundColor: colors.primary, width: `${thumbPos}%` }]} />
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

      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
        <Text style={[sliderStyles.rangeLabel, { color: colors.mutedForeground }]}>0% lenient</Text>
        <Text style={[sliderStyles.rangeLabel, { color: colors.mutedForeground }]}>100% strict</Text>
      </View>

      {/* Quick presets */}
      <View style={{ flexDirection: "row", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
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
            <Text style={[sliderStyles.presetText, { color: pct === s ? colors.primaryForeground : colors.mutedForeground }]}>
              {s === 0 ? "All" : `${s}%`}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}


export function FilterPanel({ values, onChange, dimensionCounts }: FilterPanelProps) {
  const colors = useColors();

  const TEXT_FIELD_KEYS = ["catalog", "vendor", "color", "size", "material", "textNumbers"] as const;

  const activeTextFieldCount = TEXT_FIELD_KEYS.filter(k => values[k].trim() !== "").length;
  const activeChipOnlyCount = CHIP_DIMS.filter(d => values[d.key]).length;

  const activeChipCount = activeChipOnlyCount + activeTextFieldCount;

  const resetChips = useCallback(() => {
    CHIP_DIMS.forEach(d => onChange(d.key, ""));
  }, [onChange]);

  const resetTextFields = useCallback(() => {
    TEXT_FIELD_KEYS.forEach(k => onChange(k, ""));
  }, [onChange]);

  // ── Advanced Filters collapse state ──────────────────────────────────────
  const [dimCollapsed, , setDimCollapsed, dimCollapsedLoaded] =
    usePersistedCollapse("@partsid/dim_collapsed", true);
  const dimChevronAnim = useRef(new Animated.Value(0)).current;

  // Silently sync the chevron to the value loaded from AsyncStorage (no animation)
  useEffect(() => {
    if (dimCollapsedLoaded) {
      dimChevronAnim.setValue(dimCollapsed ? 0 : 1);
    }
  // Only fire once when the persisted value first becomes available
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimCollapsedLoaded]);

  const toggleDimensions = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const toCollapsed = !dimCollapsed;
    setDimCollapsed(toCollapsed);
    Animated.timing(dimChevronAnim, {
      toValue: toCollapsed ? 0 : 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [dimCollapsed, setDimCollapsed, dimChevronAnim]);

  const dimChevronRotate = dimChevronAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "180deg"],
  });

  return (
    <View>
      {/* ── Advanced Filters collapsible card ── */}
      <View style={[chipAreaStyles.container, { borderColor: colors.border, backgroundColor: colors.card }]}>
        <Pressable
          style={[chipAreaStyles.header, { marginBottom: dimCollapsed ? 0 : 12, borderWidth: 1, borderRadius: 8, borderColor: 'rgba(0,0,0,0.75)', padding: 10 }]}
          onPress={toggleDimensions}
        >
          <Text style={[chipAreaStyles.title, { color: colors.foreground }]}>Advanced Filters</Text>
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
            {activeChipCount > 0 && (
              <View style={[chipAreaStyles.badge, { backgroundColor: colors.primary }]}>
                <Text style={[chipAreaStyles.badgeText, { color: colors.primaryForeground }]}>
                  {activeChipCount} active
                </Text>
              </View>
            )}
            {dimensionCounts && (
              <Text style={[chipAreaStyles.liveLabel, { color: colors.mutedForeground }]}>live counts</Text>
            )}
            <Animated.View style={{ transform: [{ rotate: dimChevronRotate }] }}>
              <Feather name="chevron-down" size={16} color={colors.mutedForeground} />
            </Animated.View>
          </View>
        </Pressable>

        {!dimCollapsed && (
          <>
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
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Field
                  label="Catalog #"
                  value={values.catalog}
                  onChange={v => onChange("catalog", v)}
                  placeholder="e.g. BR120..."
                  colors={colors}
                  autoCapitalize="characters"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="Vendor"
                  value={values.vendor}
                  onChange={v => onChange("vendor", v)}
                  placeholder="Eaton, SQD..."
                  colors={colors}
                  autoCapitalize="words"
                />
              </View>
            </View>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Field
                  label="Color"
                  value={values.color}
                  onChange={v => onChange("color", v)}
                  placeholder="White, Black..."
                  colors={colors}
                  autoCapitalize="words"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="Size / Rating"
                  value={values.size}
                  onChange={v => onChange("size", v)}
                  placeholder={'20A, 1/2", #12...'}
                  colors={colors}
                />
              </View>
            </View>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Field
                  label="Material"
                  value={values.material}
                  onChange={v => onChange("material", v)}
                  placeholder="Steel, PVC, Copper..."
                  colors={colors}
                  autoCapitalize="words"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="Text / Numbers"
                  value={values.textNumbers}
                  onChange={v => onChange("textNumbers", v)}
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
                value={String(values[dim.key] ?? "")}
                onChange={(v) => onChange(dim.key, v)}
                colors={colors}
                counts={dimensionCounts?.[dim.key]}
              />
            ))}
            <ConfidenceSlider
              value={values.confidenceThreshold}
              onChange={v => onChange("confidenceThreshold", v)}
              colors={colors}
            />
          </>
        )}
      </View>

    </View>
  );
}

const chipStyles = StyleSheet.create({
  rowLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 5,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  chipText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  countBadge: { fontSize: 10, fontFamily: "Inter_400Regular" },
});

const chipAreaStyles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 10,
    // Slimmer padding so the collapsed "Advanced Filters" bar is thinner
    // (no double-padded inner+outer card around just the header row).
    padding: 6,
    marginBottom: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  title: { fontSize: 13, fontFamily: "Inter_700Bold" },
  dimHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  dimHeaderLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
  },
  resetBtn: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  badgeText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  liveLabel: { fontSize: 10, fontFamily: "Inter_400Regular", fontStyle: "italic" },
});

const sliderStyles = StyleSheet.create({
  pctBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  pctLabel: { fontSize: 14, fontFamily: "Inter_700Bold" },
  trackContainer: { height: 36, justifyContent: "center" },
  trackBg: {
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    overflow: "visible",
    position: "relative",
  },
  trackFill: { height: "100%", borderRadius: 4 },
  thumb: {
    position: "absolute",
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    top: -7,
    marginLeft: -11,
  },
  rangeLabel: { fontSize: 10, fontFamily: "Inter_400Regular" },
  presetChip: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  presetText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
});

const fieldStyles = StyleSheet.create({
  label: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: 5,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
});

