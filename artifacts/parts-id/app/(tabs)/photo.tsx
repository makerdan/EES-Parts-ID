import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import type { SearchResult } from "@workspace/api-client-react";
import type { InventoryItem } from "@workspace/api-client-react";
import { aiIdentifyPart,lookupByBarcode, useAiIdentifyPart, useSearchInventory } from "@workspace/api-client-react";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import React, { useEffect,useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { BarcodeScanModal } from "@/components/BarcodeScanModal";
import BarcodeScreen from "@/components/BarcodeScreen";
import { KeyboardDoneInput } from "@/components/KeyboardDoneInput";
import type { PartDimensions } from "@/components/MeasurePartScreen";
import { MeasurePartScreen } from "@/components/MeasurePartScreen";
import { PartDetailsEditor } from "@/components/PartDetailsEditor";
import { ReferenceModal } from "@/components/ReferenceModal";
import { ResultCard } from "@/components/ResultCard";
import { type PinnedPart,useApp } from "@/contexts/AppContext";
import { useColors } from "@/hooks/useColors";
import { useScanHistory } from "@/hooks/useScanHistory";
import { parseBin } from "@/lib/aisleHierarchy";
import { secondaryBtnBase } from "@/styles/shared";
import { lookupByBarcodeOffline } from "@/utils/offlineBarcode";
import { resizeImage } from "@/utils/resizeImage";
import type { ScanEntry } from "@/utils/scanHistory";
import { useTrackScreen } from "@/utils/useTrackScreen";

export default function PhotoScreen() {
  "use no memo";
  useTrackScreen("Photo ID");
  const colors = useColors();
  const { textFontScale, isAdmin, adminToken, setPinnedParts, setPendingMapFocus, setPendingMeasureSearch, showToast } = useApp();
  const [images, setImages] = useState<Array<{ uri: string; base64: string }>>([]);
  const [keywords, setKeywords] = useState("");
  const [vendor, setVendor] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [textNumbers, setTextNumbers] = useState("");
  const [results, setResults] = useState<Array<SearchResult>>([]);
  const [aiSummary, setAiSummary] = useState("");
  const [aiTerms, setAiTerms] = useState<Array<string>>([]);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [barcodeScanVisible, setBarcodeScanVisible] = useState(false);
  const [barcodeMoreVisible, setBarcodeMoreVisible] = useState(false);
  const [barcodeResult, setBarcodeResult] = useState<InventoryItem | null>(null);
  // Tracks which phase of the multi-step AI identification flow we are in.
  type ProgressPhase = "uploading" | "analysing" | "searching" | null;
  const [progressPhase, setProgressPhase] = useState<ProgressPhase>(null);

  const [measureSearchVisible, setMeasureSearchVisible] = useState(false);
  /** The result card the admin dismissed/acted on — controls inline bridge card. */
  const [adminBridgeItem, setAdminBridgeItem] = useState<InventoryItem | null>(null);
  const [, setAdminBridgeMeasureItem] = useState<InventoryItem | null>(null);
  /** Bin codes of the auto-pinned top result — controls inline "Navigate to Map" banner. */
  const [mapPromptBins, setMapPromptBins] = useState<Array<string>>([]);
  /** Item opened in the full detail/edit sheet — shows the "Map it!" button. */
  const [detailsItem, setDetailsItem] = useState<InventoryItem | null>(null);

  /**
   * Called when the worker explicitly taps "Show on Map" on a specific result
   * card to override the auto-pinned top result and navigate to that part.
   */
  const handleShowOnMap = React.useCallback((item: InventoryItem) => {
    const bins = item.binLocations ?? [];
    if (bins.length === 0) {
      showToast("No bin location assigned — add a bin to this item first.");
      return;
    }
    const newPins: Array<PinnedPart> = [];
    let firstParsed: ReturnType<typeof parseBin> | null = null;
    for (const bin of bins) {
      const parsed = parseBin(bin);
      if (parsed) {
        if (!firstParsed) firstParsed = parsed;
        newPins.push({ binCode: bin, label: item.catalog, aisleNum: parsed.aisle });
      }
    }
    if (!firstParsed) {
      showToast(`No map zone found for "${bins[0]}" — bin format not recognised.`);
      return;
    }
    setPinnedParts(newPins);
    setPendingMapFocus({
      aisleNum: firstParsed.aisle,
      sectionNum: firstParsed.section,
      label: `Aisle ${String(firstParsed.aisle).padStart(2, "0")} · Section ${firstParsed.section}`,
    });
    router.navigate("/(tabs)/map");
  }, [setPendingMapFocus, setPinnedParts, showToast]);

  /**
   * Curried: returns the onVariantsToggle handler for a specific ResultCard.
   * Scopes variant pin removal to this item via groupId (item.id) so multiple
   * expanded cards can coexist without interfering.
   */
  const handleVariantsToggle = React.useCallback((item: InventoryItem) => (variantItems: Array<InventoryItem>, isOpen: boolean) => {
    if (!isOpen) {
      setPinnedParts((prev) => prev.filter(p => !(p.variant && p.groupId === item.id)));
      return;
    }
    const variantPins: Array<PinnedPart> = [];
    for (const v of variantItems) {
      for (const bin of (v.binLocations ?? [])) {
        const parsed = parseBin(bin);
        if (parsed && v.id !== item.id) {
          variantPins.push({ binCode: bin, label: v.catalog, aisleNum: parsed.aisle, variant: true, groupId: item.id });
        }
      }
    }
    setPinnedParts((prev) => [
      ...prev.filter(p => !(p.variant && p.groupId === item.id)),
      ...variantPins,
    ]);
  }, [setPinnedParts]);

  const handleMeasureSearchConfirm = React.useCallback((dims: PartDimensions) => {
    setMeasureSearchVisible(false);
    const toStr = (v: number | null | undefined) => (v != null ? String(Math.round(v)) : "");
    const params = {
      minLength: toStr(dims.length),
      maxLength: toStr(dims.length),
      minWidth: toStr(dims.width),
      maxWidth: toStr(dims.width),
      minHeight: toStr(dims.height),
      maxHeight: toStr(dims.height),
      minDiameter: toStr(dims.diameter),
      maxDiameter: toStr(dims.diameter),
    };
    if (Object.values(params).some(Boolean)) setPendingMeasureSearch(params);
    router.navigate("/");
  }, [setPendingMeasureSearch]);

  const { history } = useScanHistory();
  const [recentTapLoading, setRecentTapLoading] = useState<string | null>(null);

  // Last 5 scans that actually found an item
  const recentFoundScans = React.useMemo(
    () => history.filter((e) => e.found && e.catalog).slice(0, 5),
    [history],
  );

  const handleRecentTap = React.useCallback(async (entry: ScanEntry) => {
    if (!entry.found || recentTapLoading) return;
    setRecentTapLoading(entry.barcode);
    try {
      const offline = await lookupByBarcodeOffline(entry.barcode);
      if (offline) { setBarcodeResult(offline); return; }
      const item = await lookupByBarcode(encodeURIComponent(entry.barcode));
      setBarcodeResult(item);
    } catch {
      // Item may have been deleted — silently ignore
    } finally {
      setRecentTapLoading(null);
    }
  }, [recentTapLoading]);

  const identifyMutation = useAiIdentifyPart();
  const searchMutation = useSearchInventory();
  // Incremented on every identify call so stale async responses from a previous
  // request are discarded (race condition guard).
  const requestIdRef = useRef(0);
  // Timer used to advance "uploading" → "analysing" after a fixed delay.
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up the phase-advance timer if the component unmounts mid-call.
  useEffect(() => () => {
    if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
  }, []);

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

    // Claim a request slot — any in-flight response from a previous tap will see
    // a stale ID and discard its results.
    const thisRequestId = ++requestIdRef.current;

    setInlineError(null);
    setBarcodeResult(null);
    identifyMutation.reset();
    searchMutation.reset();
    setResults([]);
    setAiSummary("");
    setAiTerms([]);
    setMapPromptBins([]);
    setAdminBridgeItem(null);
    setAdminBridgeMeasureItem(null);
    setPinnedParts([]);

    // Phase 1 — show "Uploading" immediately; advance to "Analysing" after 2 s,
    // which is roughly when photo data has been sent and the AI is processing.
    // Clear any lingering timer from a previous (now-superseded) request first.
    if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    setProgressPhase("uploading");
    progressTimerRef.current = setTimeout(() => {
      // Guard: only advance if this request is still the active one.
      if (requestIdRef.current === thisRequestId) setProgressPhase("analysing");
    }, 2000);

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

      // Discard response if a newer request has started — check BEFORE touching
      // any shared state (timer ref, progressPhase) so we don't clobber request 2.
      if (requestIdRef.current !== thisRequestId) return;

      // Safe to clear: this is the active request's timer.
      if (progressTimerRef.current) { clearTimeout(progressTimerRef.current); progressTimerRef.current = null; }

      setAiSummary(identifyResult.summary);
      setAiTerms(identifyResult.searchTerms);

      // Now search with identified terms
      const allTerms = [
        ...identifyResult.searchTerms,
        ...identifyResult.synonyms.slice(0, 3),
      ].join(" ");

      if (allTerms.trim()) {
        // Phase 3 — AI done, now querying inventory.
        setProgressPhase("searching");

        const searchResult = await searchMutation.mutateAsync({
          data: {
            keywords: allTerms,
            catalog: identifyResult.partNumbers?.[0] || undefined,
            vendor: (identifyResult.detectedVendor ?? vendor.trim()) || undefined,
            color: color.trim() || undefined,
            size: size.trim() || undefined,
            textNumbers: textNumbers.trim() || undefined,
            confidenceThreshold: 40,
          },
        });

        if (requestIdRef.current !== thisRequestId) return;
        setResults(searchResult.results);
        // Auto-pin the top result so the worker sees inline location context
        // immediately (post-identification confirmation state). The inline banner
        // lets them navigate to the map without tapping a separate button.
        setMapPromptBins([]);
        setAdminBridgeItem(null);
        if (searchResult.results.length > 0) {
          const topItem = searchResult.results[0].item;
          const pins: Array<PinnedPart> = [];
          for (const bin of (topItem.binLocations ?? [])) {
            const parsed = parseBin(bin);
            if (parsed) pins.push({ binCode: bin, label: topItem.catalog, aisleNum: parsed.aisle });
          }
          if (pins.length > 0) {
            setPinnedParts(pins);
            setMapPromptBins(topItem.binLocations ?? []);
          }
          // Admin bridge: dismissible inline card when dimensions are missing
          const topDims = (topItem as unknown as { dimensions?: { length?: number | null; width?: number | null; height?: number | null; diameter?: number | null } | null }).dimensions;
          if (isAdmin && adminToken && (!topDims || (!topDims.length && !topDims.width && !topDims.height && !topDims.diameter))) {
            setAdminBridgeItem(topItem);
          }
        }
      }
    } catch (err) {
      // Check stale-request FIRST — don't touch shared timer/phase if superseded.
      if (requestIdRef.current !== thisRequestId) return;
      if (progressTimerRef.current) { clearTimeout(progressTimerRef.current); progressTimerRef.current = null; }

      // Poe chain exhausted — all bots failed; prompt the user to retry via OpenAI.
      const isChainExhausted =
        err instanceof Error &&
        "data" in err &&
        (err as { data?: { status?: string } }).data?.status === "poe_chain_exhausted";

      if (isChainExhausted) {
        setProgressPhase(null);
        Alert.alert(
          "AI Unavailable",
          "All AI bots are currently unavailable. Retry using OpenAI instead?",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Use OpenAI",
              onPress: async () => {
                const retryRequestId = ++requestIdRef.current;
                setInlineError(null);
                setProgressPhase("uploading");
                progressTimerRef.current = setTimeout(() => {
                  if (requestIdRef.current === retryRequestId) setProgressPhase("analysing");
                }, 2000);
                try {
                  const fallbackResult = await aiIdentifyPart(
                    {
                      images: images.map((i) => i.base64),
                      keywords: keywords.trim() || undefined,
                      vendor: vendor.trim() || undefined,
                      color: color.trim() || undefined,
                      size: size.trim() || undefined,
                      textNumbers: textNumbers.trim() || undefined,
                    },
                    { headers: { "x-use-openai-fallback": "true" } },
                  );
                  if (requestIdRef.current !== retryRequestId) return;
                  if (progressTimerRef.current) { clearTimeout(progressTimerRef.current); progressTimerRef.current = null; }
                  setAiSummary(fallbackResult.summary);
                  setAiTerms(fallbackResult.searchTerms);
                  const allTerms = [
                    ...fallbackResult.searchTerms,
                    ...fallbackResult.synonyms.slice(0, 3),
                  ].join(" ");
                  if (allTerms.trim()) {
                    setProgressPhase("searching");
                    const searchResult = await searchMutation.mutateAsync({
                      data: {
                        keywords: allTerms,
                        catalog: fallbackResult.partNumbers?.[0] || undefined,
                        vendor: (fallbackResult.detectedVendor ?? vendor.trim()) || undefined,
                        color: color.trim() || undefined,
                        size: size.trim() || undefined,
                        textNumbers: textNumbers.trim() || undefined,
                        confidenceThreshold: 40,
                      },
                    });
                    if (requestIdRef.current !== retryRequestId) return;
                    setResults(searchResult.results);
                  }
                } catch {
                  if (requestIdRef.current === retryRequestId) {
                    setInlineError("OpenAI identification also failed — please try again later.");
                  }
                } finally {
                  if (requestIdRef.current === retryRequestId) setProgressPhase(null);
                }
              },
            },
          ],
        );
        return;
      }

      // Surface a meaningful message based on HTTP status (ApiError.status) when available
      const status =
        err instanceof Error && "status" in err
          ? (err as { status: number }).status
          : null;
      if (err instanceof Error && err.name === "AbortError") {
        setInlineError("Request timed out — please try again on a faster connection.");
      } else if (status === 413) {
        setInlineError("Photo too large — try a smaller or lower-resolution image.");
      } else if (status === 429) {
        setInlineError("Too many requests — please wait a moment and try again.");
      } else if (status != null && status >= 500) {
        setInlineError("Server error — the AI service is temporarily unavailable. Try again shortly.");
      } else {
        setInlineError("Identification failed — could not analyze the part. Please try again.");
      }
    } finally {
      // Only reset our own progress phase; never overwrite a newer request's state.
      if (requestIdRef.current === thisRequestId) setProgressPhase(null);
    }
  };

  const isLoading = identifyMutation.isPending || searchMutation.isPending;

  // Human-readable label for the current progress phase.
  const progressLabel =
    progressPhase === "uploading" ? "Uploading photos…" :
    progressPhase === "analysing" ? "Analysing with AI…" :
    progressPhase === "searching" ? "Searching inventory…" : null;

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
            {images.length > 0 ? (
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
              </View>
            ) : null}

            {isProcessing ? (
              <View style={[styles.processingRow, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={[styles.processingLabel, { color: colors.mutedForeground }]}>Processing…</Text>
              </View>
            ) : (
              <View style={styles.addImageButtons}>
                <Pressable
                  onPress={() => pickImage("camera")}
                  disabled={isProcessing || images.length >= 4}
                  style={[
                    styles.addImageBtn,
                    { backgroundColor: colors.card, borderColor: colors.foreground, opacity: images.length >= 4 ? 0.4 : 1 },
                  ]}
                >
                  <Text style={styles.addImageEmoji}>📷</Text>
                  <Text style={[styles.addImageLabel, { color: colors.foreground }]}>Camera</Text>
                </Pressable>
                <Pressable
                  onPress={() => pickImage("library")}
                  disabled={isProcessing || images.length >= 4}
                  style={[
                    styles.addImageBtn,
                    { backgroundColor: colors.card, borderColor: colors.foreground, opacity: images.length >= 4 ? 0.4 : 1 },
                  ]}
                >
                  <Text style={styles.addImageEmoji}>🖼️</Text>
                  <Text style={[styles.addImageLabel, { color: colors.foreground }]}>Photo Library</Text>
                </Pressable>
                <Pressable
                  onPress={() => { setPinnedParts([]); setBarcodeScanVisible(true); }}
                  style={[styles.addImageBtn, { backgroundColor: colors.card, borderColor: colors.foreground }]}
                >
                  <MaterialCommunityIcons name="barcode-scan" size={24} color={colors.foreground} />
                  <Text style={[styles.addImageLabel, { color: colors.foreground }]}>Scan Barcode</Text>
                </Pressable>
              </View>
            )}

            {images.length === 0 ? (
              <Text style={[styles.imageHint, { color: colors.mutedForeground }]}>
                Add up to 4 photos of the part (front + label recommended)
              </Text>
            ) : (
              <Text style={[styles.photoCounter, { color: colors.mutedForeground }]}>
                {images.length} / 4 photos
              </Text>
            )}

            <Pressable
              onPress={() => setBarcodeMoreVisible(true)}
              style={styles.historyLink}
            >
              <Text style={[styles.historyLinkText, { color: colors.primary }]}>
                Scan history &amp; more
              </Text>
              <Text style={{ color: colors.primary, fontSize: 13 }}>›</Text>
            </Pressable>
          </View>

          {/* Recent scans strip */}
          {recentFoundScans.length > 0 ? (
            <View>
              <Text style={[styles.recentScansTitle, { color: colors.mutedForeground }]}>Recent scans</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentScansRow}>
                {recentFoundScans.map((entry) => {
                  const isLoading = recentTapLoading === entry.barcode;
                  return (
                    <Pressable
                      key={entry.barcode}
                      onPress={() => handleRecentTap(entry)}
                      disabled={!!recentTapLoading}
                      style={({ pressed }) => [
                        styles.recentScanChip,
                        {
                          backgroundColor: pressed && !recentTapLoading ? colors.muted : colors.card,
                          borderColor: colors.border,
                          opacity: recentTapLoading && !isLoading ? 0.5 : 1,
                        },
                      ]}
                    >
                      {isLoading ? (
                        <ActivityIndicator size="small" color={colors.primary} />
                      ) : (
                        <Feather name="maximize" size={12} color={colors.mutedForeground} />
                      )}
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.recentScanCatalog, { color: colors.foreground }]} numberOfLines={1}>
                          {entry.catalog}
                        </Text>
                        {entry.vendor ? (
                          <Text style={[styles.recentScanVendor, { color: colors.mutedForeground }]} numberOfLines={1}>
                            {entry.vendor}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          ) : null}

          {/* Optional context */}
          <View style={[styles.contextCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.contextTitle, { color: colors.foreground }]}>
              Optional Context
            </Text>
            {[
              { label: "Visible Text / Numbers", value: textNumbers, key: "textNumbers", ph: "e.g. BR120, 20A, 125V...", autoCapitalize: "characters" as const },
              { label: "Keywords", value: keywords, key: "keywords", ph: "e.g. breaker, outlet...", autoCapitalize: "none" as const },
              { label: "Vendor", value: vendor, key: "vendor", ph: "e.g. Eaton, Square D...", autoCapitalize: "characters" as const },
              { label: "Color", value: color, key: "color", ph: "e.g. white, gray...", autoCapitalize: "none" as const },
              { label: "Size", value: size, key: "size", ph: "e.g. 20A, 3/4 inch...", autoCapitalize: "none" as const },
            ].map(({ label, value, key, ph, autoCapitalize }) => (
              <View key={key} style={{ marginBottom: 10 }}>
                <Text style={[styles.fieldLabel, { color: colors.foreground }]}>{label}:</Text>
                <KeyboardDoneInput
                  value={value}
                  onChangeText={(v) => {
                    if (key === "textNumbers") setTextNumbers(v.toUpperCase());
                    else if (key === "keywords") setKeywords(v);
                    else if (key === "vendor") setVendor(v.toUpperCase());
                    else if (key === "color") setColor(v);
                    else if (key === "size") setSize(v);
                  }}
                  placeholder={ph}
                  placeholderTextColor={colors.mutedForeground}
                  style={[styles.fieldInput, { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground }]}
                  autoCorrect={false}
                  autoCapitalize={autoCapitalize}
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
                  {progressLabel ?? "Working…"}
                </Text>
              </View>
            ) : (
              <Text style={[styles.identifyBtnText, { color: images.length === 0 ? colors.mutedForeground : colors.primaryForeground }]}>
                🔍 Identify Part
              </Text>
            )}
          </Pressable>

          {/* Step indicator — visible only while a request is in progress */}
          {isLoading && progressPhase ? (
            <View style={styles.stepRow}>
              {(["uploading", "analysing", "searching"] as const).map((phase, idx) => {
                const phaseOrder = { uploading: 0, analysing: 1, searching: 2 };
                const currentIdx = phaseOrder[progressPhase];
                const isDone = phaseOrder[phase] < currentIdx;
                const isActive = phase === progressPhase;
                return (
                  <React.Fragment key={phase}>
                    <View style={styles.stepItem}>
                      <View style={[
                        styles.stepDot,
                        {
                          backgroundColor: isDone
                            ? colors.primary
                            : isActive
                            ? colors.primary
                            : colors.border,
                          opacity: isDone ? 0.5 : 1,
                        },
                      ]}>
                        {isDone ? (
                          <Text style={styles.stepDotCheck}>✓</Text>
                        ) : isActive ? (
                          <ActivityIndicator size="small" color={colors.primaryForeground} style={{ transform: [{ scale: 0.55 }] }} />
                        ) : null}
                      </View>
                      <Text style={[
                        styles.stepLabel,
                        {
                          color: isActive ? colors.foreground : colors.mutedForeground,
                          fontFamily: isActive ? "Inter_600SemiBold" : "Inter_400Regular",
                        },
                      ]}>
                        {phase === "uploading" ? "Upload" : phase === "analysing" ? "Analyse" : "Search"}
                      </Text>
                    </View>
                    {idx < 2 ? (
                      <View style={[styles.stepConnector, { backgroundColor: phaseOrder[phase] < currentIdx ? colors.primary : colors.border, opacity: phaseOrder[phase] < currentIdx ? 0.5 : 0.3 }]} />
                    ) : null}
                  </React.Fragment>
                );
              })}
            </View>
          ) : null}

          {/* Inline error banner */}
          {inlineError ? (
            <View style={[styles.inlineBanner, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "55" }]}>
              <Text style={[styles.inlineBannerText, { color: colors.destructive }]}>⚠ {inlineError}</Text>
              <Pressable onPress={() => setInlineError(null)} style={styles.inlineBannerClose}>
                <Text style={{ color: colors.destructive, fontSize: 14 }}>✕</Text>
              </Pressable>
            </View>
          ) : null}

          {/* Barcode result */}
          {barcodeResult ? (
            <View>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <Text style={[styles.resultsTitle, { color: colors.foreground }]}>Barcode Match</Text>
                <Pressable onPress={() => setBarcodeResult(null)} hitSlop={10}>
                  <Text style={{ color: colors.mutedForeground, fontSize: 14 }}>✕</Text>
                </Pressable>
              </View>
              <ResultCard
                result={{ item: barcodeResult, confidence: 1.0, matchReason: "barcode scan", seriesBase: null, seriesLabel: null, variants: [] }}
                onEditItem={isAdmin ? (item) => setDetailsItem(item) : undefined}
                onShowOnMap={handleShowOnMap}
                onVariantsToggle={handleVariantsToggle(barcodeResult)}
                rank={0}
                fontScale={textFontScale}
              />
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
              {/* Post-identify inline confirmation: banner appears when top result has a mapped bin */}
              {mapPromptBins.length > 0 ? (
                <Pressable
                  onPress={() => router.navigate("/(tabs)/map")}
                  style={[styles.mapPromptBtn, { backgroundColor: "#f59e0b22", borderColor: "#f59e0b66" }]}
                >
                  <Text style={[styles.mapPromptText, { color: "#b45309" }]}>
                    📍 Part pinned on map — Navigate to Map →
                  </Text>
                </Pressable>
              ) : null}
              {/* Admin bridge: dismissible inline prompt when dimensions are missing */}
              {adminBridgeItem ? (
                <View style={[styles.adminBridgeCard, { backgroundColor: "#fef3c711", borderColor: "#f59e0b55" }]}>
                  <Text style={[styles.adminBridgeText, { color: "#92400e" }]}>
                    ⚠️ No dimensions on record — measuring this part improves future searches.
                  </Text>
                  <View style={styles.adminBridgeRow}>
                    <Pressable
                      onPress={() => {
                        const item = adminBridgeItem;
                        setAdminBridgeItem(null);
                        setAdminBridgeMeasureItem(item);
                      }}
                      style={[styles.adminBridgeBtn, { backgroundColor: "#f59e0b", borderColor: "#d97706" }]}
                    >
                      <Text style={styles.adminBridgeBtnText}>📐 Measure Now</Text>
                    </Pressable>
                    <Pressable onPress={() => setAdminBridgeItem(null)} hitSlop={10}>
                      <Text style={{ color: "#92400e", fontSize: 12, fontFamily: "Inter_400Regular" }}>Dismiss</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
              {results.map((result, index) => (
                <ResultCard
                  key={result.item.id}
                  result={result}
                  onEditItem={isAdmin ? (item) => setDetailsItem(item) : undefined}
                  onShowOnMap={handleShowOnMap}
                  onVariantsToggle={handleVariantsToggle(result.item)}
                  rank={index}
                  fontScale={textFontScale}
                  autoExpandPartCard={index === 0}
                />
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
      <BarcodeScanModal
        visible={barcodeScanVisible}
        onClose={() => setBarcodeScanVisible(false)}
        onFound={(item) => setBarcodeResult(item)}
      />

      <Modal
        visible={barcodeMoreVisible}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setBarcodeMoreVisible(false)}
      >
        <BarcodeScreen onClose={() => setBarcodeMoreVisible(false)} />
      </Modal>

      <PartDetailsEditor
        item={detailsItem}
        adminToken={adminToken}
        onClose={() => setDetailsItem(null)}
        onShowOnMap={handleShowOnMap}
      />

      {isAdmin && adminToken ? (
        <MeasurePartScreen
          visible={measureSearchVisible}
          onClose={() => setMeasureSearchVisible(false)}
          onConfirm={handleMeasureSearchConfirm}
          adminToken={adminToken}
        />
      ) : null}

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
    height: 88, borderRadius: 10, borderWidth: 1,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
  },
  processingLabel: { fontSize: 14, fontFamily: "Inter_500Medium" },
  addImageButtons: { flexDirection: "row", gap: 8 },
  addImageBtn: {
    flex: 1,
    height: 88,
    borderRadius: 10,
    borderWidth: 2,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  addImageEmoji: { fontSize: 28 },
  addImageLabel: { fontSize: 12, fontFamily: "Inter_500Medium" },
  imageHint: { fontSize: 12, fontFamily: "Inter_400Regular", fontStyle: "italic" },
  photoCounter: { fontSize: 12, fontFamily: "Inter_500Medium" },
  historyLink: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" },
  historyLinkText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  recentScansTitle: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 },
  recentScansRow: { flexDirection: "row", gap: 8, paddingBottom: 2 },
  recentScanChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: 160,
  },
  recentScanCatalog: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  recentScanVendor: { fontSize: 11, fontFamily: "Inter_400Regular" },
  contextCard: { borderRadius: 12, padding: 14, borderWidth: 1 },
  contextTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", marginBottom: 12 },
  fieldLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 5 },
  fieldInput: { ...secondaryBtnBase, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14, fontFamily: "Inter_400Regular" },
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
  inlineBanner: { ...secondaryBtnBase, padding: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  inlineBannerText: { fontSize: 13, fontFamily: "Inter_500Medium", flex: 1, lineHeight: 18 },
  inlineBannerClose: { paddingLeft: 10 },
  errorCard: { ...secondaryBtnBase, padding: 14 },
  errorText: { fontSize: 14, fontFamily: "Inter_500Medium" },
  welcomeCard: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 8 },
  welcomeTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", marginBottom: 4 },
  welcomeStep: { fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 20 },
  // Progress step indicator
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 4,
  },
  stepItem: {
    alignItems: "center",
    gap: 5,
    minWidth: 64,
  },
  stepDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  stepDotCheck: {
    color: "#fff",
    fontSize: 13,
    fontFamily: "Inter_700Bold",
  },
  stepLabel: {
    fontSize: 11,
    letterSpacing: 0.2,
  },
  stepConnector: {
    flex: 1,
    height: 2,
    maxWidth: 32,
    marginBottom: 18,
    borderRadius: 1,
  },
  mapPromptBtn: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 10,
    alignItems: "center",
  },
  mapPromptText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  adminBridgeCard: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
    marginBottom: 10,
  },
  adminBridgeText: { fontSize: 13, fontFamily: "Inter_500Medium", lineHeight: 18 },
  adminBridgeRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 8 },
  adminBridgeBtn: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  adminBridgeBtnText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
});
