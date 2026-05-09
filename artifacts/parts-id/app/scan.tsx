/**
 * Scan tab — point camera at a barcode / QR / Data Matrix label and jump
 * straight to the part. Vendor barcodes (UPCs) usually do NOT match the
 * warehouse catalog code, so unknown scans fall through to a
 * scan-to-link picker that calls the existing Search and Photo ID
 * surfaces to bind the barcode to the right inventory row.
 *
 * Scanning is one-shot: a successful read pauses the camera, opens the
 * result, and only re-arms when the worker dismisses the result. That
 * matches the warehouse workflow ("scan, look at part, walk to bin")
 * and avoids the chaos of repeated reads on the same label.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useBarcodeLookup,
  barcodeLink,
  useBarcodeRecent,
  useSearchInventory,
  useAiIdentifyPart,
} from '@workspace/api-client-react';
import type {
  InventoryItem,
  SearchResult,
  BarcodeLookupResponse,
} from '@workspace/api-client-react';
import * as ImagePicker from 'expo-image-picker';
import { resizeImage } from '@/utils/resizeImage';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/contexts/AppContext';
import { ResultCard } from '@/components/ResultCard';
import { RecordEditModal } from '@/components/RecordEditModal';
import { Toast } from '@/components/Toast';
import { ErrorBanner } from '@/components/ErrorBanner';

const BARCODE_TYPES = [
  'ean13',
  'ean8',
  'upc_a',
  'upc_e',
  'code128',
  'code39',
  'datamatrix',
  'qr',
] as const;

type PickerMode = 'menu' | 'search' | 'photo';

export default function ScanScreen() {
  const colors = useColors();
  const { textFontScale } = useApp();
  const isWeb = Platform.OS === 'web';
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Cancel/Close affordance for the Scan screen. The screen is hidden
  // from the bottom tab bar (Task #129/#133), so without this overlay
  // a worker who opened Scan from the Search header has no obvious way
  // back. router.back() returns to wherever they came from; if there's
  // no back history (deep link / refresh on web) we fall back to "/".
  // Rendered in every return path (camera, permission gates, web/no-
  // permission placeholder) so it's always reachable. Hardware back on
  // Android is handled by the OS as before — this overlay does not
  // intercept it.
  const handleCancel = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }, [router]);

  const renderCancelButton = (variant: 'onCamera' | 'onSurface') => {
    const onCamera = variant === 'onCamera';
    return (
      <Pressable
        onPress={handleCancel}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Cancel scan"
        style={[
          styles.cancelBtn,
          {
            top: insets.top + 8,
            right: 12,
            backgroundColor: onCamera ? '#000000B3' : colors.card,
            borderColor: onCamera ? 'transparent' : colors.border,
            borderWidth: onCamera ? 0 : StyleSheet.hairlineWidth,
          },
        ]}
      >
        <Text
          allowFontScaling={false}
          style={[styles.cancelBtnText, { color: onCamera ? '#fff' : colors.foreground }]}
        >
          ✕
        </Text>
      </Pressable>
    );
  };

  const [permission, requestPermission] = useCameraPermissions();
  const [permissionExplained, setPermissionExplained] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [scanning, setScanning] = useState(true);
  const [manualEntry, setManualEntry] = useState(isWeb);
  const [manualValue, setManualValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const lastScanRef = useRef<string>('');
  const pendingBarcodeRef = useRef<string>('');
  const lockOnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Result panel state
  const [matchedItem, setMatchedItem] = useState<InventoryItem | null>(null);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [pendingBarcode, setPendingBarcode] = useState<string | null>(null);
  const [recentItems, setRecentItems] = useState<InventoryItem[]>([]);
  const [pickerMode, setPickerMode] = useState<PickerMode>('menu');

  const { adminToken, isAdmin } = useApp();
  // The mutating /link endpoint is gated by the admin token (same gate
  // the Upload tab uses). Reads (`/lookup`, `/recent`) are open.
  const [linking, setLinking] = useState(false);
  const lookupMutation = useBarcodeLookup();
  const searchMutation = useSearchInventory();
  const identifyMutation = useAiIdentifyPart();
  const recentQuery = useBarcodeRecent({ limit: 20 });

  // Show ephemeral toasts (auto-dismiss after 2.5s).
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const resetScanner = useCallback(() => {
    setMatchedItem(null);
    setPendingBarcode(null);
    setPickerMode('menu');
    setError(null);
    lastScanRef.current = '';
    pendingBarcodeRef.current = '';
    if (lockOnTimerRef.current) {
      clearTimeout(lockOnTimerRef.current);
      lockOnTimerRef.current = null;
    }
    setScanning(true);
  }, []);

  const performLookup = useCallback(
    async (barcode: string) => {
      const trimmed = barcode.trim();
      if (!trimmed) return;
      setScanning(false);
      setError(null);
      try {
        const res: BarcodeLookupResponse = await lookupMutation.mutateAsync({
          data: { barcode: trimmed },
        });
        setRecentItems(res.recentlyViewed);
        if (res.match) {
          setMatchedItem(res.match);
          setPendingBarcode(null);
          // Light haptic + toast confirms the scan landed on a real part.
          if (Platform.OS !== 'web') {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          setToast(`Scanned ${res.match.catalog}`);
        } else {
          setMatchedItem(null);
          setPendingBarcode(trimmed);
          setPickerMode('menu');
          if (Platform.OS !== 'web') {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          }
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? `Lookup failed: ${err.message}`
            : 'Lookup failed — please try again.'
        );
        setScanning(true);
      }
    },
    [lookupMutation]
  );

  const handleBarcodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (!scanning || lookupMutation.isPending) return;
      // Always record the latest barcode so the shutter button can fire it.
      pendingBarcodeRef.current = data;
      // If it's the same code still in frame the timer is already running — leave it.
      if (data === lastScanRef.current) return;
      lastScanRef.current = data;
      // Restart the lock-on timer: auto-fire only after the barcode is held
      // steady for 1.5 seconds, giving the user time to reposition.
      if (lockOnTimerRef.current) clearTimeout(lockOnTimerRef.current);
      lockOnTimerRef.current = setTimeout(() => {
        lockOnTimerRef.current = null;
        void performLookup(pendingBarcodeRef.current);
      }, 1500);
    },
    [scanning, lookupMutation.isPending, performLookup]
  );

  const handleShutter = useCallback(() => {
    if (pendingBarcodeRef.current) {
      if (lockOnTimerRef.current) {
        clearTimeout(lockOnTimerRef.current);
        lockOnTimerRef.current = null;
      }
      void performLookup(pendingBarcodeRef.current);
    } else {
      setToast('Aim at a barcode first');
    }
  }, [performLookup]);

  const handleManualSubmit = useCallback(() => {
    if (!manualValue.trim()) return;
    void performLookup(manualValue);
    setManualValue('');
  }, [manualValue, performLookup]);

  // Link the pending barcode to a chosen part, then surface the part.
  const handlePickPart = useCallback(
    async (item: InventoryItem) => {
      if (!pendingBarcode) {
        setMatchedItem(item);
        return;
      }
      if (!isAdmin || !adminToken) {
        setError('Sign in as admin (Upload tab) to teach the app new barcodes.');
        return;
      }
      setLinking(true);
      try {
        const res = await barcodeLink(
          { barcode: pendingBarcode, inventoryId: item.id },
          { headers: { Authorization: `Bearer ${adminToken}` } }
        );
        setMatchedItem(res.item);
        setPendingBarcode(null);
        setToast(`Linked to ${res.item.catalog}`);
        if (Platform.OS !== 'web') {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } catch (err) {
        setError(
          err instanceof Error ? `Failed to link: ${err.message}` : 'Failed to link barcode.'
        );
      } finally {
        setLinking(false);
      }
    },
    [pendingBarcode, isAdmin, adminToken]
  );

  // Sub-picker: search by keyword/catalog
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const runSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    try {
      const res = await searchMutation.mutateAsync({
        data: { keywords: searchQuery, confidenceThreshold: 30 },
      });
      setSearchResults(res.results);
    } catch (err) {
      setError(err instanceof Error ? `Search failed: ${err.message}` : 'Search failed.');
    }
  }, [searchQuery, searchMutation]);

  // Sub-picker: photo ID
  const runPhotoIdentify = useCallback(async () => {
    try {
      const cam = await ImagePicker.requestCameraPermissionsAsync();
      if (cam.status !== 'granted') {
        setError('Camera access denied — please enable it in Settings.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: 'images',
        quality: 0.7,
        allowsEditing: true,
      });
      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0]!;
      const resized = await resizeImage(asset.uri, asset.width ?? 0);
      const id = await identifyMutation.mutateAsync({
        data: { images: [resized.base64] },
      });
      const allTerms = [...id.searchTerms, ...id.synonyms.slice(0, 3)].join(' ');
      if (allTerms.trim()) {
        const res = await searchMutation.mutateAsync({
          data: { keywords: allTerms, confidenceThreshold: 30 },
        });
        setSearchResults(res.results);
      }
    } catch (err) {
      setError(err instanceof Error ? `Photo ID failed: ${err.message}` : 'Photo ID failed.');
    }
  }, [identifyMutation, searchMutation]);

  // ── Permission gate ────────────────────────────────────────────────────────
  if (!isWeb && !permission) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  // When the worker has chosen manual entry, fall through to the main
  // view so the input bar is reachable regardless of the camera
  // permission state — the gates below are bypassed.
  if (!isWeb && permission && !permission.granted && !permissionExplained && !manualEntry) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        {renderCancelButton('onSurface')}
        <View style={styles.explainerCard}>
          <Text
            allowFontScaling={false}
            style={[styles.explainerTitle, { color: colors.foreground }]}
          >
            Scan barcodes to find parts faster
          </Text>
          <Text
            allowFontScaling={false}
            style={[styles.explainerBody, { color: colors.mutedForeground }]}
          >
            We use the camera only while you're on this tab to read EAN, UPC, Code 128, Code 39,
            Data Matrix, and QR codes printed on parts and bins. Photos are never stored.
          </Text>
          <Pressable
            style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
            onPress={async () => {
              setPermissionExplained(true);
              await requestPermission();
            }}
          >
            <Text
              allowFontScaling={false}
              style={[styles.primaryBtnText, { color: colors.primaryForeground }]}
            >
              Continue
            </Text>
          </Pressable>
          <Pressable onPress={() => setManualEntry(true)} style={styles.secondaryBtn}>
            <Text
              allowFontScaling={false}
              style={{ color: colors.primary, fontFamily: 'Inter_500Medium' }}
            >
              Type barcode instead
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!isWeb && permission && !permission.granted && !manualEntry) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
        {renderCancelButton('onSurface')}
        <View style={styles.explainerCard}>
          <Text
            allowFontScaling={false}
            style={[styles.explainerTitle, { color: colors.foreground }]}
          >
            Camera access is off
          </Text>
          <Text
            allowFontScaling={false}
            style={[styles.explainerBody, { color: colors.mutedForeground }]}
          >
            Open Settings to grant camera access, or type the barcode by hand.
          </Text>
          <Pressable
            style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
            onPress={() => Linking.openSettings()}
          >
            <Text
              allowFontScaling={false}
              style={[styles.primaryBtnText, { color: colors.primaryForeground }]}
            >
              Open Settings
            </Text>
          </Pressable>
          <Pressable onPress={() => setManualEntry(true)} style={styles.secondaryBtn}>
            <Text
              allowFontScaling={false}
              style={{ color: colors.primary, fontFamily: 'Inter_500Medium' }}
            >
              Type barcode instead
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/*
        Cancel overlay sits above the viewfinder/controls. It's the
        last child below so it paints on top of the camera, reticle,
        torch/manual buttons, manual bar, toast, and inline error
        without obscuring the reticle (top-right corner, away from
        the centered hint) or the bottom controls row.
      */}
      {/* Camera viewfinder */}
      {!isWeb && permission?.granted ? (
        <View style={styles.cameraWrap}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            enableTorch={torchOn}
            barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
            onBarcodeScanned={scanning ? handleBarcodeScanned : undefined}
          />
          {/* Reticle overlay */}
          <View pointerEvents="none" style={styles.reticleWrap}>
            <View style={[styles.reticle, { borderColor: colors.primary }]} />
            <Text allowFontScaling={false} style={[styles.reticleHint, { color: '#fff' }]}>
              {lookupMutation.isPending ? 'Looking up…' : 'Center barcode in the box'}
            </Text>
          </View>
          {/* Shutter button — tap to capture immediately without waiting for the lock-on delay */}
          {scanning && !lookupMutation.isPending ? (
            <Pressable
              onPress={handleShutter}
              style={styles.shutterBtn}
              accessibilityRole="button"
              accessibilityLabel="Capture barcode now"
            >
              <View style={styles.shutterInner} />
            </Pressable>
          ) : null}
          <View style={styles.controlsRow}>
            <Pressable
              onPress={() => setTorchOn((v) => !v)}
              style={[
                styles.controlBtn,
                { backgroundColor: torchOn ? colors.primary : '#00000099' },
              ]}
              accessibilityRole="button"
              accessibilityLabel={torchOn ? 'Turn torch off' : 'Turn torch on'}
            >
              <Text allowFontScaling={false} style={[styles.controlText, { color: '#fff' }]}>
                {torchOn ? 'Light OFF' : 'Light ON'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setManualEntry((v) => !v)}
              style={[styles.controlBtn, { backgroundColor: '#00000099' }]}
              accessibilityRole="button"
              accessibilityLabel="Type barcode"
            >
              <Text allowFontScaling={false} style={[styles.controlText, { color: '#fff' }]}>
                Type barcode
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={[styles.webPlaceholder, { borderColor: colors.border }]}>
          <Text
            allowFontScaling={false}
            style={[styles.explainerBody, { color: colors.mutedForeground }]}
          >
            {isWeb
              ? "Camera scanning isn't available in the web build. Type the barcode below to look it up."
              : 'Camera is off. Type the barcode below, or open Settings to enable camera access.'}
          </Text>
          {!isWeb && permission && !permission.granted ? (
            <Pressable
              style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
              onPress={() => Linking.openSettings()}
            >
              <Text
                allowFontScaling={false}
                style={[styles.primaryBtnText, { color: colors.primaryForeground }]}
              >
                Open Settings
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {/* Manual entry */}
      {manualEntry || isWeb ? (
        <View
          style={[styles.manualBar, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <TextInput
            value={manualValue}
            onChangeText={setManualValue}
            placeholder="Type barcode or catalog #"
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="characters"
            autoCorrect={false}
            style={[styles.manualInput, { color: colors.foreground, borderColor: colors.border }]}
            onSubmitEditing={handleManualSubmit}
            returnKeyType="search"
          />
          <Pressable
            onPress={handleManualSubmit}
            style={[
              styles.primaryBtn,
              { backgroundColor: colors.primary, marginTop: 0, paddingHorizontal: 16 },
            ]}
            disabled={!manualValue.trim()}
          >
            <Text
              allowFontScaling={false}
              style={[styles.primaryBtnText, { color: colors.primaryForeground }]}
            >
              Lookup
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Toast */}
      {toast ? <Toast message={toast} type="success" /> : null}

      {/* Inline error */}
      {error ? (
        <ErrorBanner
          message={error}
          style={styles.errorBarOuter}
          onDismiss={() => setError(null)}
        />
      ) : null}

      {/* Match modal — opened when lookup returns a real part. */}
      <Modal
        visible={matchedItem !== null}
        animationType="slide"
        transparent
        onRequestClose={resetScanner}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
          onPress={resetScanner}
        >
          <Pressable
            onPress={() => undefined}
            style={[
              styles.modalSheet,
              { backgroundColor: colors.background, borderColor: colors.border },
            ]}
          >
            <View style={[styles.modalHeader, { borderColor: colors.border }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                <View style={[styles.headerAccent, { backgroundColor: colors.primary }]} />
                <Text
                  allowFontScaling={false}
                  style={[styles.modalTitle, { color: colors.foreground }]}
                >
                  Scanned Part
                </Text>
              </View>
              <Pressable
                onPress={resetScanner}
                hitSlop={10}
                style={[styles.closeBtn, { borderColor: colors.border }]}
              >
                <Text
                  allowFontScaling={false}
                  style={{ color: colors.foreground, fontFamily: 'Inter_600SemiBold' }}
                >
                  ✕ Close
                </Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ padding: 14 }}>
              {matchedItem ? (
                <ResultCard
                  result={{
                    item: matchedItem,
                    confidence: 1,
                    matchReason: 'Matched by barcode scan',
                    seriesLabel: undefined,
                    variants: [],
                  }}
                  rank={0}
                  fontScale={textFontScale}
                  onEditKeywords={isAdmin && adminToken ? setEditItem : undefined}
                />
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* No-match scan-to-link picker */}
      <Modal
        visible={pendingBarcode !== null && matchedItem === null}
        animationType="slide"
        transparent
        onRequestClose={resetScanner}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
          onPress={resetScanner}
        >
          <Pressable
            onPress={() => undefined}
            style={[
              styles.modalSheet,
              { backgroundColor: colors.background, borderColor: colors.border },
            ]}
          >
            <View style={[styles.modalHeader, { borderColor: colors.border }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                <View style={[styles.headerAccent, { backgroundColor: colors.primary }]} />
                <Text
                  allowFontScaling={false}
                  style={[styles.modalTitle, { color: colors.foreground }]}
                >
                  {pickerMode === 'menu'
                    ? "Don't recognize this barcode yet"
                    : pickerMode === 'search'
                      ? 'Search for the part'
                      : 'Take a photo of the part'}
                </Text>
              </View>
              <Pressable
                onPress={resetScanner}
                hitSlop={10}
                style={[styles.closeBtn, { borderColor: colors.border }]}
              >
                <Text
                  allowFontScaling={false}
                  style={{ color: colors.foreground, fontFamily: 'Inter_600SemiBold' }}
                >
                  ✕ Cancel
                </Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ padding: 14 }}>
              {pendingBarcode ? (
                <Text
                  allowFontScaling={false}
                  style={[styles.barcodeLabel, { color: colors.mutedForeground }]}
                >
                  Barcode: {pendingBarcode}
                </Text>
              ) : null}

              {pickerMode === 'menu' ? (
                <>
                  <Text
                    allowFontScaling={false}
                    style={[styles.helpText, { color: colors.foreground }]}
                  >
                    Pick the part this barcode belongs to. Next scan of the same barcode will jump
                    straight to that part.
                  </Text>
                  <View style={{ gap: 8, marginTop: 12 }}>
                    <Pressable
                      style={[
                        styles.modeBtn,
                        { borderColor: colors.border, backgroundColor: colors.card },
                      ]}
                      onPress={() => {
                        setPickerMode('search');
                        setSearchResults([]);
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Feather name="search" size={16} color={colors.foreground} />
                        <Text
                          allowFontScaling={false}
                          style={[styles.modeBtnText, { color: colors.foreground }]}
                        >
                          Search by catalog or keyword
                        </Text>
                      </View>
                    </Pressable>
                    <Pressable
                      style={[
                        styles.modeBtn,
                        { borderColor: colors.border, backgroundColor: colors.card },
                      ]}
                      onPress={() => {
                        setPickerMode('photo');
                        setSearchResults([]);
                        void runPhotoIdentify();
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Feather name="camera" size={16} color={colors.foreground} />
                        <Text
                          allowFontScaling={false}
                          style={[styles.modeBtnText, { color: colors.foreground }]}
                        >
                          Identify with Photo ID
                        </Text>
                      </View>
                    </Pressable>
                  </View>

                  <Text
                    allowFontScaling={false}
                    style={[styles.sectionLabel, { color: colors.mutedForeground }]}
                  >
                    OR PICK FROM RECENTLY VIEWED
                  </Text>
                  <RecentList
                    items={recentItems.length > 0 ? recentItems : (recentQuery.data?.items ?? [])}
                    onPick={handlePickPart}
                    busy={linking}
                  />
                </>
              ) : null}

              {pickerMode === 'search' ? (
                <>
                  <View style={[styles.manualBar, { padding: 0, borderWidth: 0 }]}>
                    <TextInput
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      placeholder="Catalog # or keywords"
                      placeholderTextColor={colors.mutedForeground}
                      style={[
                        styles.manualInput,
                        { color: colors.foreground, borderColor: colors.border },
                      ]}
                      onSubmitEditing={runSearch}
                      autoFocus
                    />
                    <Pressable
                      onPress={runSearch}
                      style={[
                        styles.primaryBtn,
                        { backgroundColor: colors.primary, marginTop: 0, paddingHorizontal: 16 },
                      ]}
                    >
                      <Text
                        allowFontScaling={false}
                        style={[styles.primaryBtnText, { color: colors.primaryForeground }]}
                      >
                        Search
                      </Text>
                    </Pressable>
                  </View>
                  {searchMutation.isPending ? (
                    <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />
                  ) : null}
                  <RecentList
                    items={searchResults.map((r) => r.item)}
                    onPick={handlePickPart}
                    busy={linking}
                  />
                </>
              ) : null}

              {pickerMode === 'photo' ? (
                <>
                  {identifyMutation.isPending || searchMutation.isPending ? (
                    <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />
                  ) : null}
                  <RecentList
                    items={searchResults.map((r) => r.item)}
                    onPick={handlePickPart}
                    busy={linking}
                  />
                  <Pressable
                    onPress={runPhotoIdentify}
                    style={[
                      styles.secondaryBtn,
                      {
                        borderColor: colors.border,
                        borderWidth: 1,
                        marginTop: 12,
                        padding: 10,
                        alignSelf: 'stretch',
                        alignItems: 'center',
                      },
                    ]}
                  >
                    <Text
                      allowFontScaling={false}
                      style={{ color: colors.primary, fontFamily: 'Inter_600SemiBold' }}
                    >
                      Take another photo
                    </Text>
                  </Pressable>
                </>
              ) : null}

              {pickerMode !== 'menu' ? (
                <Pressable
                  onPress={() => setPickerMode('menu')}
                  style={[styles.secondaryBtn, { marginTop: 12 }]}
                >
                  <Text
                    allowFontScaling={false}
                    style={{ color: colors.primary, fontFamily: 'Inter_500Medium' }}
                  >
                    ← Back
                  </Text>
                </Pressable>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {renderCancelButton('onCamera')}
      <RecordEditModal
        item={editItem}
        adminHeaders={adminToken ? { Authorization: `Bearer ${adminToken}` } : {}}
        onClose={() => setEditItem(null)}
        onSaved={(updated) => {
          if (matchedItem && matchedItem.id === updated.id) {
            setMatchedItem({ ...matchedItem, ...updated });
          }
          setEditItem(null);
        }}
      />
    </View>
  );
}

function RecentList({
  items,
  onPick,
  busy,
}: {
  items: InventoryItem[];
  onPick: (item: InventoryItem) => void;
  busy: boolean;
}) {
  const colors = useColors();
  if (items.length === 0) {
    return (
      <Text
        allowFontScaling={false}
        style={{ color: colors.mutedForeground, marginTop: 12, fontFamily: 'Inter_400Regular' }}
      >
        No items to show yet.
      </Text>
    );
  }
  return (
    <View style={{ marginTop: 8 }}>
      {items.map((item) => (
        <Pressable
          key={item.id}
          onPress={() => onPick(item)}
          disabled={busy}
          style={({ pressed }) => [
            styles.recentRow,
            {
              borderColor: colors.border,
              backgroundColor: pressed ? colors.accent : colors.card,
              opacity: busy ? 0.5 : 1,
            },
          ]}
        >
          <Text
            allowFontScaling={false}
            style={[styles.recentVendor, { color: colors.mutedForeground }]}
          >
            {item.vendor}
          </Text>
          <Text
            allowFontScaling={false}
            style={[styles.recentCatalog, { color: colors.foreground }]}
            numberOfLines={1}
          >
            {item.catalog}
          </Text>
          {item.description ? (
            <Text
              allowFontScaling={false}
              style={[styles.recentDesc, { color: colors.mutedForeground }]}
              numberOfLines={2}
            >
              {item.description}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cameraWrap: { flex: 1, position: 'relative' },
  reticleWrap: { position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' },
  reticle: { width: 260, height: 160, borderWidth: 3, borderRadius: 12 },
  reticleHint: {
    marginTop: 16,
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    backgroundColor: '#00000088',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
  },
  controlsRow: {
    position: 'absolute',
    bottom: 16,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
  },
  controlBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlText: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  webPlaceholder: {
    margin: 16,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
  },
  explainerCard: {
    margin: 24,
    padding: 20,
    gap: 12,
  },
  explainerTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  explainerBody: { fontSize: 14, fontFamily: 'Inter_400Regular', lineHeight: 20 },
  primaryBtn: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  primaryBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  secondaryBtn: { paddingVertical: 8, alignItems: 'center' },
  manualBar: {
    flexDirection: 'row',
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    alignItems: 'center',
  },
  manualInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: 'Inter_500Medium',
    minHeight: 44,
  },
  errorBarOuter: {
    margin: 12,
    marginBottom: 0,
  },
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  headerAccent: { width: 3, height: 18, borderRadius: 2, flexShrink: 0 },
  modalSheet: {
    maxHeight: '92%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: { fontSize: 15, fontFamily: 'Inter_700Bold', flexShrink: 1 },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  barcodeLabel: { fontFamily: 'Inter_500Medium', marginBottom: 8 },
  helpText: { fontFamily: 'Inter_400Regular', lineHeight: 20 },
  modeBtn: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
  },
  modeBtnText: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  sectionLabel: {
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 1,
    fontSize: 11,
    marginTop: 18,
    marginBottom: 6,
  },
  recentRow: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginTop: 6,
  },
  recentVendor: { fontFamily: 'Inter_500Medium', fontSize: 11, letterSpacing: 0.5 },
  recentCatalog: { fontFamily: 'Inter_700Bold', fontSize: 16, marginTop: 2 },
  recentDesc: { fontFamily: 'Inter_400Regular', fontSize: 12, marginTop: 4 },
  shutterBtn: {
    position: 'absolute',
    bottom: 92,
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#ffffff33',
    borderWidth: 3,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#fff',
  },
  cancelBtn: {
    position: 'absolute',
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    elevation: 4,
  },
  cancelBtnText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 18,
    lineHeight: 20,
  },
});
