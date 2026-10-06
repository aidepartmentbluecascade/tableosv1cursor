import { request, type FilterAst, type RecordDto, type ViewDto } from "../api.ts";

/** CONTRACTS §5 */
export type RowHeight = "short" | "medium" | "tall" | "extra";
export type SortSpec = { fieldId: string; direction: "asc" | "desc" };
export type SummaryKind =
  | "none"
  | "count"
  | "empty"
  | "filled"
  | "unique"
  | "sum"
  | "avg"
  | "min"
  | "max";
export type ColorConfig =
  | { mode: "none" }
  | { mode: "select"; fieldId: string }
  | { mode: "conditions"; rules: { filter: FilterAst; color: string }[] };

export interface FormFieldConfig {
  fieldId: string;
  required: boolean;
  label?: string;
  help?: string;
}

export interface ViewConfig {
  filter: FilterAst | null;
  sorts: SortSpec[];
  groups: SortSpec[];
  hiddenFieldIds: string[];
  fieldOrder: string[];
  fieldWidths: Record<string, number>;
  frozenFieldCount: number;
  rowHeight: RowHeight;
  color: ColorConfig;
  summary: Record<string, SummaryKind>;
  kanban?: {
    stackFieldId: string | null;
    coverFieldId?: string | null;
    hideEmptyStacks?: boolean;
    collapsedStacks?: string[];
    cardFieldIds?: string[];
  };
  calendar?: { dateFieldId: string | null; endDateFieldId?: string | null; mode?: "month" | "week" };
  gallery?: { coverFieldId?: string | null; coverFit?: "cover" | "contain"; cardFieldIds?: string[] };
  timeline?: { startFieldId: string | null; endFieldId?: string | null; scale?: "day" | "week" | "month" };
  form?: {
    title: string;
    description: string;
    fields: FormFieldConfig[];
    submitLabel: string;
    successMessage: string;
    allowResubmit: boolean;
  };
}

export interface ViewWire extends ViewDto {
  tableId?: string;
  isDefault?: boolean;
  canEdit?: boolean;
  config?: ViewConfig & Record<string, unknown>;
}

export const DEFAULT_VIEW_CONFIG: ViewConfig = {
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

/** Fill defaults client-side (server already does; this guards old payloads). */
export function viewConfigOf(view: ViewDto | undefined | null): ViewConfig {
  const raw = (view?.config ?? {}) as Partial<ViewConfig>;
  return { ...DEFAULT_VIEW_CONFIG, ...raw };
}

const tablePath = (baseId: string, tableId: string) =>
  `/v1/bases/${baseId}/tables/${tableId}`;

export type ViewVisibility = "collaborative" | "personal" | "locked";

export const viewsApi = {
  list(baseId: string, tableId: string) {
    return request<{ views: ViewWire[] }>(`${tablePath(baseId, tableId)}/views`);
  },
  get(baseId: string, tableId: string, viewId: string) {
    return request<{ view: ViewWire }>(`${tablePath(baseId, tableId)}/views/${viewId}`);
  },
  create(
    baseId: string,
    tableId: string,
    body: { name: string; type: string; visibility?: ViewVisibility; config?: Partial<ViewConfig> },
  ) {
    return request<{ view: ViewWire }>(`${tablePath(baseId, tableId)}/views`, {
      method: "POST",
      json: body,
    });
  },
  patch(
    baseId: string,
    tableId: string,
    viewId: string,
    body: { name?: string; config?: Partial<ViewConfig>; visibility?: ViewVisibility },
  ) {
    return request<{ view: ViewWire }>(`${tablePath(baseId, tableId)}/views/${viewId}`, {
      method: "PATCH",
      json: body,
    });
  },
  remove(baseId: string, tableId: string, viewId: string) {
    return request<void>(`${tablePath(baseId, tableId)}/views/${viewId}`, {
      method: "DELETE",
    });
  },
  duplicate(baseId: string, tableId: string, viewId: string, name?: string) {
    return request<{ view: ViewWire }>(
      `${tablePath(baseId, tableId)}/views/${viewId}/duplicate`,
      { method: "POST", json: name ? { name } : {} },
    );
  },
  reorder(baseId: string, tableId: string, viewIds: string[]) {
    return request<void>(`${tablePath(baseId, tableId)}/views/reorder`, {
      method: "POST",
      json: { viewIds },
    });
  },
  favorite(baseId: string, tableId: string, viewId: string, on: boolean) {
    return request<{ ok: boolean; isFavorite: boolean }>(
      `${tablePath(baseId, tableId)}/views/${viewId}/favorite`,
      { method: on ? "POST" : "DELETE" },
    );
  },
};

/** Records helpers used by non-grid views (wire format CONTRACTS §3). */
export interface RecordQueryBody {
  filter?: FilterAst | null;
  sort?: { field: string; direction: "asc" | "desc" }[];
  search?: string;
  viewId?: string;
  pageSize?: number;
  cursor?: string | null;
  fields?: string[];
}

export type ViewRecord = RecordDto & {
  manualOrder?: string;
  rowNumber?: number;
  updatedAt?: string;
  fields: Record<string, unknown>;
};

export const viewRecordsApi = {
  async queryAll(baseId: string, tableId: string, body: RecordQueryBody, max = 2000) {
    const out: ViewRecord[] = [];
    let cursor: string | null | undefined = undefined;
    const clean: Record<string, unknown> = { ...body, pageSize: 500 };
    if (!body.filter) delete clean.filter;
    if (!body.search) delete clean.search;
    if (!body.sort || body.sort.length === 0) delete clean.sort;
    do {
      const page: { records: ViewRecord[]; nextCursor: string | null } = await request(
        `${tablePath(baseId, tableId)}/records/query`,
        { method: "POST", json: cursor ? { ...clean, cursor } : clean },
      );
      out.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor && out.length < max);
    return out;
  },
  async create(baseId: string, tableId: string, fields: Record<string, unknown>, typecast = true) {
    const res = await request<{ record: ViewRecord }>(`${tablePath(baseId, tableId)}/records`, {
      method: "POST",
      json: { fields, typecast },
    });
    return res.record;
  },
  async patch(
    baseId: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>,
    typecast = true,
  ) {
    const res = await request<{ record: ViewRecord }>(
      `${tablePath(baseId, tableId)}/records/${recordId}`,
      { method: "PATCH", json: { fields, typecast } },
    );
    return res.record;
  },
  async move(
    baseId: string,
    tableId: string,
    recordId: string,
    pos: { before?: string | null; after?: string | null },
  ) {
    return request<{ record: ViewRecord }>(
      `${tablePath(baseId, tableId)}/records/${recordId}/move`,
      { method: "POST", json: pos },
    );
  },
};

/** Share a form view (E's share endpoint). */
export interface ShareWire {
  id: string;
  token: string;
  targetType?: string;
  targetId?: string;
  url?: string;
  publicUrl?: string;
}

export async function createFormShare(baseId: string, viewId: string): Promise<ShareWire> {
  const res = await request<{ share: ShareWire } | ShareWire>(`/v1/bases/${baseId}/shares`, {
    method: "POST",
    json: { targetType: "form", targetId: viewId },
  });
  return "share" in res && res.share ? res.share : (res as ShareWire);
}

export function publicFormUrl(share: ShareWire): string {
  if (share.publicUrl) return share.publicUrl;
  if (share.url) return share.url;
  const host = window.location.hostname || "localhost";
  return `${window.location.protocol}//${host}:5184/s/${share.token}`;
}
