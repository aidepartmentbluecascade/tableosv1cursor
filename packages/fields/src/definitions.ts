import type { FieldConfig, FieldTypeDefinition, NormalizeResult } from "./types.js";
import { fieldValidationError, isEmptyRaw } from "./utils.js";

function absent(): NormalizeResult {
  return {};
}

function asString(raw: unknown, maxLen: number, label: string): string {
  if (typeof raw !== "string") {
    fieldValidationError(`${label} must be a string`);
  }
  if (raw.length > maxLen) {
    fieldValidationError(`${label} exceeds max length ${maxLen}`);
  }
  return raw;
}

const text: FieldTypeDefinition = {
  key: "text",
  validate(raw, _config) {
    if (isEmptyRaw(raw)) return;
    asString(raw, 10_000, "Text");
  },
  normalize(raw, _config) {
    if (isEmptyRaw(raw)) return absent();
    const s = asString(raw, 10_000, "Text").trim();
    return s ? { value: s } : absent();
  },
  format(value) {
    return value === undefined ? "" : String(value);
  },
};

const longText: FieldTypeDefinition = {
  key: "long_text",
  validate(raw, config) {
    if (isEmptyRaw(raw)) return;
    if (config.richText && typeof raw === "object" && raw !== null) return;
    asString(raw, 100_000, "Long text");
  },
  normalize(raw, config) {
    if (isEmptyRaw(raw)) return absent();
    if (config.richText && typeof raw === "object" && raw !== null) {
      return { value: raw as unknown as string };
    }
    const s = asString(raw, 100_000, "Long text");
    return s.trim() ? { value: s } : absent();
  },
  format(value) {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  },
};

const number: FieldTypeDefinition = {
  key: "number",
  validate(raw, config) {
    if (isEmptyRaw(raw)) return;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      fieldValidationError("Number must be a finite number");
    }
    const p = config.precision ?? 8;
    if (p >= 0 && !Number.isInteger(raw * 10 ** p)) {
      fieldValidationError(`Number exceeds precision ${p}`);
    }
  },
  normalize(raw, config) {
    if (isEmptyRaw(raw)) return absent();
    number.validate(raw, config);
    return { value: raw as number };
  },
  format(value, config) {
    if (value === undefined) return "";
    const p = config.precision ?? undefined;
    return p !== undefined ? (value as number).toFixed(p) : String(value);
  },
};

const currency: FieldTypeDefinition = {
  key: "currency",
  validate(raw, _config) {
    if (isEmptyRaw(raw)) return;
    if (typeof raw !== "string" || !/^-?\d+(\.\d+)?$/.test(raw)) {
      fieldValidationError("Currency must be a decimal string");
    }
  },
  normalize(raw, _config) {
    if (isEmptyRaw(raw)) return absent();
    currency.validate(raw, _config);
    return { value: raw as string };
  },
  format(value, config) {
    if (value === undefined) return "";
    const code = config.currencyCode ?? "USD";
    return `${code} ${value}`;
  },
};

const percent: FieldTypeDefinition = {
  key: "percent",
  validate(raw, _config) {
    if (isEmptyRaw(raw)) return;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      fieldValidationError("Percent must be a number");
    }
  },
  normalize(raw, _config) {
    if (isEmptyRaw(raw)) return absent();
    percent.validate(raw, _config);
    return { value: raw as number };
  },
  format(value) {
    if (value === undefined) return "";
    return `${((value as number) * 100).toFixed(2)}%`;
  },
};

const checkbox: FieldTypeDefinition = {
  key: "checkbox",
  validate(raw, _config) {
    if (isEmptyRaw(raw)) return;
    if (raw !== true) fieldValidationError("Checkbox must be true or absent");
  },
  normalize(raw, _config) {
    return raw === true ? { value: true } : absent();
  },
  format(value) {
    return value === true ? "Yes" : "No";
  },
};

const date: FieldTypeDefinition = {
  key: "date",
  validate(raw, _config) {
    if (isEmptyRaw(raw)) return;
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      fieldValidationError("Date must be YYYY-MM-DD");
    }
  },
  normalize(raw, _config) {
    if (isEmptyRaw(raw)) return absent();
    date.validate(raw, _config);
    return { value: raw as string };
  },
  format(value) {
    return value === undefined ? "" : String(value);
  },
};

