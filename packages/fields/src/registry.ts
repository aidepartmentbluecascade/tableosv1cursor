import { fieldDefinitions } from "./definitions.js";
import type { FieldTypeDefinition, FieldTypeKey } from "./types.js";

export const fieldTypeRegistry: Map<FieldTypeKey, FieldTypeDefinition> = new Map(
  fieldDefinitions.map((def) => [def.key, def]),
);

export function getFieldType(key: FieldTypeKey): FieldTypeDefinition {
  const def = fieldTypeRegistry.get(key);
  if (!def) {
    throw new Error(`Unknown field type: ${key}`);
  }
  return def;
}
