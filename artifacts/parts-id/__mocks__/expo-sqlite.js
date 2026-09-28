// SQLite's native module is unavailable in Jest. Tests that exercise the
// offline store replace this mock with their own transactional fixture.
const state = { meta: null, items: new Map(), terms: new Map(), barcodes: new Map() };
exports.__state = state;
exports.__reset = () => {
  state.meta = null;
  state.items.clear();
  state.terms.clear();
  state.barcodes.clear();
};
const key = (g, id) => `${g}:${id}`;
const db = {
  async execAsync() {},
  async runAsync(sql, ...args) {
    if (sql.startsWith("DELETE FROM offline_items")) {
      for (const [k, v] of state.items) if (args.length === 1 ? v.generation === args[0] || (sql.includes("WHERE id") && v.id === args[0]) : false) state.items.delete(k);
    } else if (sql.startsWith("DELETE FROM offline_terms")) {
      for (const [k, v] of state.terms) if (sql.includes("WHERE id") ? v.id === args[0] : v.generation === args[0] && (args.length === 1 || v.id === args[1])) state.terms.delete(k);
    } else if (sql.startsWith("DELETE FROM offline_barcodes")) {
      for (const [k, v] of state.barcodes) if (sql.includes("WHERE id") ? v.id === args[0] : v.generation === args[0] && (args.length === 1 || v.id === args[1])) state.barcodes.delete(k);
    } else if (sql.startsWith("INSERT OR REPLACE INTO offline_items")) {
      state.items.set(key(args[0], args[1]), { generation: args[0], id: args[1], json: args[2] });
    } else if (sql.startsWith("INSERT INTO offline_terms")) {
      state.terms.set(key(args[0], args[1]), { generation: args[0], id: args[1], terms: args[2] });
    } else if (sql.startsWith("INSERT INTO offline_barcodes")) {
      state.barcodes.set(`${args[0]}:${args[1]}:${args[2]}`, { generation: args[0], code: args[1], id: args[2] });
    } else if (sql.startsWith("INSERT OR REPLACE INTO offline_meta")) {
      state.meta = { generation: args[0], synced_at: args[1], count: args[2] };
    } else if (sql.startsWith("UPDATE offline_meta") && state.meta) {
      state.meta.count = [...state.items.values()].filter(v => v.generation === state.meta.generation).length;
    }
  },
  async getFirstAsync(sql, ...args) {
    if (sql.includes("FROM offline_meta WHERE")) return state.meta;
    if (sql.includes("COUNT(*)")) return { count: [...state.items.values()].filter(v => v.generation === args[0]).length };
    if (sql.includes("AS used")) {
      const rows = [...state.items.values()].filter(v => v.generation === args[1]);
      return { used: rows.reduce((sum, v) => sum + Buffer.byteLength(v.json), 0),
        previous: rows.filter(v => v.id === args[0]).reduce((sum, v) => sum + Buffer.byteLength(v.json), 0) };
    }
    if (sql.includes("FROM offline_meta m JOIN offline_barcodes")) {
      const hit = [...state.barcodes.values()].find(v => v.generation === state.meta?.generation && v.code === args[0]);
      return hit ? state.items.get(key(hit.generation, hit.id)) : null;
    }
    if (sql.includes("JOIN offline_meta m")) return state.items.get(key(state.meta?.generation, args[0])) ?? null;
    return null;
  },
  async getAllAsync(sql, generation, query) {
    if (sql.includes("ORDER BY i.id")) {
      return [...state.items.values()].filter(v => v.generation === state.meta?.generation && v.id > generation)
        .sort((a, b) => a.id - b.id).slice(0, 200);
    }
    const tokens = query.toLowerCase().match(/"([^"]+)"/g)?.map(t => t.slice(1, -1)) ?? [];
    const phrase = tokens.length === 1 && tokens[0].includes(" ");
    return [...state.terms.values()].filter(v => v.generation === generation && (phrase
      ? v.terms.toLowerCase().replace(/-/g, " ").includes(tokens[0])
      : tokens.some(t => v.terms.toLowerCase().includes(t))))
      .slice(0, 200).map(v => state.items.get(key(v.generation, v.id)));
  },
  async withExclusiveTransactionAsync(fn) {
    const before = structuredClone({ meta: state.meta, items: state.items, terms: state.terms, barcodes: state.barcodes });
    try { return await fn(db); }
    catch (err) {
      state.meta = before.meta;
      for (const field of ["items", "terms", "barcodes"]) {
        state[field].clear();
        for (const [k, v] of before[field]) state[field].set(k, v);
      }
      throw err;
    }
  },
};
exports.openDatabaseAsync = async () => db;