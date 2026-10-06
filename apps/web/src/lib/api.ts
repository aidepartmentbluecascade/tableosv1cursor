import type { TabulaError } from "@tabula/types";
import type { FieldConfig } from "@tabula/fields";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

export class ApiProblemError extends Error {
  readonly problem: TabulaError;

  constructor(problem: TabulaError) {
    super(problem.detail ?? problem.title);
    this.name = "ApiProblemError";
    this.problem = problem;
  }
}

async function parseProblem(response: Response): Promise<TabulaError> {
  const contentType = response.headers.get("content-type") ?? "";
  if (
    contentType.includes("application/problem+json") ||
    contentType.includes("application/json")
  ) {
    try {
      return (await response.json()) as TabulaError;
    } catch {
      /* fall through */
    }
  }
  const detail = await response.text().catch(() => "");
  const problem: TabulaError = {
    code: "VALIDATION_FAILED",
    title: response.statusText || "Request failed",
    status: response.status,
  };
  if (detail) {
    problem.detail = detail;
  }
  return problem;
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown; clientOpId?: string },
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.clientOpId) {
    headers.set("X-Tabula-Client-Op-Id", init.clientOpId);
  }
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }

  const fetchInit: RequestInit = { headers, credentials: "include" };
  if (init?.method) fetchInit.method = init.method;
  if (body !== undefined) fetchInit.body = body;
  if (init?.signal) fetchInit.signal = init.signal;
  void init?.clientOpId;
  const response = await fetch(`${API_BASE}${path}`, fetchInit);

  if (!response.ok) {
    throw new ApiProblemError(await parseProblem(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface BaseSummary {
  id: string;
  name: string;
}

export interface FieldDto {
  id: string;
  name: string;
  type: string;
  config: FieldConfig;
  slot: number;
}

export interface ViewDto {
  id: string;
  name: string;
  type?: string;
  visibility?: "collaborative" | "personal" | "locked";
  ownerUserId?: string | null;
  createdBy?: string | null;
  isFavorite?: boolean;
  isMine?: boolean;
  config?: Record<string, unknown>;
}

export interface AutomationDto {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { type: string; config?: Record<string, unknown> };
  actions: Array<Record<string, unknown>>;
  createdAt?: string;
  updatedAt?: string;
}

export interface TableDto {
  id: string;
  name: string;
  primaryFieldId: string;
  fields: FieldDto[];
  views: ViewDto[];
}

export interface BaseDetail {
  id: string;
  name: string;
  tables: TableDto[];
}

export interface RecordDto {
  id: string;
  version: number;
  createdAt: string;
  fields: Record<string, string | number | boolean | string[] | null>;
}

export interface RecordsQueryResponse {
  records: RecordDto[];
  nextCursor: string | null;
}

export interface WsTicketResponse {
  ticket: string;
  expiresAt?: string;
  url?: string;
}

export type FilterAst =
  | { kind: "and"; children: FilterNode[] }
  | { kind: "or"; children: FilterNode[] }
  | {
      kind: "condition";
      fieldId: string;
      op: string;
      value?: unknown;
    };

export type FilterNode = FilterAst;

export const api = {
  async signup(body: { email: string; password: string; name: string }) {
    const res = await request<{ user: AuthUser }>("/v1/auth/signup", {
      method: "POST",
      json: body,
    });
    return res.user;
  },

  async login(body: { email: string; password: string }) {
    const res = await request<{ user: AuthUser }>("/v1/auth/login", {
      method: "POST",
      json: body,
    });
    return res.user;
  },

  async me() {
    const res = await request<{ user: AuthUser }>("/v1/auth/me");
    return res.user;
  },

  workspaces() {
    return request<{ workspaces: Workspace[] }>("/v1/workspaces");
  },

  workspaceBases(workspaceId: string) {
    return request<{ bases: BaseSummary[] }>(
      `/v1/workspaces/${workspaceId}/bases`,
    );
  },

  createBase(workspaceId: string, name: string) {
    return request<BaseSummary>(`/v1/workspaces/${workspaceId}/bases`, {
      method: "POST",
      json: { name },
    });
  },

  getBase(baseId: string) {
    return request<BaseDetail>(`/v1/bases/${baseId}`);
  },

  createTable(baseId: string, name: string) {
    return request<{ table: { id: string; name: string } }>(
      `/v1/bases/${baseId}/tables`,
      { method: "POST", json: { name } },
    );
  },

  listViews(baseId: string, tableId: string) {
    return request<{ views: ViewDto[] }>(
      `/v1/bases/${baseId}/tables/${tableId}/views`,
    );
  },

  createView(
    baseId: string,
    tableId: string,
    body: {
      name: string;
      type?: string;
      visibility?: "collaborative" | "personal" | "locked";
      config?: Record<string, unknown>;
    },
  ) {
    return request<{ view: ViewDto }>(
      `/v1/bases/${baseId}/tables/${tableId}/views`,
      { method: "POST", json: body },
    );
  },

  favoriteView(baseId: string, tableId: string, viewId: string) {
    return request<{ ok: boolean; isFavorite: boolean }>(
      `/v1/bases/${baseId}/tables/${tableId}/views/${viewId}/favorite`,
      { method: "POST" },
    );
  },

  unfavoriteView(baseId: string, tableId: string, viewId: string) {
    return request<{ ok: boolean; isFavorite: boolean }>(
      `/v1/bases/${baseId}/tables/${tableId}/views/${viewId}/favorite`,
      { method: "DELETE" },
    );
  },

  listAutomations(baseId: string) {
    return request<{
      automations: AutomationDto[];
      limits: { maxAutomations: number; remaining: number };
    }>(`/v1/bases/${baseId}/automations`);
  },

  createAutomation(
    baseId: string,
    body: {
      name?: string;
      trigger?: { type: string; config?: Record<string, unknown> };
      enabled?: boolean;
    } = {},
  ) {
    return request<{ automation: AutomationDto }>(
      `/v1/bases/${baseId}/automations`,
      { method: "POST", json: body },
    );
  },

  patchAutomation(
    baseId: string,
    automationId: string,
    body: Partial<{
      name: string;
      enabled: boolean;
      trigger: { type: string; config?: Record<string, unknown> };
      actions: Array<Record<string, unknown>>;
    }>,
  ) {
    return request<{ ok: boolean }>(
      `/v1/bases/${baseId}/automations/${automationId}`,
      { method: "PATCH", json: body },
    );
  },

  queryRecords(
    baseId: string,
    tableId: string,
    body: {
      pageSize?: number;
      cursor?: string | null;
      fields?: string[];
      filter?: FilterAst;
      sort?: Array<{ field: string; direction: "asc" | "desc" }>;
    } = {},
  ) {
    return request<RecordsQueryResponse>(
      `/v1/bases/${baseId}/tables/${tableId}/records/query`,
      { method: "POST", json: body },
    );
  },

  wsTicket() {
    return request<WsTicketResponse>("/v1/auth/ws-ticket", { method: "POST" });
  },

  undoBase(baseId: string, body: { changeId?: string } = {}) {
    return request<{ changeSeq: number; undoneSeq?: number }>(
      `/v1/bases/${baseId}/undo`,
      { method: "POST", json: body },
    );
  },

  async createRecord(
    baseId: string,
    tableId: string,
    fields: Record<string, unknown>,
  ) {
    const res = await request<{ record: RecordDto } | RecordDto>(
      `/v1/bases/${baseId}/tables/${tableId}/records`,
      { method: "POST", json: { fields } },
    );
    return "record" in res && res.record ? res.record : (res as RecordDto);
  },

  async patchRecord(
    baseId: string,
    tableId: string,
    recordId: string,
    body: { version: number; fields: Record<string, unknown> },
    clientOpId?: string,
  ) {
    const patchInit: RequestInit & { json?: unknown; clientOpId?: string } = {
      method: "PATCH",
      json: body,
      headers: { "If-Match": `"${body.version}"` },
    };
    if (clientOpId) patchInit.clientOpId = clientOpId;
    const res = await request<{ record: RecordDto } | RecordDto>(
      `/v1/bases/${baseId}/tables/${tableId}/records/${recordId}`,
      patchInit,
    );
    return "record" in res && res.record ? res.record : (res as RecordDto);
  },

  async createField(
    baseId: string,
    tableId: string,
    body: { name: string; type: string; config?: Record<string, unknown> },
  ) {
    const res = await request<{ field: FieldDto } | FieldDto>(
      `/v1/bases/${baseId}/tables/${tableId}/fields`,
      { method: "POST", json: body },
    );
    if ("field" in res && res.field) {
      return {
        ...res.field,
        config: (res.field.config ?? {}) as FieldConfig,
      };
    }
    return res as FieldDto;
  },

  createShare(
    baseId: string,
    tableId: string,
    body: { viewId?: string; kind?: "table" | "form" } = {},
  ) {
    return request<{
      token: string;
      kind: "table" | "form";
      publicPath: string;
    }>(`/v1/bases/${baseId}/tables/${tableId}/shares`, {
      method: "POST",
      json: body,
    });
  },

  listComments(baseId: string, tableId: string, recordId: string) {
    return request<{ comments: CommentDto[] }>(
      `/v1/bases/${baseId}/tables/${tableId}/records/${recordId}/comments`,
    );
  },

  addComment(
    baseId: string,
    tableId: string,
    recordId: string,
    body: string,
  ) {
    return request<{ comment: CommentDto }>(
      `/v1/bases/${baseId}/tables/${tableId}/records/${recordId}/comments`,
      { method: "POST", json: { body } },
    );
  },

  listAttachments(baseId: string, tableId: string, recordId: string) {
    return request<{ attachments: AttachmentDto[] }>(
      `/v1/bases/${baseId}/tables/${tableId}/records/${recordId}/attachments`,
    );
  },

  presignAttachment(
    baseId: string,
    tableId: string,
    recordId: string,
    body: { fileName: string; contentType: string; size: number },
  ) {
    return request<PresignResponse>(
      `/v1/bases/${baseId}/tables/${tableId}/records/${recordId}/attachments/presign`,
      { method: "POST", json: body },
    );
  },

  async uploadPresigned(
    presign: PresignResponse,
    file: File,
  ): Promise<void> {
    const headers = new Headers(presign.headers ?? {});
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", file.type || "application/octet-stream");
    }
    const response = await fetch(`${API_BASE}${presign.uploadUrl}`, {
      method: presign.method ?? "PUT",
      headers,
      body: file,
    });
    if (!response.ok) {
      throw new Error("Upload failed");
    }
  },

  completeAttachment(
    baseId: string,
    tableId: string,
    recordId: string,
    body: { uploadId: string; fileName: string; size: number },
  ) {
    return request<{ attachment: AttachmentDto }>(
      `/v1/bases/${baseId}/tables/${tableId}/records/${recordId}/attachments/complete`,
      { method: "POST", json: body },
    );
  },

  importCsv(
    baseId: string,
    tableId: string,
    body: { csv: string; hasHeader?: boolean },
  ) {
    return request<ImportResult>(
      `/v1/bases/${baseId}/tables/${tableId}/import`,
      { method: "POST", json: body },
    );
  },

  search(q: string) {
    const params = new URLSearchParams({ q });
    return request<{ results: SearchResult[] }>(`/v1/search?${params}`);
  },

  notifications() {
    return request<{ notifications: NotificationDto[]; unreadCount: number }>(
      "/v1/notifications",
    );
  },

  markNotificationRead(notificationId: string) {
    return request<void>(`/v1/notifications/${notificationId}/read`, {
      method: "POST",
    });
  },

  workspaceContacts(workspaceId: string) {
    return request<{ contacts: ContactDto[] }>(
      `/v1/workspaces/${workspaceId}/contacts`,
    );
  },
};

export interface CommentDto {
  id: string;
  recordId: string;
  body: string;
  authorName: string;
  createdAt: string;
}

export interface AttachmentDto {
  id: string;
  recordId: string;
  fileName: string;
  size: number;
  url: string;
  createdAt: string;
}

export interface PresignResponse {
  uploadId: string;
  uploadUrl: string;
  method?: string;
  headers?: Record<string, string>;
  fileName: string;
  size: number;
}

export interface ImportResult {
  jobId: string;
  status: string;
  imported: number;
  errors: unknown[];
}

export interface SearchResult {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  href?: string;
}

export interface NotificationDto {
  id: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface ContactDto {
  id: string;
  workspaceId: string;
  name: string;
  email: string | null;
}
