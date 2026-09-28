const DIMENSION_FIELDS = ["length", "width", "height", "diameter"] as const;

type DimensionField = (typeof DIMENSION_FIELDS)[number];

export type DimensionTextInputs = Record<DimensionField, string>;

export type ParsedDimensionValues = Record<DimensionField, number | null>;

export type DimensionTextValidation =
  | { valid: true; value: number | null }
  | { valid: false };

export type DimensionInputsValidation =
  | { valid: true; values: ParsedDimensionValues }
  | { valid: false; invalidFields: Array<DimensionField> };

export const DIMENSION_INPUT_ERROR =
  "Enter a non-negative number up to 100,000. Values are saved to one decimal place; leave blank when unknown.";

const COMPLETE_DECIMAL = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

export function parseDimensionText(rawValue: string): DimensionTextValidation {
  const value = rawValue.trim();
  if (value === "") return { valid: true, value: null };
  if (!COMPLETE_DECIMAL.test(value)) return { valid: false };

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000) {
    return { valid: false };
  }

  return { valid: true, value: Math.round(parsed * 10) / 10 };
}

export function validateDimensionInputs(
  inputs: DimensionTextInputs,
): DimensionInputsValidation {
  const values = {} as ParsedDimensionValues;
  const invalidFields: Array<DimensionField> = [];

  for (const field of DIMENSION_FIELDS) {
    const result = parseDimensionText(inputs[field]);
    if (!result.valid) {
      invalidFields.push(field);
      values[field] = null;
    } else {
      values[field] = result.value;
    }
  }

  return invalidFields.length > 0
    ? { valid: false, invalidFields }
    : { valid: true, values };
}

export function dimensionInputsChanged(
  validation: DimensionInputsValidation,
  previous: Partial<ParsedDimensionValues> | null | undefined,
): boolean {
  if (!validation.valid) return true;
  const oldValues = previous ?? {};

  return DIMENSION_FIELDS.some(
    (field) => validation.values[field] !== (oldValues[field] ?? null),
  );
}