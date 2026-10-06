export type FieldTypeKey =
  | "text"
  | "long_text"
  | "number"
  | "currency"
  | "percent"
  | "checkbox"
  | "date"
  | "datetime"
  | "single_select"
  | "multi_select"
  | "email"
  | "url"
  | "phone"
  | "rating"
  | "link"
  | "contact"
  | "formula"
  | "lookup"
  | "rollup"
  | "count"
  | "autonumber"
  | "created_time"
  | "modified_time"
  | "created_by"
  | "modified_by";

export type CellValue = string | number | boolean | string[];

export type CellsRecord = Record<string, CellValue>;

export interface FieldConfig {
  options?: Array<{ id: string; label: string; color?: string }>;
  precision?: number;
  currencyCode?: string;
  max?: number;
  richText?: boolean;
  [key: string]: unknown;
}

export interface NormalizeResult {
  /** Undefined means omit key (empty). */
  value?: CellValue;
}

export interface FieldTypeDefinition {
  key: FieldTypeKey;
  /** Stored in data.fields.is_computed when true. */
  isComputed?: boolean;
  validate(raw: unknown, config: FieldConfig): void;
  normalize(raw: unknown, config: FieldConfig): NormalizeResult;
  format(value: CellValue | undefined, config: FieldConfig): string;
}
