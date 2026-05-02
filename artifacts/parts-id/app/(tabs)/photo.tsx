import React, { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { resizeImage } from "@/utils/resizeImage";
import { useSearchInventory, useAiIdentifyPart } from "@workspace/api-client-react";
import type { SearchResult } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";
import { useApp } from "@/contexts/AppContext";
import { ResultCard } from "@/components/ResultCard";
import { ReferenceModal } from "@/components/ReferenceModal";

export default function PhotoScreen() {
  const colors = useColors();
  const { textFontScale } = useApp();
  const [images, setImages] = useState<{ uri: string; base64: string }[]>([]);
  const [keywords, setKeywords] = useState("");
  const [vendor, setVendor] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [textNumbers, setTextNumbers] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [aiSummary, setAiSummary] = useState("");
  const [aiTerms, setAiTerms] = useState<string[]>([]);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const identifyMutation = useAiIdentifyPart();
  const searchMutation = useSearchInventory();

  const pickImage = async (source: "camera" | "library") => {
    if (images.length >= 4) {
      setInlineError("Max 4 images — remove one first before adding another.");
      return;
    }
    setInlineError(null);

    let result;
    if (source === "camera") {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== "granted") {
        setInlineError("Camera access denied — please enable it in your device Settings.");
        return;
      }
      result = await ImagePicker.launchCameraAsync({
        mediaTypes: "images",
        quality: 0.7,
        allowsEditing: true,
        aspect: [4, 3],
      });
    } else {
      const remainingSlots = 4 - images.length;
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: "images",
        quality: 0.7,
        allowsMultipleSelection: true,
        selectionLimit: remainingSlots,
      });
    }

    if (!result.canceled && result.assets.length > 0) {
      const currentCount = images.length;
      const allowedAssets = result.assets.slice(0, 4 - currentCount);
      if (allowedAssets.length < result.assets.length) {
        setInlineError("Max 4 images — only some photos were added to stay within the limit.");
      }
      setIsProcessing(true);
      try {
        const resized = await Promise.all(
          allowedAssets.map((asset) => resizeImage(asset.uri, asset.width ?? 0))
        );
        setImages((prev) => [...prev, ...resized.map((r) => ({ uri: r.uri, base64: r.base64 }))]);
      } catch {
        setInlineError("Could not process the selected photo — please try again.");
      } finally {
        setIsProcessing(false);
      }
    }
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleIdentify = async () => {
    if (!images.length) {
      setInlineError("Add at least one photo before identifying.");
      return;
    }

    setInlineError(null);
    identifyMutation.reset();
    searchMutation.reset();
    setResults([]);
    setAiSummary("");
    setAiTerms([]);

    try {
      const identifyResult = await identifyMutation.mutateAsync({
        data: {
          images: images.map((i) => i.base64),
          keywords: keywords.trim() || undefined,
          vendor: vendor.trim() || undefined,
          color: color.trim() || undefined,
          size: size.trim() || undefined,
          textNumbers: textNumbers.trim() || undefined,
        },
      });

      setAiSummary(identifyResult.summary);
      setAiTerms(identifyResult.searchTerms);

      // Now search with identified terms
      const allTerms = [
        ...identifyResult.searchTerms,
        ...identifyResult.synonyms.slice(0, 3),
      ].join(" ");

      if (allTerms.trim()) {
        const searchResult = await searchMutation.mutateAsync({
          data: {
            keywords: allTerms,
            vendor: (identifyResult.detectedVendor ?? vendor.trim()) || undefined,
            color: color.trim() || undefined,
            size: size.trim() || undefined,
            textNumbers: textNumbers.trim() || undefined,
            confidenceThreshold: 40,
          },
        });
        setResults(searchResult.results);
      }
    } catch (err) {
      setInlineError("Identification failed — could not analyze the part. Please try again.");
    }
  };

  const isLoading = identifyMutation.isPending || searchMutation.isPending;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>📸 Photo ID</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            Identify parts from photos
          </Text>
        </View>

        <View style={styles.content}>
          {/* Image capture */}
          <View style={styles.imageSection}>
            <View style={styles.imageRow}>
              {images.map((img, index) => (
                <View key={index} style={styles.imageWrapper}>
                  <Image
                    source={{ uri: img.uri }}
                    style={[styles.thumbnail, { borderColor: colors.primary }]}
                    resizeMode="cover"
                  />
                  <Pressable
                    onPress={() => removeImage(index)}
                    style={[styles.removeBtn, { backgroundColor: colors.destructive }]}
                  >
                    <Text style={styles.removeBtnText}>✕</Text>
                  </Pressable>
                </View>
              ))}

              {images.length < 4 ? (
                isProcessing ? (
                  <View style={[styles.processingRow, { borderColor: colors.border, backgroundColor: colors.card }]}>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={[styles.processingLabel, { color: colors.mutedForeground }]}>Processing…</Text>
                  </View>
                ) : (
                  <View style={styles.addImageButtons}>
                    <Pressable
                      onPress={() => pickImage("camera")}
                      disabled={isProcessing}
                      style={[styles.addImageBtn, { backgroundColor: colors.card, borderColor: '#000' }]}
                    >
                      <Text style={styles.addImageEmoji}>📷</Text>
                      <Text style={[styles.addImageLabel, { color: colors.foreground }]}>Camera</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => pickImage("library")}
                      disabled={isProcessing}
                      style={[styles.addImageBtn, { backgroundColor: colors.card, borderColor: '#000' }]}
                    >
                      <Text style={styles.addImageEmoji}>🖼️</Text>
                      <Text style={[styles.addImageLabel, { color: colors.foreground }]}>Photo Library</Text>
                    </Pressable>
                  </View>
                )
              ) : null}
            </View>

            {images.length === 0 ? (
              <Text style={[styles.imageHint, { color: colors.mutedForeground }]}>
                Add up to 4 photos of the part (front + label recommended)
              </Text>
            ) : (
              <Text style={[styles.photoCounter, { color: colors.mutedForeground }]}>
                {images.length} / 4 photos
              </Text>
            )}
          </View>

          {/* Optional context */}
          <View style={[styles.contextCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.contextTitle, { color: colors.foreground }]}>
              Optional Context
            </Text>
            {[
              { label: "Visible Text / Numbers", value: textNumbers, key: "textNumbers", ph: "e.g. BR120, 20A, 125V..." },
              { label: "Keywords", value: keywords, key: "keywords", ph: "e.g. breaker, outlet..." },
              { label: "Vendor", value: vendor, key: "vendor", ph: "e.g. Eaton, Square D..." },
              { label: "Color", value: color, key: "color", ph: "e.g. white, gray..." },
              { label: "Size", value: size, key: "size", ph: "e.g. 20A, 3/4 inch..." },
            ].map(({ label, value, key, ph }) => (
              <View key={key} style={{ marginBottom: 10 }}>
                <Text style={[styles.fieldLabel, { color: '#000' }]}>{label}:</Text>
                <TextInput
                  value={value}
                  onChangeText={(v) => {
                    if (key === "textNumbers") setTextNumbers(v);
                    else if (key === "keywords") setKeywords(v);
                    else if (key === "vendor") setVendor(v);
                    else if (key === "color") setColor(v);
                    else if (key === "size") setSize(v);
                  }}
                  placeholder={ph}
                  placeholderTextColor={colors.mutedForeground}
                  style={[styles.fieldInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
                  autoCorrect={false}
                  autoCapitalize="none"
                />
              </View>
            ))}
          </View>

          {/* Identify button */}
          <Pressable
            onPress={handleIdentify}
            disabled={isLoading || images.length === 0}
            style={[
              styles.identifyBtn,
              { backgroundColor: isLoading || images.length === 0 ? colors.muted : colors.primary },
            ]}
          >
            {isLoading ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <ActivityIndicator color={colors.primaryForeground} />
                <Text style={[styles.identifyBtnText, { color: colors.primaryForeground }]}>
                  {identifyMutation.isPending ? "Analyzing with AI…" : "Searching inventory…"}
                </Text>
              </View>
            ) : (
              <Text style={[styles.identifyBtnText, { color: images.length === 0 ? colors.mutedForeground : colors.primaryForeground }]}>
                🔍 Identify Part
              </Text>
            )}
          </Pressable>

          {/* Inline error banner */}
          {inlineError ? (
            <View style={[styles.inlineBanner, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "55" }]}>
              <Text style={[styles.inlineBannerText, { color: colors.destructive }]}>⚠ {inlineError}</Text>
              <Pressable onPress={() => setInlineError(null)} style={styles.inlineBannerClose}>
                <Text style={{ color: colors.destructive, fontSize: 14 }}>✕</Text>
              </Pressable>
            </View>
          ) : null}

          {/* AI summary */}
          {aiSummary ? (
            <View style={[styles.summaryCard, { backgroundColor: colors.accent, borderColor: colors.primary + "44" }]}>
              <Text style={[styles.summaryTitle, { color: colors.accentForeground }]}>AI Identification</Text>
              <Text style={[styles.summaryText, { color: colors.foreground }]}>{aiSummary}</Text>
              {aiTerms.length > 0 ? (
                <View style={{ marginTop: 10 }}>
                  <Text style={[styles.termLabel, { color: colors.accentForeground }]}>SEARCH TERMS USED</Text>
                  <View style={styles.termRow}>
                    {aiTerms.map((term, i) => (
                      <View key={i} style={[styles.termChip, { backgroundColor: colors.primary + "22" }]}>
                        <Text style={[styles.termText, { color: colors.primary }]}>{term}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Results */}
          {results.length > 0 ? (
            <View>
              <Text style={[styles.resultsTitle, { color: colors.foreground }]}>
                {results.length} Matching Parts
              </Text>
              {results.map((result, index) => (
                <ResultCard key={result.item.id} result={result} rank={index} fontScale={textFontScale} />
              ))}
            </View>
          ) : null}

          {/* No results */}
          {searchMutation.isSuccess && results.length === 0 && aiSummary ? (
            <View style={[styles.noResultsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.noResultsText, { color: colors.mutedForeground }]}>
                No inventory matches found for this part. Try adding it to inventory via the Upload tab.
              </Text>
            </View>
          ) : null}

          {/* Error */}
          {identifyMutation.isError ? (
            <View style={[styles.errorCard, { backgroundColor: colors.destructive + "11", borderColor: colors.destructive + "44" }]}>
              <Text style={[styles.errorText, { color: colors.destructive }]}>
                AI identification failed. Check your connection.
              </Text>
            </View>
          ) : null}

          {/* Welcome state */}
          {!identifyMutation.isSuccess && !identifyMutation.isPending && images.length === 0 ? (
            <View style={[styles.welcomeCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.welcomeTitle, { color: colors.foreground }]}>How it works</Text>
              {[
                "📷 Take or select up to 4 photos of the part",
                "📝 Add any visible text, numbers, or labels",
                "🤖 AI identifies the part type and specifications",
                "📦 Matching items from inventory are shown",
              ].map((step, i) => (
                <Text key={i} style={[styles.welcomeStep, { color: colors.mutedForeground }]}>
                  {step}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      </ScrollView>
      <ReferenceModal />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  headerTitle: { fontSize: 20, fontFamily: "Inter_700Bold" },
  headerSub: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  content: { padding: 16, gap: 14 },
  imageSection: { gap: 8 },
  imageRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "center" },
  imageWrapper: { position: "relative" },
  thumbnail: { width: 130, height: 130, borderRadius: 10, borderWidth: 2 },
  removeBtn: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  removeBtnText: { color: "#fff", fontSize: 10, fontFamily: "Inter_700Bold" },
  processingRow: {
    width: 270, height: 130, borderRadius: 10, borderWidth: 1,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
  },
  processingLabel: { fontSize: 14, fontFamily: "Inter_500Medium" },
  addImageButtons: { flexDirection: "row", gap: 10, justifyContent: "center" },
  addImageBtn: {
    width: 130,
    height: 130,
    borderRadius: 10,
    borderWidth: 2,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  addImageEmoji: { fontSize: 28 },
  addImageLabel: { fontSize: 12, fontFamily: "Inter_500Medium" },
  imageHint: { fontSize: 12, fontFamily: "Inter_400Regular", fontStyle: "italic" },
  photoCounter: { fontSize: 12, fontFamily: "Inter_500Medium" },
  contextCard: { borderRadius: 12, padding: 14, borderWidth: 1 },
  contextTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", marginBottom: 12 },
  fieldLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 5 },
  fieldInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14, fontFamily: "Inter_400Regular" },
  identifyBtn: { borderRadius: 10, paddingVertical: 15, alignItems: "center" },
  identifyBtnText: { fontSize: 16, fontFamily: "Inter_700Bold" },
  summaryCard: { borderRadius: 10, padding: 14, borderWidth: 1 },
  summaryTitle: { fontSize: 12, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 },
  summaryText: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20 },
  termLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 },
  termRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  termChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  termText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  resultsTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", marginBottom: 10 },
  noResultsCard: { borderRadius: 10, padding: 16, borderWidth: 1 },
  noResultsText: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  inlineBanner: { borderRadius: 8, padding: 12, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  inlineBannerText: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1, lineHeight: 18 },
  inlineBannerClose: { paddingLeft: 10 },
  errorCard: { borderRadius: 8, padding: 14, borderWidth: 1 },
  errorText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  welcomeCard: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 8 },
  welcomeTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", marginBottom: 4 },
  welcomeStep: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 20 },
});
