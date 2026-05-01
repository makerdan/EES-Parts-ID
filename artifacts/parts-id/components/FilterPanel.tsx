import React, { useCallback, useRef, useState } from "react";
import {
  LayoutChangeEvent,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useColors } from "@/hooks/useColors";

export interface FilterValues {
  keywords: string;
  catalog: string;
  vendor: string;
  color: string;
  size: string;
  material: string;
  textNumbers: string;
  confidenceThreshold: number;
  // 16 categorical chip dimensions
  partType: string;
  voltage: string;
  amperage: string;
  phase: string;
  wireGauge: string;
  conduitType: string;
  nemaConfig: string;
  enclosureRating: string;
  mounting: string;
  poles: string;
  wireType: string;
  conduitSize: string;
  boxType: string;
  lightingType: string;
  protectionType: string;
  location: string;
}

export type DimensionCounts = Record<string, Record<string, number>>;

interface FilterPanelProps {
  values: FilterValues;
  onChange: (key: keyof FilterValues, value: string | number) => void;
  onSearch: () => void;
  onClear: () => void;
  isLoading: boolean;
  resultCount?: number;
  /** Per-chip counts returned from the last search (key → option → count) */
  dimensionCounts?: DimensionCounts;
}

// ── 16 chip dimensions ───────────────────────────────────────────────────────
const CHIP_DIMS: Array<{
  key: keyof FilterValues;
  label: string;
  options: string[];
}> = [
  {
    key: "partType",
    label: "Part Type",
    options: [
      "Receptacle","Switch","Breaker","Wire","Conduit","Fitting","Box","Panel",
      "Transformer","Fuse","Lighting","Motor","Enclosure","Connector","Dimmer","Sensor",
    ],
  },
  {
    key: "voltage",
    label: "Voltage",
    options: ["120V","240V","208V","277V","480V","24V","12V","600V"],
  },
  {
    key: "amperage",
    label: "Amperage",
    options: ["15A","20A","30A","40A","50A","60A","100A","150A","200A","400A"],
  },
  {
    key: "phase",
    label: "Phase",
    options: ["1 Phase","3 Phase"],
  },
  {
    key: "wireGauge",
    label: "Wire Gauge",
    options: ["#14","#12","#10","#8","#6","#4","#2","1/0","2/0","3/0","4/0"],
  },
  {
    key: "conduitType",
    label: "Conduit Type",
    options: ["EMT","PVC","RMC","IMC","FMC","LFMC","ENT","HDPE"],
  },
  {
    key: "nemaConfig",
    label: "NEMA Config",
    options: ["5-15","5-20","6-20","6-50","14-30","14-50","L5-30","L14-30","L21-20"],
  },
  {
    key: "enclosureRating",
    label: "Enclosure",
    options: ["NEMA 1","NEMA 3R","NEMA 4","NEMA 4X","NEMA 12","NEMA 7"],
  },
  {
    key: "mounting",
    label: "Mounting",
    options: ["Surface","Flush","New Work","Old Work","DIN Rail","Panel Mount"],
  },
  {
    key: "poles",
    label: "Poles",
    options: ["1 Pole","2 Pole","3 Pole"],
  },
  {
    key: "wireType",
    label: "Wire Type",
    options: ["THHN","THWN","NM-B","MC","UF","SER","Armored","Plenum"],
  },
  {
    key: "conduitSize",
    label: "Conduit Size",
    options: ['1/2"','3/4"','1"','1-1/4"','1-1/2"','2"','2-1/2"','3"','4"'],
  },
  {
    key: "boxType",
    label: "Box Type",
    options: ["1-Gang","2-Gang","3-Gang","4-Square","Round","Handy","Weatherproof","Fan Box"],
  },
  {
    key: "lightingType",
    label: "Lighting",
    options: ["LED","Fluorescent","HID","Incandescent","Emergency","Exit","Recessed","Outdoor"],
  },
  {
    key: "protectionType",
    label: "Protection",
    options: ["GFCI","AFCI","Dual Function","Surge","Tamper Resistant","Weather Resistant","Explosion Proof"],
  },
  {
    key: "location",
    label: "Location",
    options: ["Indoor","Outdoor","Wet","Damp","Plenum","Direct Burial","Hazardous"],
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  colors: ReturnType<typeof useColors>;
  autoCapitalize?: "none" | "words" | "sentences" | "characters";
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
      />
    </View>
  );
}

