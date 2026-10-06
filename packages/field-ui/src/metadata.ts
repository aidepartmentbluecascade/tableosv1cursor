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

export function getFieldEditorMeta(type: string): FieldEditorMeta {
  return META[type] ?? { input: "text" };
}
