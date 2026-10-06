import { z } from "zod";

/**
 * View configuration (CONTRACTS §5). Stored in `data.views.config` (JSONB).
 * Field ids inside the config are public `fld_…` ids.
 */

export const VIEW_TYPES = [
  "grid",
  "form",
  "gallery",
  "kanban",
  "calendar",
  "timeline",
  "list",
  "gantt",
] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

export type FilterAstJson =
  | { kind: "and" | "or"; children: FilterAstJson[] }
  | { kind: "condition"; fieldId: string; op: string; value?: unknown };

const MAX_FILTER_DEPTH = 6;

function depthOf(node: FilterAstJson): number {
  if (node.kind === "condition") return 1;
  let d = 0;
  for (const c of node.children) d = Math.max(d, depthOf(c));
  return d + 1;
}

const filterNode: z.ZodType<FilterAstJson> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal("condition"),
      fieldId: z.string().min(1),
      op: z.string().min(1),
      value: z.unknown().optional(),
    }),
    z.object({
      kind: z.enum(["and", "or"]),
      children: z.array(filterNode).max(200),
    }),
  ]),
) as z.ZodType<FilterAstJson>;

export const filterSchema = filterNode.refine(
  (n) => depthOf(n) <= MAX_FILTER_DEPTH,
  "Filter is nested too deeply",
);

const fieldIdSchema = z.string().min(1).max(64);
const sortSchema = z.object({
  fieldId: fieldIdSchema,
  direction: z.enum(["asc", "desc"]),
});

const colorSchema = z.union([
  z.object({ mode: z.literal("none") }),
  z.object({ mode: z.literal("select"), fieldId: fieldIdSchema }),
  z.object({
    mode: z.literal("conditions"),
    rules: z
      .array(z.object({ filter: filterSchema, color: z.string().min(1).max(40) }))
      .max(50),
  }),
]);

const summarySchema = z.record(
  z.enum(["none", "count", "empty", "filled", "unique", "sum", "avg", "min", "max"]),
);

const formFieldSchema = z.object({
  fieldId: fieldIdSchema,
  required: z.boolean(),
  label: z.string().max(500).optional(),
  help: z.string().max(2000).optional(),
});

/** Partial ViewConfig accepted on write (PATCH config / POST config). */
export const viewConfigPatchSchema = z
  .object({
    filter: filterSchema.nullable(),
    sorts: z.array(sortSchema).max(20),
    groups: z.array(sortSchema).max(3),
    hiddenFieldIds: z.array(fieldIdSchema).max(1000),
    fieldOrder: z.array(fieldIdSchema).max(1000),
    fieldWidths: z.record(z.number().int().min(40).max(2000)),
    frozenFieldCount: z.number().int().min(0).max(20),
    rowHeight: z.enum(["short", "medium", "tall", "extra"]),
    color: colorSchema,
    summary: summarySchema,
    kanban: z.object({
      stackFieldId: fieldIdSchema.nullable(),
      coverFieldId: fieldIdSchema.nullable().optional(),
      hideEmptyStacks: z.boolean().optional(),
      collapsedStacks: z.array(z.string().max(64)).max(500).optional(),
      cardFieldIds: z.array(fieldIdSchema).max(100).optional(),
    }),
    calendar: z.object({
      dateFieldId: fieldIdSchema.nullable(),
      endDateFieldId: fieldIdSchema.nullable().optional(),
      mode: z.enum(["month", "week"]).optional(),
    }),
    gallery: z.object({
      coverFieldId: fieldIdSchema.nullable().optional(),
      coverFit: z.enum(["cover", "contain"]).optional(),
      cardFieldIds: z.array(fieldIdSchema).max(100).optional(),
    }),
    timeline: z.object({
      startFieldId: fieldIdSchema.nullable(),
      endFieldId: fieldIdSchema.nullable().optional(),
      scale: z.enum(["day", "week", "month"]).optional(),
    }),
    form: z.object({
      title: z.string().max(500),
      description: z.string().max(5000),
      fields: z.array(formFieldSchema).max(500),
      submitLabel: z.string().min(1).max(100),
      successMessage: z.string().max(2000),
      allowResubmit: z.boolean(),
    }),
  })
  .partial()
  .strict();

export type ViewConfigPatch = z.infer<typeof viewConfigPatchSchema>;

export interface ViewConfig {
  filter: FilterAstJson | null;
  sorts: { fieldId: string; direction: "asc" | "desc" }[];
  groups: { fieldId: string; direction: "asc" | "desc" }[];
  hiddenFieldIds: string[];
  fieldOrder: string[];
  fieldWidths: Record<string, number>;
  frozenFieldCount: number;
  rowHeight: "short" | "medium" | "tall" | "extra";
  color: NonNullable<ViewConfigPatch["color"]>;
  summary: NonNullable<ViewConfigPatch["summary"]>;
  kanban?: NonNullable<ViewConfigPatch["kanban"]>;
  calendar?: NonNullable<ViewConfigPatch["calendar"]>;
  gallery?: NonNullable<ViewConfigPatch["gallery"]>;
  timeline?: NonNullable<ViewConfigPatch["timeline"]>;
  form?: NonNullable<ViewConfigPatch["form"]>;
}

