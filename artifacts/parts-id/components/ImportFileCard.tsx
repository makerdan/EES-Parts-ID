/**
 * ImportFileCard
 *
 * Encapsulates the "Import File" card shown on the Upload tab. Handles:
 *   - File picker (CSV / XLSX / ODS / plain text)
 *   - Collapsible paste area for copying rows directly from a spreadsheet
 *   - Selected-file chip with a dismiss button
 *   - CSV export: fetches GET /inventory/export (admin-only) and shares the
 *     resulting file via the native share sheet.
 *
 * The `binLocations` column is included in both directions:
 *   • Import — the parent's CSV/XLSX parser recognises "bin", "binLocation",
 *     "binLocations", etc. and populates ParsedRow.binLocations.
 *   • Export — the export endpoint serialises each part's stored bin array as
 *     a "; "-separated string in the binLocations column, which the importer
 *     can re-parse on the next round-trip.
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useColors } from '@/hooks/useColors';
import { secondaryBtnBase } from '@/styles/shared';

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : '';

export type ParsedRow = {
  vendor: string;
  catalog: string;
  description: string;
  binLocations: string[];
};

type Props = {
  parsedRows: ParsedRow[];
  fileName: string | null;
  fileType: 'csv' | 'xlsx' | null;
  uploadPending: boolean;
  chunkProgress: { processed: number; total: number } | null;
  adminHeaders: Record<string, string>;
  colors: ReturnType<typeof useColors>;
  pasteInputText: string;
  onPickFile: () => void;
  onPasteInputChange: (text: string) => void;
  onParsePastedText: (text: string) => void;
  onClearFile: () => void;
};

export function ImportFileCard({
  fileName,
  fileType,
  uploadPending,
  chunkProgress,
  adminHeaders,
  colors,
  pasteInputText,
  onPickFile,
  onPasteInputChange,
  onParsePastedText,
  onClearFile,
}: Props) {
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);

  const handleExport = async () => {
    setExportPending(true);
    setExportError(null);
    try {
      const res = await fetch(`${API_BASE}/inventory/export`, {
        headers: adminHeaders,
      });

      if (res.status === 401) {
        setExportError('Admin session expired. Please unlock again.');
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setExportError(body.error ?? 'Export failed — please try again.');
        return;
      }

      const csv = await res.text();

      await Share.share({ message: csv, title: 'inventory.csv' });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed — please try again.');
    } finally {
      setExportPending(false);
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.cardTitle, { color: colors.foreground }]}>Import File</Text>
      <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
        CSV · Excel (.xlsx/.xls) · ODS · pasted tab/comma data{'\n'}
        Required columns: vendor, catalog{'\n'}
        Optional: description, bin (or binLocation)
      </Text>

      {/* ── Two import action buttons ───────────────────────────────────── */}
      <View style={styles.importBtnRow}>
        <Pressable onPress={onPickFile} style={[styles.importBtn, { borderColor: colors.primary }]}>
          <Text style={[styles.importBtnText, { color: colors.primary }]}>Choose File</Text>
        </Pressable>

        <Pressable
          onPress={() => setPasteOpen((prev) => !prev)}
          style={[
            styles.importBtn,
            {
              borderColor: pasteOpen ? colors.primary : colors.border,
              backgroundColor: pasteOpen ? colors.primary + '18' : 'transparent',
            },
          ]}
        >
          <Text
            style={[
              styles.importBtnText,
              { color: pasteOpen ? colors.primary : colors.foreground },
            ]}
          >
            Paste Data
          </Text>
        </Pressable>
      </View>

      {/* ── Collapsible paste area ──────────────────────────────────────── */}
      {pasteOpen ? (
        <>
          <TextInput
            value={pasteInputText}
            onChangeText={onPasteInputChange}
            placeholder="Paste spreadsheet rows here…"
            placeholderTextColor={colors.mutedForeground}
            multiline
            numberOfLines={3}
            style={[
              styles.pasteInput,
              {
                backgroundColor: colors.muted,
                borderColor: colors.border,
                color: colors.foreground,
              },
            ]}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {pasteInputText.trim().length > 0 ? (
            <Pressable
              onPress={() => {
                onParsePastedText(pasteInputText);
                setPasteOpen(false);
              }}
              style={[styles.pasteParseBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.pasteParseBtnText, { color: colors.primaryForeground }]}>
                Import Pasted Data
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      {fileName ? (
        <View style={[styles.fileChip, { backgroundColor: colors.muted }]}>
          <Text style={[styles.fileChipText, { color: colors.foreground }]} numberOfLines={1}>
            {fileType === 'xlsx' ? '📊' : '📄'} {fileName}
          </Text>
          {!uploadPending && !chunkProgress ? (
            <Pressable
              onPress={onClearFile}
              hitSlop={8}
              style={styles.fileChipDismiss}
              accessibilityLabel="Clear selected file"
            >
              <Text style={[styles.fileChipDismissText, { color: colors.mutedForeground }]}>×</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <View style={[styles.divider, { borderTopColor: colors.border }]} />

      <Text style={[styles.cardTitle, { color: colors.foreground }]}>Export Inventory</Text>
      <Text style={[styles.cardHint, { color: colors.mutedForeground }]}>
        Downloads the full inventory as a CSV — includes vendor, catalog, description, and all bin
        locations. Re-importing the file merges bin assignments back without removing existing data.
      </Text>

      {exportError ? (
        <Text style={[styles.exportError, { color: colors.destructive }]}>{exportError}</Text>
      ) : null}

      <Pressable
        onPress={() => {
          void handleExport();
        }}
        disabled={exportPending}
        style={[
          secondaryBtnBase,
          styles.exportBtn,
          {
            borderColor: exportPending ? colors.border : colors.primary,
            opacity: exportPending ? 0.6 : 1,
          },
        ]}
      >
        {exportPending ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Text style={[styles.exportBtnText, { color: colors.primary }]}>Export as CSV</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    marginBottom: 14,
    gap: 10,
  },
  cardTitle: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  cardHint: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 19 },
  importBtnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  importBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  importBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  pasteInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    minHeight: 72,
    textAlignVertical: 'top',
  },
  pasteParseBtn: {
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: 'center',
  },
  pasteParseBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  fileChipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  fileChipDismiss: { marginLeft: 8, padding: 2 },
  fileChipDismissText: {
    fontSize: 18,
    lineHeight: 20,
    fontFamily: 'Inter_500Medium',
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, marginVertical: 4 },
  exportBtn: {
    paddingVertical: 11,
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1.5,
  },
  exportBtnText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  exportError: { fontSize: 13, fontFamily: 'Inter_500Medium' },
});
