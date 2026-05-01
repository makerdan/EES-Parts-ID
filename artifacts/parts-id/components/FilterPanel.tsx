import React from "react";
import { ScrollView, StyleSheet, Text, TextInput, View, Pressable } from "react-native";
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
}

interface FilterPanelProps {
  values: FilterValues;
  onChange: (key: keyof FilterValues, value: string | number) => void;
  onSearch: () => void;
  onClear: () => void;
  isLoading: boolean;
}

const THRESHOLD_PRESETS = [
  { label: "Strict 90%", value: 0.9 },
  { label: "High 80%", value: 0.8 },
  { label: "Med 65%", value: 0.65 },
  { label: "Low 50%", value: 0.5 },
  { label: "Any 30%", value: 0.3 },
];

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

const fieldStyles = StyleSheet.create({
  label: { fontSize: 12, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 5 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, fontFamily: "Inter_400Regular" },
});

export function FilterPanel({ values, onChange, onSearch, onClear, isLoading }: FilterPanelProps) {
  const colors = useColors();

  return (
    <View>
      {/* Primary search */}
      <Field label="Keywords / Description" value={values.keywords} onChange={v => onChange("keywords", v)} placeholder="e.g. 20a duplex white outlet..." colors={colors} />
      <Field label="Catalog #" value={values.catalog} onChange={v => onChange("catalog", v)} placeholder="e.g. BR120, QO230..." colors={colors} autoCapitalize="characters" />
      <Field label="Vendor / Manufacturer" value={values.vendor} onChange={v => onChange("vendor", v)} placeholder="e.g. Eaton, Square D, Leviton..." colors={colors} autoCapitalize="words" />

      {/* Secondary filters */}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Field label="Color" value={values.color} onChange={v => onChange("color", v)} placeholder="white, gray, black..." colors={colors} />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Size / Rating" value={values.size} onChange={v => onChange("size", v)} placeholder={'20A, 1/2", 100W...'} colors={colors} />
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Field label="Material" value={values.material} onChange={v => onChange("material", v)} placeholder="aluminum, steel, pvc..." colors={colors} />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Text / Numbers Seen" value={values.textNumbers} onChange={v => onChange("textNumbers", v)} placeholder="visible markings..." colors={colors} />
        </View>
      </View>

      {/* Confidence threshold */}
      <Text style={[fieldStyles.label, { color: colors.mutedForeground, marginBottom: 8 }]}>
        MIN CONFIDENCE THRESHOLD
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
        {THRESHOLD_PRESETS.map((preset) => (
          <Pressable
            key={preset.value}
            onPress={() => onChange("confidenceThreshold", preset.value)}
            style={[
              thresholdStyles.chip,
              {
                backgroundColor: values.confidenceThreshold === preset.value ? colors.primary : colors.muted,
                borderColor: values.confidenceThreshold === preset.value ? colors.primary : colors.border,
              },
            ]}
          >
            <Text
              style={[
                thresholdStyles.chipText,
                { color: values.confidenceThreshold === preset.value ? colors.primaryForeground : colors.foreground },
              ]}
            >
              {preset.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Action buttons */}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Pressable
          onPress={onSearch}
          style={[
            actionStyles.searchBtn,
            { backgroundColor: isLoading ? colors.muted : colors.primary },
          ]}
          disabled={isLoading}
        >
          <Text style={[actionStyles.searchBtnText, { color: colors.primaryForeground }]}>
            {isLoading ? "Searching…" : "🔍 Search"}
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

const thresholdStyles = StyleSheet.create({
  chip: {
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 7,
    marginRight: 8,
  },
  chipText: { fontSize: 12, fontFamily: "Inter_500Medium" },
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
