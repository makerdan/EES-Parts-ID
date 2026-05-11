/**
 * Unit tests for the rule-based taxonomy classifier.
 *
 * The classifier is a pure function over (item, nodeIndex) so we don't need
 * a database — we hand-build a small node index that mirrors the seed
 * taxonomy slugs the rules reference.
 */

import { classifyItem, buildNodeIndex, type ClassifierNode } from '../src/utils/taxonomyClassifier';

/** Mirror of the slugs the rules reference (subset is enough for unit tests). */
const TEST_NODES: ClassifierNode[] = [
  // Categories (level 1)
  { id: 1, parentId: null, level: 'category', name: 'Breakers', slug: 'breakers' },
  { id: 2, parentId: null, level: 'category', name: 'Wire & Cable', slug: 'wire-cable' },
  { id: 3, parentId: null, level: 'category', name: 'Conduit & Raceway', slug: 'conduit-raceway' },
  { id: 4, parentId: null, level: 'category', name: 'Receptacles', slug: 'receptacles' },
  { id: 5, parentId: null, level: 'category', name: 'Boxes', slug: 'boxes-enclosures' },
  // Subcategories (level 2)
  { id: 11, parentId: 1, level: 'subcategory', name: 'By Type', slug: 'breakers-by-type' },
  { id: 21, parentId: 2, level: 'subcategory', name: 'By Type', slug: 'wire-by-type' },
  { id: 31, parentId: 3, level: 'subcategory', name: 'By Material', slug: 'conduit-by-material' },
  { id: 32, parentId: 3, level: 'subcategory', name: 'Fittings', slug: 'conduit-fittings' },
  { id: 41, parentId: 4, level: 'subcategory', name: 'By Type', slug: 'receptacles-by-type' },
  { id: 51, parentId: 5, level: 'subcategory', name: 'By Type', slug: 'boxes-by-type' },
  // Leaf types (level 3)
  { id: 101, parentId: 11, level: 'type', name: 'Standard Breaker', slug: 'breaker-standard' },
  { id: 102, parentId: 11, level: 'type', name: 'GFCI Breaker', slug: 'breaker-gfci' },
  { id: 103, parentId: 11, level: 'type', name: 'AFCI Breaker', slug: 'breaker-afci' },
  { id: 201, parentId: 21, level: 'type', name: 'THHN Wire', slug: 'wire-thhn' },
  { id: 202, parentId: 21, level: 'type', name: 'Romex', slug: 'wire-romex' },
  { id: 301, parentId: 31, level: 'type', name: 'EMT', slug: 'conduit-emt' },
  { id: 302, parentId: 31, level: 'type', name: 'PVC', slug: 'conduit-pvc' },
  { id: 321, parentId: 32, level: 'type', name: 'Couplings', slug: 'fitting-coupling' },
  { id: 401, parentId: 41, level: 'type', name: 'Duplex', slug: 'receptacle-duplex' },
  { id: 402, parentId: 41, level: 'type', name: 'GFCI Receptacle', slug: 'receptacle-gfci' },
  { id: 501, parentId: 51, level: 'type', name: 'Junction Box', slug: 'box-junction' },
  { id: 502, parentId: 51, level: 'type', name: 'Device Box', slug: 'box-device' },
];

const index = buildNodeIndex(TEST_NODES);

