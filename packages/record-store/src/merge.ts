import type { CellValue } from "@tabula/fields";
import type { FieldId, RecordId, TabulaRecord } from "./types.js";

export function mergeFieldValues(
  cells: Record<FieldId, CellValue | null>,
  computed?: Record<FieldId, CellValue | null>,
): Record<FieldId, CellValue | null> {
  const out: Record<FieldId, CellValue | null> = { ...cells };
  if (computed) {
    for (const [fieldId, value] of Object.entries(computed)) {
      out[fieldId] = value;
    }
  }
  return out;
}

export function upsertRecordFromDto(
  map: Map<RecordId, TabulaRecord>,
  dto: {
    id: RecordId;
    version: number;
    fields: Record<string, CellValue | null | undefined>;
  },
): TabulaRecord {
  const fields: Record<FieldId, CellValue | null> = {};
  for (const [fieldId, value] of Object.entries(dto.fields)) {
    fields[fieldId] = value === undefined ? null : value;
  }
  const existing = map.get(dto.id);
  const next: TabulaRecord = {
    id: dto.id,
    version: dto.version,
    fields: existing ? { ...existing.fields, ...fields } : fields,
  };
  map.set(dto.id, next);
  return next;
}

export function getMergedFieldValue(
  record: TabulaRecord,
  fieldId: FieldId,
): CellValue | null {
  const v = record.fields[fieldId];
  return v === undefined ? null : v;
}
