import type { Response } from "express";
import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

/**
 * Returns the per-request child logger set by the requestId middleware
 * (`res.locals.logger`), or falls back to the global logger when called
 * outside a request context.  Use this in route handlers so every log line
 * automatically includes the `requestId` field.
 */
export function getLogger(res: Response): typeof logger {
  return (res.locals.logger as typeof logger | undefined) ?? logger;
}

const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "CatalogAiError",
  "DatabaseError",
  "DictionaryLoadCleanupTimeoutError",
  "DictionaryLoadTimeoutError",
  "Error",
  "EvalError",
  "MalformedAiResponseError",
  "PoeBotChainExhaustedError",
  "QueryError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
]);

const SAFE_ERROR_CODES = new Set([
  "DICTIONARY_LOAD_TIMEOUT",
  "DICTIONARY_LOAD_CLEANUP_TIMEOUT",
  "ai_error",
  "ai_payload_too_large",
  "catalog_pdf_too_large",
  "catalog_pdf_too_many_pages",
  "catalog_pdf_resource_limit",
  "catalog_pdf_rollback_failed",
  "catalog_pdf_status_write_failed",
  "child_job_failed",
  "child_job_partial_failure",
  "image_upload_failed",
  "poe_chain_exhausted",
  "server_shutdown_interrupted",
  "23505",
  "23514",
]);

export type BoundedErrorDiagnostic = {
  errorName: string;
  errorCode?: string;
};

/**
 * Convert a caught error into bounded, non-request-derived diagnostics.
 *
 * Never attach the original error: database/provider messages and stacks can
 * include bound query parameters, catalog data, descriptions, or upload
 * metadata. Error codes are allowlisted because arbitrary `code` properties
 * are just as attacker-controlled as error messages.
 */
export function boundedErrorDiagnostic(error: unknown): BoundedErrorDiagnostic {
  const candidate = error as { code?: unknown; name?: unknown } | null;
  const name =
    typeof candidate?.name === "string" && SAFE_ERROR_NAMES.has(candidate.name)
      ? candidate.name
      : "UnknownError";
  const code =
    typeof candidate?.code === "string" && SAFE_ERROR_CODES.has(candidate.code)
      ? candidate.code
      : undefined;

  return {
    errorName: name,
    ...(code ? { errorCode: code } : {}),
  };
}

/**
 * Return the stable classification used by persisted job state and status
 * responses. This intentionally excludes caught-error messages and stacks.
 */
export function boundedErrorStatus(error: unknown): string {
  const diagnostic = boundedErrorDiagnostic(error);
  return diagnostic.errorCode ?? diagnostic.errorName;
}

/**
 * Normalize a previously persisted classification before returning it. Legacy
 * rows may contain raw error messages from before the bounded-status contract.
 */
export function boundedStoredErrorStatus(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return boundedErrorStatus({ code: value, name: value });
}

export type InventoryResponseDiagnostic = {
  responseFamily: "list" | "search" | "barcode";
  rowRole: "primary" | "variant" | "size-unknown";
  fields: Array<string>;
};

/**
 * Record an inventory response-boundary failure without attaching the row,
 * identifiers, or validation values to the log payload.
 */
export function logInventoryResponseSchemaFailure(
  log: Pick<typeof logger, "warn">,
  diagnostic: InventoryResponseDiagnostic,
): void {
  log.warn(
    {
      event: "inventory_response_schema_failure",
      errorCategory: "malformed_response_data",
      responseFamily: diagnostic.responseFamily,
      rowRole: diagnostic.rowRole,
      fields: diagnostic.fields,
    },
    "[inventory] response schema rejected inventory data",
  );
}
