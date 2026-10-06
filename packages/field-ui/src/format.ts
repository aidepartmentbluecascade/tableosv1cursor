import type { CellValue, FieldConfig, FieldTypeKey } from "@tabula/fields";
import { getFieldType } from "@tabula/fields";

export function formatCellDisplay(
  type: string,
  value: CellValue | null | undefined,
  config: FieldConfig = {},
): string {
  if (value === null || value === undefined) return "";
  const def = getFieldType(type as FieldTypeKey);
  if (def) {
    try {
      return def.format(value, config);
    } catch {
      /* fall through */
    }
  }
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
