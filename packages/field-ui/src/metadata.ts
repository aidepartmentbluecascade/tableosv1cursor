import type { FieldTypeInfo } from "./types.js";

export type EditorInputKind =
  | "text"
  | "number"
  | "checkbox"
  | "date"
  | "select"
  | "multiline";

export interface FieldEditorMeta {
  input: EditorInputKind;
  placeholder?: string;
}

const META: Record<string, FieldEditorMeta> = {
  text: { input: "text", placeholder: "Enter text…" },
  long_text: { input: "multiline", placeholder: "Enter long text…" },
  number: { input: "number" },
  currency: { input: "number" },
  percent: { input: "number" },
  duration: { input: "text", placeholder: "h:mm" },
  checkbox: { input: "checkbox" },
  date: { input: "date" },
  datetime: { input: "date" },
  single_select: { input: "select" },
  multi_select: { input: "select" },
  email: { input: "text", placeholder: "name@example.com" },
  url: { input: "text", placeholder: "https://…" },
  phone: { input: "text" },
  rating: { input: "number" },
};

/** @deprecated kept for older callers; prefer FieldValueEditor. */
export function getFieldEditorMeta(type: string): FieldEditorMeta {
  return META[type] ?? { input: "text" };
}

export const FIELD_TYPES: FieldTypeInfo[] = [
  { type: "text", label: "Single line text", icon: "A", description: "A single line of text.", group: "basic", readOnly: false },
  { type: "long_text", label: "Long text", icon: "¶", description: "Multiple lines of text, e.g. notes or descriptions.", group: "basic", readOnly: false },
  { type: "checkbox", label: "Checkbox", icon: "☑", description: "A checkbox that can be checked or unchecked.", group: "basic", readOnly: false },
  { type: "single_select", label: "Single select", icon: "◉", description: "Pick one option from a list.", group: "basic", readOnly: false },
  { type: "multi_select", label: "Multiple select", icon: "☰", description: "Pick any number of options from a list.", group: "basic", readOnly: false },
  { type: "collaborator", label: "User", icon: "☺", description: "Assign one or more collaborators of this base.", group: "basic", readOnly: false },
  { type: "date", label: "Date", icon: "▦", description: "A calendar date.", group: "basic", readOnly: false },
  { type: "datetime", label: "Date and time", icon: "◷", description: "A date with a time of day.", group: "basic", readOnly: false },
  { type: "phone", label: "Phone number", icon: "☏", description: "A telephone number.", group: "basic", readOnly: false },
  { type: "email", label: "Email", icon: "@", description: "An email address.", group: "basic", readOnly: false },
  { type: "url", label: "URL", icon: "⛓", description: "A web address.", group: "basic", readOnly: false },
  { type: "number", label: "Number", icon: "#", description: "An integer or decimal number.", group: "basic", readOnly: false },
  { type: "currency", label: "Currency", icon: "$", description: "A monetary amount with a symbol.", group: "basic", readOnly: false },
  { type: "percent", label: "Percent", icon: "%", description: "A percentage.", group: "basic", readOnly: false },
  { type: "duration", label: "Duration", icon: "⏱", description: "A length of time in hours and minutes.", group: "basic", readOnly: false },
  { type: "rating", label: "Rating", icon: "★", description: "A rating on a scale, e.g. 1–5 stars.", group: "basic", readOnly: false },
  { type: "attachment", label: "Attachment", icon: "📎", description: "Files such as images or documents.", group: "basic", readOnly: false },
  { type: "link", label: "Link to another record", icon: "⇄", description: "Link records in this table to records in another table.", group: "advanced", readOnly: false },
  { type: "barcode", label: "Barcode", icon: "▥", description: "A barcode or QR code value.", group: "advanced", readOnly: false },
  { type: "button", label: "Button", icon: "▶", description: "A button that opens a URL.", group: "advanced", readOnly: true },
  { type: "json", label: "JSON", icon: "{}", description: "Arbitrary structured JSON data.", group: "advanced", readOnly: false },
  { type: "formula", label: "Formula", icon: "ƒ", description: "Compute a value from other fields.", group: "computed", readOnly: true },
  { type: "lookup", label: "Lookup", icon: "⌕", description: "Show a field from linked records.", group: "computed", readOnly: true },
  { type: "rollup", label: "Rollup", icon: "∑", description: "Summarize a field across linked records.", group: "computed", readOnly: true },
  { type: "count", label: "Count", icon: "№", description: "Count the linked records.", group: "computed", readOnly: true },
  { type: "autonumber", label: "Autonumber", icon: "①", description: "A unique, automatically incrementing number.", group: "meta", readOnly: true },
  { type: "created_time", label: "Created time", icon: "◴", description: "When the record was created.", group: "meta", readOnly: true },
  { type: "modified_time", label: "Last modified time", icon: "◵", description: "When the record was last modified.", group: "meta", readOnly: true },
  { type: "created_by", label: "Created by", icon: "☻", description: "Who created the record.", group: "meta", readOnly: true },
  { type: "modified_by", label: "Last modified by", icon: "☻", description: "Who last modified the record.", group: "meta", readOnly: true },
];

const INFO_BY_TYPE = new Map(FIELD_TYPES.map((t) => [t.type, t]));
// Legacy alias used by older bases.
INFO_BY_TYPE.set("contact", { ...INFO_BY_TYPE.get("collaborator")!, type: "contact" });

export function fieldTypeInfo(type: string): FieldTypeInfo {
  return (
    INFO_BY_TYPE.get(type) ?? {
      type,
      label: type,
      icon: "?",
      description: "",
      group: "advanced",
      readOnly: false,
    }
  );
}

export function fieldTypeLabel(type: string): string {
  return fieldTypeInfo(type).label;
}

export function fieldTypeIcon(type: string): string {
  return fieldTypeInfo(type).icon;
}

export function fieldTypeDescription(type: string): string {
  return fieldTypeInfo(type).description;
}

const READ_ONLY = new Set(
  FIELD_TYPES.filter((t) => t.readOnly).map((t) => t.type),
);

/** True when users cannot type into cells of this type. */
export function isReadOnlyFieldType(type: string): boolean {
  return READ_ONLY.has(type);
}

/** Airtable-like option palette (background, text). */
export const OPTION_COLORS: Array<{ name: string; bg: string; fg: string }> = [
  { name: "blue", bg: "#cfdfff", fg: "#102046" },
  { name: "cyan", bg: "#d0f0fd", fg: "#04283f" },
  { name: "teal", bg: "#c2f5e9", fg: "#012524" },
  { name: "green", bg: "#d1f7c4", fg: "#0b1d05" },
  { name: "yellow", bg: "#ffeab6", fg: "#3b2501" },
  { name: "orange", bg: "#fee2d5", fg: "#6b2613" },
  { name: "red", bg: "#ffdce5", fg: "#4c0c1c" },
  { name: "pink", bg: "#ffdaf6", fg: "#400832" },
  { name: "purple", bg: "#ede2fe", fg: "#280b42" },
  { name: "gray", bg: "#eeeeee", fg: "#040404" },
];

export function optionColor(color: string | null | undefined): { bg: string; fg: string } {
  if (!color) return OPTION_COLORS[9]!;
  const named = OPTION_COLORS.find((c) => c.name === color || c.bg === color);
  if (named) return named;
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    // Arbitrary hex: use a translucent tint with dark text.
    return { bg: `${color}33`, fg: "#1e293b" };
  }
  return OPTION_COLORS[9]!;
}

export function nextOptionColor(index: number): string {
  return OPTION_COLORS[index % OPTION_COLORS.length]!.name;
}
