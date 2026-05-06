/**
 * Single re-export point for the Drizzle schema. Consumers (`@workspace/db`,
 * api-server routes, seeds) only need to import from here.
 */
export * from "./inventory";
export * from "./enrichment_history";
export * from "./abbreviation_map";
export * from "./vendor_map";
export * from "./synonym_map";
export * from "./misspelling_map";
export * from "./electrical_slang_map";
export * from "./conversations";
export * from "./messages";
export * from "./category_node";
export * from "./inventory_category";
export * from "./inventory_barcode";
export * from "./search_telemetry";
export * from "./synonym_group";
export * from "./photo_id_event";