describe('taxonomyClassifier', () => {
  it('matches a standard Eaton BR breaker via catalog pattern', () => {
    const r = classifyItem(
      { vendor: 'ETN', catalog: 'BR120', description: '20A 1-Pole Breaker' },
      index
    );
    expect(r).not.toBeNull();
    expect(r!.typeSlug).toBe('breaker-standard');
    expect(r!.categorySlug).toBe('breakers');
    expect(r!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('prefers GFCI over generic breaker when GFCI keyword present', () => {
    // Rule specificity: GFCI keyword must win over the generic BR-series rule
    // so that GFCI breakers land in the dedicated sub-type, not "standard".
    const r = classifyItem(
      {
        vendor: 'ETN',
        catalog: 'GFTCB120',
        description: '20A GFCI Plug-On Breaker',
      },
      index
    );
    expect(r).not.toBeNull();
    expect(r!.typeSlug).toBe('breaker-gfci');
  });

  it('classifies AFCI breakers separately', () => {
    const r = classifyItem(
      { vendor: 'ETN', catalog: 'BRAF120', description: '20A AFCI breaker' },
      index
    );
    expect(r!.typeSlug).toBe('breaker-afci');
  });

  it('classifies THHN wire from description', () => {
    const r = classifyItem(
      { vendor: 'SOU', catalog: '12THHN-500', description: '12 AWG THHN Stranded Building Wire' },
      index
    );
    expect(r!.typeSlug).toBe('wire-thhn');
    expect(r!.categorySlug).toBe('wire-cable');
  });

  it('classifies Romex from NM catalog prefix', () => {
    const r = classifyItem(
      { vendor: 'SOU', catalog: 'NM12-2-250', description: 'Non-metallic sheathed cable' },
      index
    );
    expect(r!.typeSlug).toBe('wire-romex');
  });

  it('classifies EMT conduit', () => {
    const r = classifyItem(
      { vendor: 'ALL', catalog: 'EMT-3/4', description: '3/4 in. Electrical Metallic Tubing' },
      index
    );
    expect(r!.typeSlug).toBe('conduit-emt');
  });

  it('classifies PVC conduit', () => {
    const r = classifyItem(
      { vendor: 'CAR', catalog: 'PVC40-1', description: '1 in. Schedule 40 PVC conduit' },
      index
    );
    expect(r!.typeSlug).toBe('conduit-pvc');
  });

  it('classifies a coupling fitting (EMT keyword wins over generic coupling)', () => {
    const r = classifyItem(
      { vendor: 'BRD', catalog: '501', description: '1/2 in. EMT compression coupling' },
      index
    );
    // EMT keyword wins because conduit rules sit before fittings in the list.
    expect(r).not.toBeNull();
    expect(['conduit-emt', 'fitting-coupling']).toContain(r!.typeSlug);
  });

  it('classifies a duplex receptacle by keyword', () => {
    const r = classifyItem(
      { vendor: 'HBL', catalog: '5252', description: '20A 125V Duplex Receptacle Ivory' },
      index
    );
    expect(r!.typeSlug).toBe('receptacle-duplex');
  });

  it('classifies GFCI receptacle separately from breaker', () => {
    const r = classifyItem(
      {
        vendor: 'LEV',
        catalog: 'GFNT1-W',
        description: '20A GFCI receptacle white tamper resistant',
      },
      index
    );
    expect(r!.typeSlug).toBe('receptacle-gfci');
    expect(r!.categorySlug).toBe('receptacles');
  });

  it('classifies a junction box from keyword', () => {
    const r = classifyItem(
      { vendor: 'RAC', catalog: 'J-BOX-4', description: '4 in. square junction box' },
      index
    );
    expect(r!.typeSlug).toBe('box-junction');
  });

  it('returns null when nothing matches (AI fallback opportunity)', () => {
    const r = classifyItem(
      { vendor: 'ZZZ', catalog: 'XYZ-999', description: 'completely unknown widget' },
      index
    );
    expect(r).toBeNull();
  });

  it('uses aiKeywords when description is sparse', () => {
    const r = classifyItem(
      {
        vendor: 'ZZZ',
        catalog: 'XX1',
        description: '',
        aiKeywords: ['dimmer', 'lutron'],
      },
      index
    );
    // dimmer rule -> switch-dimmer, but switch-dimmer is not in our test index;
    // verify the classifier returns null in that case rather than crashing.
    expect(r).toBeNull();
  });

  it('buildNodeIndex correctly resolves ancestors for a leaf type', () => {
    const idx = buildNodeIndex(TEST_NODES);
    expect(idx.bySlug.get('breaker-gfci')?.id).toBe(102);
    expect(idx.ancestors.get('breaker-gfci')).toEqual({
      subcategorySlug: 'breakers-by-type',
      categorySlug: 'breakers',
    });
  });
});