/** Minimal field info needed to compute defaults. `id` is the public `fld_` id. */
export interface ConfigFieldInfo {
  id: string;
  type: string;
  isPrimary: boolean;
}

const NON_EDITABLE_TYPES = new Set([
  "formula",
  "lookup",
  "rollup",
  "count",
  "autonumber",
  "created_time",
  "modified_time",
  "created_by",
  "modified_by",
  "button",
  "ai_generated",
]);

export function isEditableFieldType(type: string): boolean {
  return !NON_EDITABLE_TYPES.has(type);
}

function firstOf(fields: ConfigFieldInfo[], types: string[]): string | null {
  for (const t of types) {
    const f = fields.find((x) => x.type === t);
    if (f) return f.id;
  }
  return null;
}

function dateFields(fields: ConfigFieldInfo[]): ConfigFieldInfo[] {
  return fields.filter((f) => f.type === "date" || f.type === "datetime");
}

export function baseDefaults(): ViewConfig {
  return {
    filter: null,
    sorts: [],
    groups: [],
    hiddenFieldIds: [],
    fieldOrder: [],
    fieldWidths: {},
    frozenFieldCount: 1,
    rowHeight: "short",
    color: { mode: "none" },
    summary: {},
  };
}

export function typeDefaults(
  type: string,
  fields: ConfigFieldInfo[],
  tableName = "Form",
): Partial<ViewConfig> {
  switch (type) {
    case "kanban":
      return {
        kanban: {
          stackFieldId: firstOf(fields, ["single_select", "collaborator"]),
          coverFieldId: firstOf(fields, ["attachment"]),
          hideEmptyStacks: false,
          collapsedStacks: [],
        },
      };
    case "calendar":
      return {
        calendar: {
          dateFieldId: dateFields(fields)[0]?.id ?? null,
          endDateFieldId: null,
          mode: "month",
        },
      };
    case "gallery":
      return {
        gallery: { coverFieldId: firstOf(fields, ["attachment"]), coverFit: "cover" },
      };
    case "timeline":
    case "gantt": {
      const dates = dateFields(fields);
      return {
        timeline: {
          startFieldId: dates[0]?.id ?? null,
          endFieldId: dates[1]?.id ?? null,
          scale: "week",
        },
      };
    }
    case "form": {
      const editable = fields.filter((f) => isEditableFieldType(f.type));
      editable.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
      return {
        form: {
          title: tableName,
          description: "",
          fields: editable.map((f) => ({ fieldId: f.id, required: f.isPrimary })),
          submitLabel: "Submit",
          successMessage: "Thank you for submitting the form!",
          allowResubmit: true,
        },
      };
    }
    default:
      return {};
  }
}

/** Full default config for a newly created view of `type`. */
export function defaultConfigForType(
  type: string,
  fields: ConfigFieldInfo[],
  tableName?: string,
): ViewConfig {
  return { ...baseDefaults(), ...typeDefaults(type, fields, tableName) };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Normalize a stored config: migrate legacy keys, drop invalid parts, and fill
 * defaults so clients always get a complete ViewConfig.
 */
export function normalizeViewConfig(
  raw: unknown,
  type: string,
  fields: ConfigFieldInfo[],
  tableName?: string,
): ViewConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stored: any = isObj(raw) ? { ...raw } : {};

  // Legacy keys from the first implementation.
  if (stored.sorts === undefined && Array.isArray(stored.sort)) {
    stored.sorts = (stored.sort as unknown[]).filter(isObj).map((s: any) => ({
      fieldId: s.fieldId ?? s.field,
      direction: s.direction === "desc" ? "desc" : "asc",
    }));
  }
  if (stored.groups === undefined && Array.isArray(stored.group)) {
    stored.groups = (stored.group as unknown[]).filter(isObj).map((g: any) => ({
      fieldId: g.fieldId,
      direction: g.direction === "desc" ? "desc" : "asc",
    }));
  }
  if (stored.hiddenFieldIds === undefined && Array.isArray(stored.visibleFields)) {
    const visible = new Set(stored.visibleFields as string[]);
    stored.hiddenFieldIds = fields.filter((f) => !visible.has(f.id)).map((f) => f.id);
  }
  delete stored.sort;
  delete stored.group;
  delete stored.visibleFields;

  const out: ViewConfig = defaultConfigForType(type, fields, tableName);
  const shape = viewConfigPatchSchema.shape as unknown as Record<
    string,
    z.ZodTypeAny
  >;
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    const schema = shape[key];
    if (!schema) continue;
    if (
      (key === "kanban" ||
        key === "calendar" ||
        key === "gallery" ||
        key === "timeline" ||
        key === "form") &&
      isObj(value)
    ) {
      const merged = { ...((out as unknown as Record<string, unknown>)[key] as object), ...value };
      const parsed = schema.safeParse(merged);
      if (parsed.success) (out as unknown as Record<string, unknown>)[key] = parsed.data;
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) (out as unknown as Record<string, unknown>)[key] = parsed.data;
  }

  // Drop references to fields that no longer exist in form config.
  if (out.form) {
    const ids = new Set(fields.map((f) => f.id));
    out.form = { ...out.form, fields: out.form.fields.filter((f) => ids.has(f.fieldId)) };
  }
  return out;
}
