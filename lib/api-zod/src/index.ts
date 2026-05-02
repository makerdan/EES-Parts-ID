// Re-export the Zod runtime schemas only. The orval-generated `./generated/types`
// folder mirrors many of these as plain TypeScript interfaces with the same
// names (e.g. `AiReferenceBody`, `SearchInventoryResponse`), which makes
// `export *` ambiguous under composite project references. Consumers that
// need the TypeScript interface form import them from `@workspace/api-client-react`
// instead, which has its own non-conflicting copy.
export * from "./generated/api";
