-- Shared test-database contract for inventory chip filtering.
--
-- Drizzle schema push creates tables and indexes, but it does not manage this
-- hand-written SQL function. Keep this file as the single source used by CI
-- preparation and Jest global setup.
CREATE OR REPLACE FUNCTION public.inventory_chip_text(
  vendor text,
  catalog text,
  description text,
  ai_keywords text[]
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT concat_ws(
    ' ',
    NULLIF(vendor, ''),
    NULLIF(catalog, ''),
    NULLIF(description, ''),
    NULLIF(array_to_string(ai_keywords, ' '), '')
  );
$function$;