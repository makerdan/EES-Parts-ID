/**
 * Photo ID tab — snap a part, get candidate matches.
 *
 * Pipeline: capture/pick → resize on-device (`utils/resizeImage`) → POST to
 * /ai/identify → render ranked candidates with confidence + match reason.
 * Up to 2 photos are accepted (the API also caps at 2) — front and label shots
 * give the model the most signal. We resize before upload because warehouse
 * phones routinely produce 12MP photos that would otherwise blow the request budget.
 */
import React, { useState, useRef, useEffect } from 'react';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { resizeImage } from '@/utils/resizeImage';
import {
  useSearchInventory,
  useAiIdentifyPart,
  useConfirmPhotoId,
} from '@workspace/api-client-react';
import type { SearchResult } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/contexts/AppContext';
import { ResultCard } from '@/components/ResultCard';
import { ReferenceModal } from '@/components/ReferenceModal';
import { secondaryBtnBase } from '@/styles/shared';

export default function PhotoScreen() {
  const colors = useColors();
  const { textFontScale } = useApp();
  const [showRefModal, setShowRefModal] = useState(false);
  const [images, setImages] = useState<{ uri: string; base64: string }[]>([]);
  const [keywords, setKeywords] = useState('');
  const [vendor, setVendor] = useState('');
  const [color, setColor] = useState('');
  const [size, setSize] = useState('');
  const [textNumbers, setTextNumbers] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [aiSummary, setAiSummary] = useState('');
  const [aiTerms, setAiTerms] = useState<string[]>([]);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [cameraPermissionDenied, setCameraPermissionDenied] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  // Tracks which phase of the multi-step AI identification flow we are in.
  type ProgressPhase = 'uploading' | 'analysing' | 'searching' | null;
  const [progressPhase, setProgressPhase] = useState<ProgressPhase>(null);

  const [photoEventId, setPhotoEventId] = useState<number | null>(null);

  const identifyMutation = useAiIdentifyPart();
  const searchMutation = useSearchInventory();
  const confirmMutation = useConfirmPhotoId();
  // Incremented on every identify call so stale async responses from a previous
  // request are discarded (race condition guard).
  const requestIdRef = useRef(0);
  // Timer used to advance "uploading" → "analysing" after a fixed delay.
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up the phase-advance timer if the component unmounts mid-call.
  useEffect(
    () => () => {
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    },
    []
  );

  const pickImage = async (source: 'camera' | 'library') => {
    if (images.length >= 2) {
      setInlineError('Max 2 photos — remove one first.');
      return;
    }
    setInlineError(null);
    setCameraPermissionDenied(false);

    let result;
    if (source === 'camera') {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        setCameraPermissionDenied(true);
        return;
      }
      result = await ImagePicker.launchCameraAsync({
        mediaTypes: 'images',
        quality: 0.7,
        allowsEditing: true,
        aspect: [4, 3],
      });
    } else {
      const remainingSlots = 2 - images.length;
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        quality: 0.7,
        allowsMultipleSelection: true,
        selectionLimit: remainingSlots,
      });
    }

    if (!result.canceled && result.assets.length > 0) {
      const currentCount = images.length;
      const allowedAssets = result.assets.slice(0, 2 - currentCount);
      const overflowMessage =
        allowedAssets.length < result.assets.length
          ? 'Max 2 photos — only the first was added.'
          : null;

      setIsProcessing(true);
      try {
        // Process each photo independently so one bad file (corrupt, stale URI,
        // unsupported format, etc.) doesn't discard the rest of the batch.
        const settled = await Promise.allSettled(
          allowedAssets.map((asset) => resizeImage(asset.uri, asset.width ?? 0))
        );

        const successfulImages: { uri: string; base64: string }[] = [];
        const failedNames: string[] = [];
        settled.forEach((outcome, index) => {
          if (outcome.status === 'fulfilled') {
            successfulImages.push({
              uri: outcome.value.uri,
              base64: outcome.value.base64,
            });
          } else {
            // Prefer the original file name when the picker provided one
            // (helps users find the exact file in their library); fall back
            // to a positional label like "Photo 2 of 3" so the user can still
            // identify which selection failed.
            const asset = allowedAssets[index];
            const fileName = asset?.fileName?.trim();
            failedNames.push(
              fileName && fileName.length > 0
                ? fileName
                : `Photo ${index + 1} of ${allowedAssets.length}`
            );
          }
        });

        if (successfulImages.length > 0) {
          setImages((prev) => [...prev, ...successfulImages]);
        }

        const errorParts: string[] = [];
        if (overflowMessage) errorParts.push(overflowMessage);
        if (failedNames.length > 0) {
          const list = failedNames.join(', ');
          const someSucceeded = successfulImages.length > 0;
          if (failedNames.length === 1) {
            errorParts.push(`Couldn't process ${list} — please try a different photo.`);
          } else if (someSucceeded) {
            errorParts.push(`Couldn't process these photos: ${list}. The other photos were added.`);
          } else {
            errorParts.push(
              `Couldn't process any of the selected photos: ${list}. Please try different photos.`
            );
          }
        }
        setInlineError(errorParts.length > 0 ? errorParts.join(' ') : null);
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
      setInlineError('Add at least one photo before identifying.');
      return;
    }

    // Claim a request slot — any in-flight response from a previous tap will see
    // a stale ID and discard its results.
    const thisRequestId = ++requestIdRef.current;

    setInlineError(null);
    identifyMutation.reset();
    searchMutation.reset();
    setResults([]);
    setAiSummary('');
    setAiTerms([]);

    // Phase 1 — show "Uploading" immediately; advance to "Analysing" after 2 s,
    // which is roughly when photo data has been sent and the AI is processing.
    // Clear any lingering timer from a previous (now-superseded) request first.
    if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    setProgressPhase('uploading');
    progressTimerRef.current = setTimeout(() => {
      // Guard: only advance if this request is still the active one.
      if (requestIdRef.current === thisRequestId) setProgressPhase('analysing');
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
      if (progressTimerRef.current) {
        clearTimeout(progressTimerRef.current);
        progressTimerRef.current = null;
      }

      setAiSummary(identifyResult.summary);
      setAiTerms(identifyResult.searchTerms);

      // Store telemetry event ID so result confirmations can be recorded.
      setPhotoEventId(identifyResult._telemetry?.photoEventId ?? null);

      // If the server already resolved results (catalog_exact or attribute_match),
      // use them directly — no second search needed.
      if (identifyResult.results && identifyResult.results.length > 0) {
        setResults(identifyResult.results as SearchResult[]);
      } else {
        // Descriptive path: client drives the keyword search as before.
        const allTerms = [
          ...identifyResult.searchTerms,
          ...identifyResult.synonyms.slice(0, 3),
        ].join(' ');

        if (allTerms.trim()) {
          // Phase 3 — AI done, now querying inventory.
          setProgressPhase('searching');

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

          if (requestIdRef.current !== thisRequestId) return;
          setResults(searchResult.results);
        }
      }
    } catch (err) {
      // Check stale-request FIRST — don't touch shared timer/phase if superseded.
      if (requestIdRef.current !== thisRequestId) return;
      if (progressTimerRef.current) {
        clearTimeout(progressTimerRef.current);
        progressTimerRef.current = null;
      }
      // Surface a meaningful message based on HTTP status (ApiError.status) when available
      const status =
        err instanceof Error && 'status' in err ? (err as { status: number }).status : null;
      if (err instanceof Error && err.name === 'AbortError') {
        setInlineError('Request timed out — please try again on a faster connection.');
      } else if (status === 413) {
        setInlineError('Photo too large — try a smaller or lower-resolution image.');
      } else if (status === 429) {
        setInlineError('Too many requests — please wait a moment and try again.');
      } else if (status != null && status >= 500) {
        setInlineError(
          'Server error — the AI service is temporarily unavailable. Try again shortly.'
        );
      } else {
        setInlineError('Identification failed — could not analyze the part. Please try again.');
      }
    } finally {
      // Only reset our own progress phase; never overwrite a newer request's state.
      if (requestIdRef.current === thisRequestId) setProgressPhase(null);
    }
  };

  const isLoading = identifyMutation.isPending || searchMutation.isPending;

  // Human-readable label for the current progress phase.
  const progressLabel =
    progressPhase === 'uploading'
      ? 'Uploading photos…'
      : progressPhase === 'analysing'
        ? 'Analysing with AI…'
        : progressPhase === 'searching'
          ? 'Searching inventory…'
          : null;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          {/* Tapping the app title from any tab jumps back to the Search
              tab's empty welcome state (handled there by tabPress). */}
          <Pressable onPress={() => router.replace('/(tabs)')} hitSlop={8}>
            <Text
              allowFontScaling={false}
              style={[styles.headerTitle, { color: colors.foreground }]}
            >
              Photo ID
            </Text>
            <Text
              allowFontScaling={false}
              style={[styles.headerSub, { color: colors.mutedForeground }]}
            >
              Identify parts from photos
            </Text>
          </Pressable>
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
                    <Text allowFontScaling={false} style={styles.removeBtnText}>
                      ✕
                    </Text>
                  </Pressable>
                </View>
              ))}

              {images.length < 2 ? (
                isProcessing ? (
                  <View
                    style={[
                      styles.processingRow,
                      { borderColor: colors.border, backgroundColor: colors.card },
                    ]}
                  >
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text
                      allowFontScaling={false}
                      style={[styles.processingLabel, { color: colors.mutedForeground }]}
                    >
                      Processing…
                    </Text>
                  </View>
                ) : (
                  <View style={styles.addImageButtons}>
                    <Pressable
                      onPress={() => pickImage('camera')}
                      disabled={isProcessing}
                      style={[
                        styles.addImageBtn,
                        { backgroundColor: colors.card, borderColor: colors.foreground },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel="Take photo with camera"
                    >
                      <MaterialCommunityIcons name="camera" size={28} color={colors.foreground} />
                      <Text
                        allowFontScaling={false}
                        style={[styles.addImageLabel, { color: colors.foreground }]}
                      >
                        Camera
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => pickImage('library')}
                      disabled={isProcessing}
                      style={[
                        styles.addImageBtn,
                        { backgroundColor: colors.card, borderColor: colors.foreground },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel="Pick from photo library"
                    >
                      <MaterialCommunityIcons
                        name="image-multiple"
                        size={28}
                        color={colors.foreground}
                      />
                      <Text
                        allowFontScaling={false}
                        style={[styles.addImageLabel, { color: colors.foreground }]}
                      >
                        Photo Library
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => router.push('/scan')}
                      disabled={isProcessing}
                      style={[
                        styles.addImageBtn,
                        { backgroundColor: colors.card, borderColor: colors.foreground },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel="Scan barcode"
                    >
                      <MaterialCommunityIcons
                        name="barcode-scan"
                        size={28}
                        color={colors.foreground}
                      />
                      <Text
                        allowFontScaling={false}
                        style={[styles.addImageLabel, { color: colors.foreground }]}
                      >
                        Barcode
                      </Text>
                    </Pressable>
                  </View>
                )
              ) : null}
            </View>

            {images.length === 0 ? (
              <Text
                allowFontScaling={false}
                style={[styles.imageHint, { color: colors.mutedForeground }]}
              >
                Add up to 2 photos — front and label work best
              </Text>
            ) : (
              <Text
                allowFontScaling={false}
                style={[styles.photoCounter, { color: colors.mutedForeground }]}
              >
                {images.length} / 2 photos
              </Text>
            )}
          </View>

          {/* Optional context */}
          <View
            style={[
              styles.contextCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
          >
            <Text
              allowFontScaling={false}
              style={[styles.contextTitle, { color: colors.foreground }]}
            >
              Optional Context
            </Text>
            {[
              {
                label: 'Visible Text / Numbers',
                value: textNumbers,
                key: 'textNumbers',
                ph: 'e.g. BR120, 20A, 125V...',
              },
              {
                label: 'Keywords',
                value: keywords,
                key: 'keywords',
                ph: 'e.g. breaker, outlet...',
              },
              { label: 'Vendor', value: vendor, key: 'vendor', ph: 'e.g. Eaton, Square D...' },
              { label: 'Color', value: color, key: 'color', ph: 'e.g. white, gray...' },
              { label: 'Size', value: size, key: 'size', ph: 'e.g. 20A, 3/4 inch...' },
            ].map(({ label, value, key, ph }) => (
              <View key={key} style={{ marginBottom: 10 }}>
                <Text
                  allowFontScaling={false}
                  style={[styles.fieldLabel, { color: colors.foreground }]}
                >
                  {label}:
                </Text>
                <TextInput
                  value={value}
                  onChangeText={(v) => {
                    if (key === 'textNumbers') setTextNumbers(v);
                    else if (key === 'keywords') setKeywords(v);
                    else if (key === 'vendor') setVendor(v);
                    else if (key === 'color') setColor(v);
                    else if (key === 'size') setSize(v);
                  }}
                  placeholder={ph}
                  placeholderTextColor={colors.mutedForeground}
                  style={[
                    styles.fieldInput,
                    {
                      backgroundColor: colors.muted,
                      borderColor: colors.border,
                      color: colors.foreground,
                    },
                  ]}
                  autoCorrect={false}
                  autoCapitalize="none"
                  returnKeyType="done"
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
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <ActivityIndicator color={colors.primaryForeground} />
                <Text
                  allowFontScaling={false}
                  style={[styles.identifyBtnText, { color: colors.primaryForeground }]}
                >
                  {progressLabel ?? 'Working…'}
                </Text>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <MaterialCommunityIcons
                  name="magnify"
                  size={20}
                  color={images.length === 0 ? colors.mutedForeground : colors.primaryForeground}
                />
                <Text
                  allowFontScaling={false}
                  style={[
                    styles.identifyBtnText,
                    {
                      color:
                        images.length === 0 ? colors.mutedForeground : colors.primaryForeground,
                    },
                  ]}
                >
                  Identify Part
                </Text>
              </View>
            )}
          </Pressable>

          {/* Step indicator — visible only while a request is in progress */}
          {isLoading && progressPhase ? (
            <View style={styles.stepRow}>
              {(['uploading', 'analysing', 'searching'] as const).map((phase, idx) => {
                const phaseOrder = { uploading: 0, analysing: 1, searching: 2 };
                const currentIdx = phaseOrder[progressPhase];
                const isDone = phaseOrder[phase] < currentIdx;
                const isActive = phase === progressPhase;
                return (
                  <React.Fragment key={phase}>
                    <View style={styles.stepItem}>
                      <View
                        style={[
                          styles.stepDot,
                          {
                            backgroundColor: isDone
                              ? colors.primary
                              : isActive
                                ? colors.primary
                                : colors.border,
                            opacity: isDone ? 0.5 : 1,
                          },
                        ]}
                      >
                        {isDone ? (
                          <Text allowFontScaling={false} style={styles.stepDotCheck}>
                            ✓
                          </Text>
                        ) : isActive ? (
                          <ActivityIndicator
                            size="small"
                            color={colors.primaryForeground}
                            style={{ transform: [{ scale: 0.55 }] }}
                          />
                        ) : null}
                      </View>
                      <Text
                        allowFontScaling={false}
                        style={[
                          styles.stepLabel,
                          {
                            color: isActive ? colors.foreground : colors.mutedForeground,
                            fontFamily: isActive ? 'Inter_600SemiBold' : 'Inter_400Regular',
                          },
                        ]}
                      >
                        {phase === 'uploading'
                          ? 'Upload'
                          : phase === 'analysing'
                            ? 'Analyse'
                            : 'Search'}
                      </Text>
                    </View>
                    {idx < 2 ? (
                      <View
                        style={[
                          styles.stepConnector,
                          {
                            backgroundColor:
                              phaseOrder[phase] < currentIdx ? colors.primary : colors.border,
                            opacity: phaseOrder[phase] < currentIdx ? 0.5 : 0.3,
                          },
                        ]}
                      />
                    ) : null}
                  </React.Fragment>
                );
              })}
            </View>
          ) : null}

          {/* Camera permission denied card */}
          {cameraPermissionDenied ? (
            <View
              style={[
                styles.permissionCard,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text
                allowFontScaling={false}
                style={[styles.permissionTitle, { color: colors.foreground }]}
              >
                Camera access is off
              </Text>
              <Text
                allowFontScaling={false}
                style={[styles.permissionBody, { color: colors.mutedForeground }]}
              >
                Open Settings to allow camera access for Photo ID.
              </Text>
              <Pressable
                style={[styles.permissionPrimaryBtn, { backgroundColor: colors.primary }]}
                onPress={() => {
                  setCameraPermissionDenied(false);
                  Linking.openSettings();
                }}
              >
                <Text
                  allowFontScaling={false}
                  style={[styles.permissionPrimaryBtnText, { color: colors.primaryForeground }]}
                >
                  Open Settings
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setCameraPermissionDenied(false)}
                style={styles.permissionSecondaryBtn}
              >
                <Text
                  allowFontScaling={false}
                  style={{ color: colors.primary, fontFamily: 'Inter_500Medium' }}
                >
                  Dismiss
                </Text>
              </Pressable>
            </View>
          ) : null}

          {/* Inline error banner */}
          {inlineError ? (
            <View
              style={[
                styles.inlineBanner,
                {
                  backgroundColor: colors.destructive + '15',
                  borderColor: colors.destructive + '55',
                },
              ]}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                <MaterialCommunityIcons
                  name="alert-circle-outline"
                  size={14}
                  color={colors.destructive}
                />
                <Text
                  allowFontScaling={false}
                  style={[styles.inlineBannerText, { color: colors.destructive, flex: 1 }]}
                >
                  {inlineError}
                </Text>
              </View>
              <Pressable onPress={() => setInlineError(null)} style={styles.inlineBannerClose}>
                <Text allowFontScaling={false} style={{ color: colors.destructive, fontSize: 14 }}>
                  ✕
                </Text>
              </Pressable>
            </View>
          ) : null}

          {/* AI summary */}
          {aiSummary ? (
            <View
              style={[
                styles.summaryCard,
                { backgroundColor: colors.accent, borderColor: colors.primary + '44' },
              ]}
            >
              <Text
                allowFontScaling={false}
                style={[styles.summaryTitle, { color: colors.accentForeground }]}
              >
                AI Identification
              </Text>
              <Text
                allowFontScaling={false}
                style={[styles.summaryText, { color: colors.foreground }]}
              >
                {aiSummary}
              </Text>
              {aiTerms.length > 0 ? (
                <View style={{ marginTop: 10 }}>
                  <Text
                    allowFontScaling={false}
                    style={[styles.termLabel, { color: colors.accentForeground }]}
                  >
                    SEARCH TERMS USED
                  </Text>
                  <View style={styles.termRow}>
                    {aiTerms.map((term, i) => (
                      <View
                        key={i}
                        style={[styles.termChip, { backgroundColor: colors.primary + '22' }]}
                      >
                        <Text
                          allowFontScaling={false}
                          style={[styles.termText, { color: colors.primary }]}
                        >
                          {term}
                        </Text>
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
              <Text
                allowFontScaling={false}
                style={[styles.resultsTitle, { color: colors.foreground }]}
              >
                {results.length} Matching Parts
              </Text>
              {results.map((result, index) => (
                <ResultCard
                  key={result.item.id}
                  result={result}
                  rank={index}
                  fontScale={textFontScale}
                  onConfirm={
                    photoEventId != null
                      ? () => {
                          confirmMutation.mutate({
                            data: { photoEventId: photoEventId, resultId: result.item.id },
                          });
                        }
                      : undefined
                  }
                />
              ))}
            </View>
          ) : null}

          {/* No results */}
          {searchMutation.isSuccess && results.length === 0 && aiSummary ? (
            <View
              style={[
                styles.noResultsCard,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text
                allowFontScaling={false}
                style={[styles.noResultsText, { color: colors.mutedForeground }]}
              >
                No inventory matches found for this part. Try adding it to inventory via the Upload
                tab.
              </Text>
            </View>
          ) : null}

          {/* Error */}
          {identifyMutation.isError ? (
            <View
              style={[
                styles.errorCard,
                {
                  backgroundColor: colors.destructive + '11',
                  borderColor: colors.destructive + '44',
                },
              ]}
            >
              <Text
                allowFontScaling={false}
                style={[styles.errorText, { color: colors.destructive }]}
              >
                AI identification failed. Check your connection.
              </Text>
            </View>
          ) : null}

          {/* Welcome state */}
          {!identifyMutation.isSuccess && !identifyMutation.isPending && images.length === 0 ? (
            <View
              style={[
                styles.welcomeCard,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text
                allowFontScaling={false}
                style={[styles.welcomeTitle, { color: colors.foreground }]}
              >
                How it works
              </Text>
              {[
                '📷 Take or select up to 2 photos of the part',
                '📝 Add any visible text, numbers, or labels',
                '🤖 AI identifies the part type and specifications',
                '📦 Matching items from inventory are shown',
              ].map((step, i) => (
                <Text
                  allowFontScaling={false}
                  key={i}
                  style={[styles.welcomeStep, { color: colors.mutedForeground }]}
                >
                  {step}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      </ScrollView>
      <ReferenceModal open={showRefModal} onClose={() => setShowRefModal(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  headerTitle: { fontSize: 20, fontFamily: 'Inter_700Bold' },
  headerSub: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  content: { padding: 16, gap: 14 },
  imageSection: { gap: 8 },
  imageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  imageWrapper: { position: 'relative' },
  thumbnail: { width: 130, height: 130, borderRadius: 10, borderWidth: 2 },
  removeBtn: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtnText: { color: '#fff', fontSize: 10, fontFamily: 'Inter_700Bold' },
  processingRow: {
    width: 270,
    height: 130,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  processingLabel: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  addImageButtons: { flexDirection: 'row', gap: 10, justifyContent: 'center' },
  addImageBtn: {
    width: 100,
    height: 100,
    borderRadius: 10,
    borderWidth: 2,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  addImageLabel: { fontSize: 12, fontFamily: 'Inter_500Medium', textAlign: 'center' },
  imageHint: { fontSize: 12, fontFamily: 'Inter_400Regular', fontStyle: 'italic' },
  photoCounter: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  contextCard: { borderRadius: 12, padding: 14, borderWidth: 1 },
  contextTitle: { fontSize: 14, fontFamily: 'Inter_600SemiBold', marginBottom: 12 },
  fieldLabel: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 5,
  },
  fieldInput: {
    ...secondaryBtnBase,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  identifyBtn: { borderRadius: 10, paddingVertical: 15, alignItems: 'center' },
  identifyBtnText: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  summaryCard: { borderRadius: 10, padding: 14, borderWidth: 1 },
  summaryTitle: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  summaryText: { fontSize: 14, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  termLabel: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  termRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  termChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  termText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  resultsTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold', marginBottom: 10 },
  noResultsCard: { borderRadius: 10, padding: 16, borderWidth: 1 },
  noResultsText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
  inlineBanner: {
    ...secondaryBtnBase,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  inlineBannerText: { fontSize: 13, fontFamily: 'Inter_500Medium', flex: 1, lineHeight: 18 },
  inlineBannerClose: { paddingLeft: 10 },
  errorCard: { ...secondaryBtnBase, padding: 14 },
  errorText: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  welcomeCard: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 8 },
  welcomeTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold', marginBottom: 4 },
  welcomeStep: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  // Progress step indicator
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  stepItem: {
    alignItems: 'center',
    gap: 5,
    minWidth: 64,
  },
  stepDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotCheck: {
    color: '#fff',
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
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
  permissionCard: {
    margin: 24,
    padding: 20,
    gap: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  permissionTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  permissionBody: { fontSize: 14, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  permissionPrimaryBtn: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  permissionPrimaryBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  permissionSecondaryBtn: { paddingVertical: 8, alignItems: 'center' },
});
