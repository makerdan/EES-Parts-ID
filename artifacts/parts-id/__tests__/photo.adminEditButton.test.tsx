/**
 * @jest-environment jsdom
 *
 * Renders the actual Photo tab screen (app/(tabs)/photo.tsx) and verifies
 * that ResultCard receives `onEditKeywords` as a function when adminToken is
 * present in AppContext, and `undefined` when it is not.
 *
 * Flow simulated:
 *   1. Press "Pick from photo library" (accessibilityLabel) → mocked
 *      ImagePicker resolves with a fake image → `images` state populated.
 *   2. Press "Identify Part" text button → mocked `mutateAsync` resolves with
 *      results containing one item → `setResults([...])` called.
 *   3. ResultCard spy renders → assert `data-has-edit` attribute.
 */
/* eslint-disable react/display-name, import/first */
import React from 'react';

// ── Mutable per-test admin flag ────────────────────────────────────────────────
let mockAdminToken: string | null = 'admin-tok';

// ── Mocks whose inner fns must start with 'mock' to bypass hoisting ───────────
const mockIdentifyMutateAsync = jest.fn();
const mockSearchMutateAsync = jest.fn();

// ── react-native mock ──────────────────────────────────────────────────────────
jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react') as typeof import('react');

  function flatStyle(style: unknown): object | undefined {
    if (!style) return undefined;
    if (Array.isArray(style))
      return Object.assign({}, ...(style as unknown[]).filter(Boolean).map(flatStyle));
    if (typeof style === 'function') return undefined;
    return style as object;
  }

  function makeHost(tag: string) {
    return React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
      const {
        children,
        style,
        accessibilityLabel,
        accessibilityRole,
        accessibilityState,
        onPress: _op,
        numberOfLines: _nl,
        ellipsizeMode: _em,
        allowFontScaling: _afs,
        hitSlop: _hs,
        horizontal: _h,
        showsHorizontalScrollIndicator: _shi,
        showsVerticalScrollIndicator: _svi,
        contentContainerStyle: _ccs,
        scrollEventThrottle: _set,
        onScroll: _os,
        android_ripple: _ar,
        ...rest
      } = props;
      const a11y: Record<string, unknown> = {};
      if (accessibilityLabel != null) a11y['aria-label'] = accessibilityLabel;
      if (accessibilityRole != null) a11y['role'] = accessibilityRole;
      if (accessibilityState && (accessibilityState as { selected?: boolean }).selected != null) {
        a11y['aria-selected'] = (accessibilityState as { selected?: boolean }).selected;
      }
      return React.createElement(
        tag,
        { ref, style: flatStyle(style), ...a11y, ...rest },
        children as React.ReactNode
      );
    });
  }

  const View = makeHost('div');
  const Text = makeHost('span');

  const ScrollView = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    const innerRef = React.useRef<unknown>(null);
    React.useImperativeHandle(ref, () => ({ scrollTo: () => {}, scrollToOffset: () => {} }), []);
    const Host = makeHost('div');
    return React.createElement(Host, { ...props, ref: innerRef });
  });

  const Pressable = React.forwardRef(
    (
      {
        onPress,
        children,
        accessibilityLabel,
        accessibilityRole,
        accessibilityState,
        style,
        hitSlop: _hs,
        android_ripple: _ar,
        disabled: _d,
        ...rest
      }: Record<string, unknown>,
      ref: React.Ref<unknown>
    ) => {
      const resolvedStyle =
        typeof style === 'function'
          ? flatStyle((style as (s: { pressed: boolean }) => unknown)({ pressed: false }))
          : flatStyle(style);
      return React.createElement(
        'div',
        {
          ref,
          role: (accessibilityRole as string) ?? 'button',
          'aria-label': accessibilityLabel,
          onClick: onPress,
          style: resolvedStyle,
          ...(accessibilityState &&
          typeof accessibilityState === 'object' &&
          'selected' in (accessibilityState as object)
            ? { 'aria-selected': (accessibilityState as { selected: boolean }).selected }
            : {}),
          ...rest,
        },
        typeof children === 'function'
          ? (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false })
          : (children as React.ReactNode)
      );
    }
  );
  Pressable.displayName = 'Pressable';

  const Modal = ({
    visible,
    children,
  }: {
    visible: boolean;
    children: React.ReactNode;
    animationType?: string;
    transparent?: boolean;
    onRequestClose?: () => void;
  }) => (visible ? React.createElement('div', { role: 'dialog' }, children) : null);
  Modal.displayName = 'Modal';

  const StyleSheet = {
    create: <T extends object>(obj: T): T => obj,
    flatten: flatStyle,
    hairlineWidth: 1,
    absoluteFill: {},
  };

  const ActivityIndicator = makeHost('div');

  return {
    View,
    Text,
    ScrollView,
    TextInput: makeHost('input'),
    Pressable,
    Modal,
    StyleSheet,
    ActivityIndicator,
    Image: makeHost('img'),
    SafeAreaView: makeHost('div'),
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o['web'] ?? o['default'] },
    Linking: { openURL: jest.fn() },
    Keyboard: { dismiss: jest.fn() },
  };
});

// ── Dependency mocks ───────────────────────────────────────────────────────────

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    multiGet: jest.fn(async () => []),
    multiRemove: jest.fn(async () => undefined),
  },
}));

