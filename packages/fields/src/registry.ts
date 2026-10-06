import { fieldDefinitions, plainText } from "./definitions.js";
import type {
  FieldConfig,
  FieldTypeDefinition,
  FieldTypeKey,
  NormalizeContext,
  NormalizeResult,
} from "./types.js";
import { FieldValidationError } from "./utils.js";

export const fieldTypeRegistry: Map<FieldTypeKey, FieldTypeDefinition> = new Map(
  fieldDefinitions.map((def) => [def.key, def]),
);

export function isFieldTypeKey(key: string): key is FieldTypeKey {
  return fieldTypeRegistry.has(key as FieldTypeKey);
}

/** Throws FieldValidationError (422) for unknown types. */
export function getFieldType(key: FieldTypeKey | string): FieldTypeDefinition {
  const def = fieldTypeRegistry.get(key as FieldTypeKey);
  if (!def) {
    throw new FieldValidationError(`Unknown field type: ${key}`);
  }
  return def;
}

/** True for types users cannot write (computed, auto values, button). */
export function isReadOnlyType(key: string): boolean {
  return fieldTypeRegistry.get(key as FieldTypeKey)?.readOnly === true;
}

export function isComputedType(key: string): boolean {
  return fieldTypeRegistry.get(key as FieldTypeKey)?.isComputed === true;
}

export function normalizeCellValue(
  type: FieldTypeKey | string,
  raw: unknown,
  config: FieldConfig,
  ctx?: NormalizeContext,
): NormalizeResult {
  return getFieldType(type).normalize(raw, config, ctx);
}

export function formatCellValue(
  type: FieldTypeKey | string,
  value: unknown,
  config: FieldConfig,
): string {
  const def = fieldTypeRegistry.get(type as FieldTypeKey);
  return def ? def.format(value, config) : plainText(value);
}

/** Types whose stored values are opaque ids that only survive conversion to the same type. */
const ID_TYPES = new Set(["collaborator", "attachment", "link", "contact"]);

/**
 * Convert a stored value of one field type to another (field type change).
 * Always typecasts; values that cannot be represented are dropped (`{}`).
 * `ctx.createOption` should be provided when converting to a select type.
 */
export function convertCellValue(
  value: unknown,
  from: { type: string; config: FieldConfig },
  to: { type: string; config: FieldConfig },
  ctx: NormalizeContext = {},
): NormalizeResult {
  if (value === undefined || value === null) return {};
  const toDef = getFieldType(to.type);
  if (toDef.readOnly) return {};
  if (ID_TYPES.has(from.type) || ID_TYPES.has(to.type)) {
    if (from.type !== to.type) {
      // ids from one domain are meaningless in another; only text-ify toward text types.
      if (ID_TYPES.has(to.type)) return {};
      if (from.type === "link" || from.type === "contact") return {};
      return {};
    }
  }

  let intermediate: unknown = value;
  const opts = Array.isArray(from.config.options) ? from.config.options : [];
  switch (from.type) {
    case "single_select":
      intermediate = opts.find((o) => o.id === value)?.label;
      break;
    case "multi_select":
      intermediate = Array.isArray(value)
        ? value.map((id) => opts.find((o) => o.id === id)?.label).filter(Boolean)
        : undefined;
      break;
    case "checkbox":
      if (to.type === "number" || to.type === "currency" || to.type === "percent" || to.type === "rating") {
        intermediate = value === true ? 1 : undefined;
      } else if (to.type !== "checkbox") {
        intermediate = value === true ? "checked" : undefined;
      }
      break;
    case "percent":
    case "currency":
    case "duration":
      if (!["number", "currency", "percent", "duration", "rating", "checkbox"].includes(to.type)) {
        intermediate = formatCellValue(from.type, value, from.config);
      }
      break;
    case "number":
    case "rating":
      if (to.type === "date" || to.type === "datetime") return {};
      break;
    case "date":
    case "datetime":
      if (["number", "currency", "percent", "duration", "rating"].includes(to.type)) return {};
      break;
    case "barcode":
      intermediate = formatCellValue("barcode", value, from.config);
      break;
    case "json":
      if (to.type !== "json") intermediate = typeof value === "string" ? value : JSON.stringify(value);
      break;
    default:
      break;
  }
  if (intermediate === undefined || intermediate === null || intermediate === "") return {};
  if (Array.isArray(intermediate) && intermediate.length === 0) return {};
  try {
    return toDef.normalize(intermediate, to.config, { ...ctx, typecast: true });
  } catch {
    return {};
  }
}