const datetime: FieldTypeDefinition = {
  key: "datetime",
  validate(raw, _config) {
    if (isEmptyRaw(raw)) return;
    if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
      fieldValidationError("Datetime must be ISO-8601");
    }
  },
  normalize(raw, _config) {
    if (isEmptyRaw(raw)) return absent();
    datetime.validate(raw, _config);
    return { value: new Date(raw as string).toISOString() };
  },
  format(value) {
    return value === undefined ? "" : String(value);
  },
};

function optionIds(config: FieldConfig): Set<string> {
  return new Set((config.options ?? []).map((o) => o.id));
}

const singleSelect: FieldTypeDefinition = {
  key: "single_select",
  validate(raw, config) {
    if (isEmptyRaw(raw)) return;
    const id = asString(raw, 64, "Select option");
    if (!optionIds(config).has(id)) {
      fieldValidationError("Unknown select option");
    }
  },
  normalize(raw, config) {
    if (isEmptyRaw(raw)) return absent();
    singleSelect.validate(raw, config);
    return { value: raw as string };
  },
  format(value, config) {
    if (value === undefined) return "";
    const opt = config.options?.find((o) => o.id === value);
    return opt?.label ?? String(value);
  },
};

const multiSelect: FieldTypeDefinition = {
  key: "multi_select",
  validate(raw, config) {
    if (isEmptyRaw(raw)) return;
    if (!Array.isArray(raw)) fieldValidationError("Multi-select must be an array");
    const ids = optionIds(config);
    for (const item of raw) {
      const id = asString(item, 64, "Select option");
      if (!ids.has(id)) fieldValidationError("Unknown select option");
    }
  },
  normalize(raw, config) {
    if (isEmptyRaw(raw)) return absent();
    if (Array.isArray(raw) && raw.length === 0) return absent();
    multiSelect.validate(raw, config);
    return { value: [...new Set(raw as string[])] };
  },
  format(value, config) {
    if (!Array.isArray(value) || value.length === 0) return "";
    return value
      .map((id) => config.options?.find((o) => o.id === id)?.label ?? id)
      .join(", ");
  },
};

const email: FieldTypeDefinition = {
  key: "email",
  validate(raw, _config) {
    if (isEmptyRaw(raw)) return;
    const s = asString(raw, 320, "Email");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
      fieldValidationError("Invalid email");
    }
  },
  normalize(raw, _config) {
    if (isEmptyRaw(raw)) return absent();
    email.validate(raw, _config);
    return { value: (raw as string).trim().toLowerCase() };
  },
  format(value) {
    return value === undefined ? "" : String(value);
  },
};

const url: FieldTypeDefinition = {
  key: "url",
  validate(raw, _config) {
    if (isEmptyRaw(raw)) return;
    const s = asString(raw, 2048, "URL");
    try {
      new URL(s);
    } catch {
      fieldValidationError("Invalid URL");
    }
  },
  normalize(raw, _config) {
    if (isEmptyRaw(raw)) return absent();
    url.validate(raw, _config);
    return { value: (raw as string).trim() };
  },
  format(value) {
    return value === undefined ? "" : String(value);
  },
};

const phone: FieldTypeDefinition = {
  key: "phone",
  validate(raw, _config) {
    if (isEmptyRaw(raw)) return;
    asString(raw, 32, "Phone");
  },
  normalize(raw, _config) {
    if (isEmptyRaw(raw)) return absent();
    const digits = asString(raw, 32, "Phone").replace(/\D/g, "");
    return digits ? { value: digits } : absent();
  },
  format(value) {
    return value === undefined ? "" : String(value);
  },
};

const rating: FieldTypeDefinition = {
  key: "rating",
  validate(raw, config) {
    if (isEmptyRaw(raw)) return;
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      fieldValidationError("Rating must be an integer");
    }
    const max = config.max ?? 5;
    if (raw < 1 || raw > max) {
      fieldValidationError(`Rating must be between 1 and ${max}`);
    }
  },
  normalize(raw, config) {
    if (isEmptyRaw(raw)) return absent();
    rating.validate(raw, config);
    return { value: raw as number };
  },
  format(value) {
    return value === undefined ? "" : "★".repeat(value as number);
  },
};