// Continuous 0–100 confidence slider using PanResponder (no native module needed)
function ConfidenceSlider({
  value,
  onChange,
  colors,
}: {
  value: number;
  onChange: (v: number) => void;
  colors: ReturnType<typeof useColors>;
}) {
  const pct = Math.round(value * 100);
  const trackWidth = useRef(0);

  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        if (trackWidth.current === 0) return;
        const x = e.nativeEvent.locationX;
        onChange(clamp((x / trackWidth.current) * 100) / 100);
      },
      onPanResponderMove: (e) => {
        if (trackWidth.current === 0) return;
        const x = e.nativeEvent.locationX;
        onChange(clamp((x / trackWidth.current) * 100) / 100);
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
        {[0, 20, 40, 60, 80].map((s) => (
          <Pressable
            key={s}
            onPress={() => onChange(s / 100)}
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

export function FilterPanel({ values, onChange, onSearch, onClear, isLoading, resultCount, dimensionCounts }: FilterPanelProps) {
  const colors = useColors();

  const activeChipCount = CHIP_DIMS.filter(d => values[d.key]).length;

  return (
    <View>
      {/* ── Row 1: Keywords ── */}
      <Field
        label="Keywords / Description"
        value={values.keywords}
        onChange={v => onChange("keywords", v)}
        placeholder="e.g. 20a duplex white outlet..."
        colors={colors}
      />

      {/* ── Row 2: Catalog # + Vendor ── */}
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

      {/* ── Row 3: Color + Size ── */}
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
            placeholder="20A, 1/2\", #12..."
            colors={colors}
          />
        </View>
      </View>

      {/* ── Row 4: Material + Text/Numbers ── */}
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

      {/* ── 16-Dimension chip filter panel ── */}
      <View style={[chipAreaStyles.container, { borderColor: colors.border, backgroundColor: colors.card }]}>
        <View style={chipAreaStyles.header}>
          <Text style={[chipAreaStyles.title, { color: colors.foreground }]}>
            Filter Dimensions
          </Text>
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
          </View>
        </View>

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

        {/* Confidence slider inside the chip panel */}
        <ConfidenceSlider
          value={values.confidenceThreshold}
          onChange={v => onChange("confidenceThreshold", v)}
          colors={colors}
        />
      </View>

      {/* Action buttons */}
      <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
        <Pressable
          onPress={onSearch}
          style={[
            actionStyles.searchBtn,
            { backgroundColor: isLoading ? colors.muted : colors.primary },
          ]}
          disabled={isLoading}
        >
          <Text style={[actionStyles.searchBtnText, { color: colors.primaryForeground }]}>
            {isLoading
              ? "Searching…"
              : resultCount !== undefined
              ? `🔍 Search (${resultCount})`
              : "🔍 Search"}
          </Text>
        </Pressable>
        <Pressable
          onPress={onClear}
          style={[actionStyles.clearBtn, { borderColor: colors.border }]}
        >
          <Text style={[actionStyles.clearBtnText, { color: colors.mutedForeground }]}>Clear</Text>
        </Pressable>
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
    padding: 12,
    marginBottom: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  title: { fontSize: 13, fontFamily: "Inter_700Bold" },
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

const actionStyles = StyleSheet.create({
  searchBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
  },
  searchBtnText: { fontSize: 15, fontFamily: "Inter_700Bold" },
  clearBtn: {
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
  },
  clearBtnText: { fontSize: 14, fontFamily: "Inter_500Medium" },
});
