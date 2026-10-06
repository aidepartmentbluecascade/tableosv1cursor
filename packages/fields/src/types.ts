export type FieldTypeKey =
  | "text"
  | "long_text"
  | "number"
  | "currency"
  | "percent"
  | "duration"
  | "checkbox"
  | "date"
  | "datetime"
  | "single_select"
  | "multi_select"
  | "email"
  | "url"
  | "phone"
  | "rating"
  | "collaborator"
  | "attachment"
  | "barcode"
  | "button"
  | "json"
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
  | "modified_by"
  | "ai_generated";

/** Legacy narrow cell value type (kept for UI consumers). */
export type CellValue = string | number | boolean | string[];

export type CellsRecord = Record<string, CellValue>;

/** Any JSON value as stored in `records.cells` / `records.computed`. */
export type StoredValue =
  | string
  | number
  | boolean
  | null
  | StoredValue[]
  | { [key: string]: StoredValue };

export interface SelectOption {
  id: string;
  label: string;
  color: string;
}

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
  value?: StoredValue;
}

export interface NormalizeContext {
  /** When true, coerce loosely (labels → options, create missing options, parse strings). */
  typecast?: boolean;
  /**
   * Called (typecast only) when a select label does not match an existing
   * option. Must return the id of the newly created option.
   */
  createOption?: (label: string) => string;
}

export interface FieldTypeDefinition {
  key: FieldTypeKey;
  /** Human label (e.g. "Single line text"). */
  label: string;
  /** Stored in data.fields.is_computed when true. */
  isComputed?: boolean;
  /** Users cannot write values (computed, auto values, buttons). */
  readOnly?: boolean;
  /** False when the type exists in the DB enum but cannot be created yet. */
  creatable?: boolean;
  /** Default config for a new field of this type. */
  defaultConfig(): FieldConfig;
  /** Validate + fill defaults. Throws FieldValidationError. */
  normalizeConfig(input: Record<string, unknown>): FieldConfig;
  /** Throws FieldValidationError when `raw` is not acceptable. */
  validate(raw: unknown, config: FieldConfig, ctx?: NormalizeContext): void;
  /** Validate + coerce into the stored representation. */
  normalize(raw: unknown, config: FieldConfig, ctx?: NormalizeContext): NormalizeResult;
  /** Plain-text rendering of a stored value. */
  format(value: unknown, config: FieldConfig): string;
}