function requireUuid(config: FieldConfig, key: string, label: string): string {
  const v = config[key];
  if (typeof v !== "string" || v.length < 8) {
    fieldValidationError(`${label} must be a field/table id`);
  }
  return v as string;
}

const linkRecordIds: FieldTypeDefinition = {
  key: "link",
  validate(raw, config) {
    requireUuid(config, "linkedTableId", "linkedTableId");
    if (isEmptyRaw(raw)) return;
    if (!Array.isArray(raw)) fieldValidationError("Link must be an array of record ids");
    for (const item of raw) {
      asString(item, 64, "Linked record id");
    }
  },
  normalize(raw, config) {
    linkRecordIds.validate(raw, config);
    if (isEmptyRaw(raw) || (Array.isArray(raw) && raw.length === 0)) return absent();
    return { value: [...new Set(raw as string[])] };
  },
  format(value) {
    if (!Array.isArray(value) || value.length === 0) return "";
    return value.join(", ");
  },
};

const contact: FieldTypeDefinition = {
  ...linkRecordIds,
  key: "contact",
  validate(raw, config) {
    requireUuid(config, "linkedTableId", "linkedTableId");
    linkRecordIds.validate(raw, config);
  },
};

const formula: FieldTypeDefinition = {
  key: "formula",
  isComputed: true,
  validate(_raw, config) {
    const expr = config["expression"] ?? config["formula"];
    if (typeof expr !== "string" || expr.trim().length === 0) {
      fieldValidationError("Formula expression is required");
    }
  },
  normalize() {
    return absent();
  },
  format(value) {
    return value === undefined ? "" : String(value);
  },
};

const lookup: FieldTypeDefinition = {
  key: "lookup",
  isComputed: true,
  validate(_raw, config) {
    requireUuid(config, "linkFieldId", "linkFieldId");
    requireUuid(config, "lookupFieldId", "lookupFieldId");
  },
  normalize() {
    return absent();
  },
  format(value) {
    if (Array.isArray(value)) return value.map(String).join(", ");
    return value === undefined ? "" : String(value);
  },
};

const rollup: FieldTypeDefinition = {
  key: "rollup",
  isComputed: true,
  validate(_raw, config) {
    requireUuid(config, "linkFieldId", "linkFieldId");
    requireUuid(config, "rollupFieldId", "rollupFieldId");
    const agg = config["aggregation"] ?? config["function"];
    if (typeof agg !== "string" || !["sum", "average", "min", "max", "count"].includes(agg)) {
      fieldValidationError("Rollup aggregation must be sum|average|min|max|count");
    }
  },
  normalize() {
    return absent();
  },
  format(value) {
    return value === undefined ? "" : String(value);
  },
};

const count: FieldTypeDefinition = {
  key: "count",
  isComputed: true,
  validate(_raw, config) {
    requireUuid(config, "linkFieldId", "linkFieldId");
  },
  normalize() {
    return absent();
  },
  format(value) {
    return value === undefined ? "" : String(value);
  },
};

const readOnlyMeta = (key: FieldTypeDefinition["key"]): FieldTypeDefinition => ({
  key,
  validate() {},
  normalize(raw, _config) {
    if (isEmptyRaw(raw)) return absent();
    return { value: raw as string | number };
  },
  format(value) {
    return value === undefined ? "" : String(value);
  },
});

export const fieldDefinitions: FieldTypeDefinition[] = [
  text,
  longText,
  number,
  currency,
  percent,
  checkbox,
  date,
  datetime,
  singleSelect,
  multiSelect,
  email,
  url,
  phone,
  rating,
  linkRecordIds,
  contact,
  formula,
  lookup,
  rollup,
  count,
  readOnlyMeta("autonumber"),
  readOnlyMeta("created_time"),
  readOnlyMeta("modified_time"),
  readOnlyMeta("created_by"),
  readOnlyMeta("modified_by"),
];