jest.mock('@/hooks/useColors', () => ({
  useColors: () => ({
    border: '#ccc',
    card: '#fff',
    background: '#fff',
    foreground: '#000',
    muted: '#f4f4f5',
    mutedForeground: '#666',
    primary: '#2563eb',
    primaryForeground: '#fff',
    accent: '#f4f4f5',
    accentForeground: '#000',
    success: '#10b981',
    warning: '#f59e0b',
    destructive: '#dc2626',
    overlay: '#00000088',
  }),
}));

jest.mock('@/contexts/AppContext', () => ({
  useApp: () => ({ adminToken: mockAdminToken, textFontScale: 1 }),
}));

jest.mock('@workspace/api-client-react', () => ({
  useAiIdentifyPart: () => ({
    mutateAsync: (...args: unknown[]) => mockIdentifyMutateAsync(...args),
    isPending: false,
    isError: false,
    isSuccess: false,
    reset: jest.fn(),
  }),
  useSearchInventory: () => ({
    mutateAsync: (...args: unknown[]) => mockSearchMutateAsync(...args),
    isPending: false,
    isError: false,
    isSuccess: false,
    reset: jest.fn(),
  }),
  useConfirmPhotoId: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(async () => ({
    canceled: false,
    assets: [{ uri: 'file://test-photo.jpg', base64: 'dGVzdA==' }],
  })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true })),
  requestCameraPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  MediaTypeOptions: { Images: 'Images' },
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

jest.mock('@/utils/resizeImage', () => ({
  resizeImage: jest.fn(async (uri: string, base64: string) => ({ uri, base64 })),
}));

jest.mock('@/lib/updateFuseCache', () => ({
  updateFuseCache: jest.fn(async () => undefined),
}));

jest.mock('@expo/vector-icons', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function IconStub({ name }: { name: string }) {
    return R.createElement('span', {}, name);
  }
  return { MaterialCommunityIcons: IconStub, Feather: IconStub };
});

// ResultCard spy — exposes onEditKeywords wiring via a data attribute so
// the test does not need to expand the card to see the edit button.
jest.mock('@/components/ResultCard', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function ResultCardSpy({ onEditKeywords }: { onEditKeywords?: unknown }) {
    return R.createElement('div', {
      'data-testid': 'result-card',
      'data-has-edit': onEditKeywords ? 'true' : 'false',
    });
  }
  return { ResultCard: ResultCardSpy };
});

jest.mock('@/components/ReferenceModal', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function Stub() {
    return R.createElement('div', { 'data-testid': 'ref-modal' });
  }
  return { ReferenceModal: Stub };
});

jest.mock('@/components/RecordEditModal', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');
  function Stub() {
    return R.createElement('div', { 'data-testid': 'record-edit-modal' });
  }
  return { RecordEditModal: Stub };
});

jest.mock('@/styles/shared', () => ({ secondaryBtnBase: {} }));

// ── Imports after mocks ────────────────────────────────────────────────────────

import { act, fireEvent, render, screen } from '@testing-library/react';
import PhotoScreen from '../app/(tabs)/photo';

// ── Mock identify result ───────────────────────────────────────────────────────

const MOCK_IDENTIFY_RESULT = {
  results: [
    {
      item: {
        id: 1,
        vendor: 'ETN',
        catalog: 'BR120',
        description: '20A Breaker',
        binLocations: ['A-1'],
        aiKeywords: ['breaker'],
        vendorFullName: null,
        enrichedAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        seriesName: null,
        tradeSize: null,
      },
      confidence: 0.95,
      matchReason: 'ai',
      seriesLabel: undefined,
      variants: [],
    },
  ],
  summary: 'Circuit breaker',
  searchTerms: ['breaker'],
  synonyms: [],
  _telemetry: null,
};

// ── Helper ─────────────────────────────────────────────────────────────────────

/**
 * Render PhotoScreen, pick a library photo, press "Identify Part", and wait
 * for the async identify → setResults chain to complete.
 */
async function renderAndIdentify() {
  render(<PhotoScreen />);

  // Pick an image from the library so images.length > 0
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /pick from photo library/i }));
    await new Promise((r) => setTimeout(r, 0));
  });

  // Press "Identify Part" to trigger handleIdentify
  await act(async () => {
    fireEvent.click(screen.getByText('Identify Part'));
    await new Promise((r) => setTimeout(r, 0));
  });

  // Flush remaining microtasks from the async identify chain
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Photo tab (photo.tsx) — Edit Part Details button correlates with adminToken', () => {
  beforeEach(() => {
    mockIdentifyMutateAsync.mockResolvedValue(MOCK_IDENTIFY_RESULT);
    mockSearchMutateAsync.mockResolvedValue({ results: [] });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('ResultCard receives onEditKeywords when adminToken is set (admin)', async () => {
    mockAdminToken = 'admin-secret';
    await renderAndIdentify();
    const card = screen.getByTestId('result-card');
    expect(card.getAttribute('data-has-edit')).toBe('true');
  });

  it('ResultCard receives undefined onEditKeywords when adminToken is null (non-admin)', async () => {
    mockAdminToken = null;
    await renderAndIdentify();
    const card = screen.getByTestId('result-card');
    expect(card.getAttribute('data-has-edit')).toBe('false');
  });
});
