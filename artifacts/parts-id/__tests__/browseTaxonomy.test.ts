/**
 * @jest-environment node
 *
 * Drill-down state-machine tests for BrowseTaxonomy. We exercise the pure
 * helpers (`nodeAtPath`, `visibleChildren`) directly so we don't need a
 * React Native renderer or AsyncStorage shim.
 */
import { nodeAtPath, visibleChildren, type CategoryTreeNode } from '../lib/taxonomy';

const TREE: CategoryTreeNode[] = [
  {
    id: 1,
    slug: 'breakers',
    name: 'Breakers',
    level: 'category',
    sortOrder: 0,
    itemCount: 100,
    children: [
      {
        id: 11,
        slug: 'breakers-by-type',
        name: 'By Type',
        level: 'subcategory',
        sortOrder: 0,
        itemCount: 100,
        children: [
          {
            id: 101,
            slug: 'breaker-standard',
            name: 'Standard',
            level: 'type',
            sortOrder: 0,
            itemCount: 80,
            children: [],
          },
          {
            id: 102,
            slug: 'breaker-gfci',
            name: 'GFCI',
            level: 'type',
            sortOrder: 1,
            itemCount: 20,
            children: [],
          },
        ],
      },
    ],
  },
  {
    id: 2,
    slug: 'wire-cable',
    name: 'Wire & Cable',
    level: 'category',
    sortOrder: 1,
    itemCount: 50,
    children: [],
  },
];

describe('BrowseTaxonomy helpers', () => {
  it('nodeAtPath returns null for empty path', () => {
    expect(nodeAtPath(TREE, [])).toBeNull();
  });

  it('nodeAtPath returns the matching root', () => {
    const n = nodeAtPath(TREE, ['breakers']);
    expect(n?.slug).toBe('breakers');
    expect(n?.level).toBe('category');
  });

  it('nodeAtPath drills two levels deep', () => {
    const n = nodeAtPath(TREE, ['breakers', 'breakers-by-type']);
    expect(n?.slug).toBe('breakers-by-type');
    expect(n?.level).toBe('subcategory');
  });

  it('nodeAtPath drills three levels to a leaf type', () => {
    const n = nodeAtPath(TREE, ['breakers', 'breakers-by-type', 'breaker-gfci']);
    expect(n?.slug).toBe('breaker-gfci');
    expect(n?.itemCount).toBe(20);
  });

  it('nodeAtPath returns null for a bogus slug', () => {
    expect(nodeAtPath(TREE, ['does-not-exist'])).toBeNull();
    expect(nodeAtPath(TREE, ['breakers', 'wrong-sub'])).toBeNull();
  });

  it('visibleChildren returns roots when path is empty', () => {
    const c = visibleChildren(TREE, []);
    expect(c.map((n) => n.slug)).toEqual(['breakers', 'wire-cable']);
  });

  it('visibleChildren returns subcategories at depth 1', () => {
    const c = visibleChildren(TREE, ['breakers']);
    expect(c).toHaveLength(1);
    expect(c[0]!.slug).toBe('breakers-by-type');
  });

  it('visibleChildren returns leaf types at depth 2', () => {
    const c = visibleChildren(TREE, ['breakers', 'breakers-by-type']);
    expect(c.map((n) => n.slug)).toEqual(['breaker-standard', 'breaker-gfci']);
  });

  it('visibleChildren returns [] at a leaf node', () => {
    const c = visibleChildren(TREE, ['breakers', 'breakers-by-type', 'breaker-gfci']);
    expect(c).toEqual([]);
  });

  it('visibleChildren returns [] when path is broken', () => {
    expect(visibleChildren(TREE, ['nope'])).toEqual([]);
  });

  // Search↔Browse toggle + first drill-down: simulates the user flow on
  // the Search screen — flip to Browse, drill into a category, then a
  // subcategory, then pick a leaf type, then flip back to Search.
  it('supports a Search→Browse→drill→Search round-trip', () => {
    type Mode = 'search' | 'browse';
    let mode: Mode = 'search';
    let path: string[] = [];
    const setMode = (m: Mode) => {
      mode = m;
    };
    const drill = (slug: string) => {
      path = [...path, slug];
    };
    const popTo = (depth: number) => {
      path = path.slice(0, depth);
    };

    expect(mode).toBe('search');
    setMode('browse');
    expect(mode).toBe('browse');
    expect(visibleChildren(TREE, path).map((n) => n.slug)).toEqual(['breakers', 'wire-cable']);

    drill('breakers');
    expect(nodeAtPath(TREE, path)?.level).toBe('category');
    expect(visibleChildren(TREE, path)[0]!.slug).toBe('breakers-by-type');

    drill('breakers-by-type');
    expect(visibleChildren(TREE, path).map((n) => n.slug)).toEqual([
      'breaker-standard',
      'breaker-gfci',
    ]);

    drill('breaker-gfci');
    const leaf = nodeAtPath(TREE, path);
    expect(leaf?.level).toBe('type');
    expect(leaf?.itemCount).toBe(20);

    popTo(1);
    expect(path).toEqual(['breakers']);
    setMode('search');
    expect(mode).toBe('search');
  });
});
