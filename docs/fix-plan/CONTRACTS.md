# Fix pass — shared contracts and working rules

Seven workstreams (A–G) run **in parallel in the same working tree**. This file is the source of truth for anything that crosses a workstream boundary. If you need to change a contract here, keep the change backward compatible and note it at the bottom under "Contract changes".

Audit reports that motivated this pass live in `docs/fix-plan/audit-*.md`.

---

## 1. Working rules (every workstream)

1. **Only edit files you own** (ownership table in §9). If you must touch a file owned by someone else, keep the edit tiny, re-read the file immediately before editing, and touch only the region named in §9 "shared regions".
2. **Packages are consumed from `dist/`.** After changing `packages/<name>/src`, run `npx pnpm@9.15.0 --filter @tabula/<name> build`. Never run the root `pnpm build`/`pnpm typecheck` (other workstreams are mid-edit).
3. Typecheck only what you touch:
   - server: `npx tsc -p apps/server/tsconfig.json --noEmit`
   - web: `npx tsc -p apps/web/tsconfig.app.json --noEmit`
   - public: `npx tsc -p apps/public/tsconfig.app.json --noEmit`
   - a package: `npx tsc -p packages/<name>/tsconfig.json --noEmit`
   Errors in files you don't own may be another workstream mid-edit: ignore those, never "fix" them.
4. **Running stack (already up, hot-reloading; do not start/stop servers):**
   API `http://localhost:3100` · realtime `ws://localhost:3102` · web `http://localhost:5183` (proxies `/v1` and `/ws`) · public `http://localhost:5184`.
   DB: `postgres://tabula:tabula@localhost:5432/tabula_cc` (docker container `docker-postgres-1`, `docker exec docker-postgres-1 psql -U tabula -d tabula_cc`). Redis DB 1.
   Apply new migrations with: `DATABASE_URL=postgres://tabula:tabula@localhost:5432/tabula_cc npx pnpm@9.15.0 db:migrate`.
   **Never touch the `tabula` database or ports 3000/3002/5173** — that is a different checkout.
5. **Testing:** verify with real HTTP calls against `http://localhost:3100` (curl / node fetch with a cookie jar). Create your own test user: `POST /v1/auth/signup {email, password, name}` with an email like `ws-<letter>-<n>@tabula.test`. UI workstreams may use the browser pane **only in a tab they create** (`tabs_create`), never the existing tabs.
6. **Migrations:** new files only, numbered from your reserved range (§9). Never edit an existing migration.
7. **Line endings:** files are LF. If you script edits in Python on Windows, open with `newline=""`.
8. **Do not commit.** The orchestrator commits per workstream after review.
9. Add tests next to code you change where a test runner exists (`node --import tsx --test`), especially for pure logic (filter compiler, formula, conversion, order keys).
10. When done, report: what you fixed, what you verified and how, what is still missing, and any contract changes.

---

## 2. Identifiers

- API speaks **public ids only**: `bas_ tbl_ fld_ rec_ viw_ usr_ wsp_ att_ cmt_ aut_ shr_ opt_`. Server converts with `pid()` / `parsePid()` (`apps/server/src/lib/public-ids.ts`). `parsePid` throws `PublicIdError` → 422.
- Select options: `{ id: "opt_<random>", label: string, color: string }`. **Cells store option ids, never labels.**
- Fractional order keys compare with `COLLATE "C"` (migration 0011). Use `keyBetween(a, b)` from `@tabula/types` (workstream B adds it; until then `nextOrderKey()`).

## 3. Record wire format (all record-returning endpoints)

```jsonc
{
  "id": "rec_…",
  "version": 7,                       // bumps on every cell write
  "createdAt": "ISO", "updatedAt": "ISO",
  "rowNumber": 12, "manualOrder": "a…",
  "fields": { "fld_…": <value>, … }    // keyed by public field id; empty values are OMITTED
}
```

Value shapes by field type (output; input accepts the same shape, or the "input shorthand"):

| type | output value | input shorthand |
|---|---|---|
| `text`, `long_text`, `email`, `url`, `phone` | string | |
| `number`, `percent`, `rating`, `duration` (seconds) | number | numeric string |
| `currency` | number | numeric string |
| `checkbox` | `true` (absent = false) | `false` clears |
| `date` | `"YYYY-MM-DD"` | |
| `datetime` | ISO-8601 UTC string | |
| `single_select` | `"opt_…"` | option label (typecast) |
| `multi_select` | `["opt_…", …]` | labels (typecast) |
| `collaborator` | `[{ "id":"usr_…", "name", "email" }]` (array even if single) | `["usr_…"]` or `"usr_…"` |
| `attachment` | `[{ "id":"att_…", "filename", "mime", "size", "url", "thumbnailUrl"|null, "width"|null, "height"|null }]` | `["att_…"]` |
| `link` | `[{ "id":"rec_…", "name": "<primary display>" }]` | `["rec_…"]` |
| `lookup` | array of the target field's output values | read-only |
| `rollup`, `count`, `formula` | scalar result (number/string/bool/date) — **never** `{value,status}` | read-only |
| `autonumber` | number (= rowNumber) | read-only |
| `created_time`, `modified_time` | ISO string | read-only |
| `created_by`, `modified_by` | `{ "id":"usr_…", "name", "email" }` | read-only |
| `barcode` | `{ "text": string }` | string |
| `button` | not returned (config only) | read-only |
| `json` | any JSON | |

Formula errors: value omitted; record carries `"errors": { "fld_…": "#ERROR message" }` (optional key).

### Record endpoints (workstream B owns writes, A owns reads)
- `POST /v1/bases/:b/tables/:t/records` `{fields, typecast?}` → `201 {record: Record}`
- `POST …/records/batch` `{records:[{fields}], typecast?}` (1–500) → `201 {records: Record[]}`
- `PATCH …/records/:r` `{fields, typecast?, version?}` (or `If-Match`) → `200 {record: Record}` **with new version and full fields**
- `PATCH …/records/batch` `{records:[{id, fields}], typecast?}` → `200 {records: Record[]}` (bulk paste/fill)
- `DELETE …/records/:r` → 204; `POST …/records/batch-delete` `{ids:[]}` → 204
- `POST …/records/:r/duplicate` → `201 {record}`
- `POST …/records/:r/move` `{before?: "rec_…"|null, after?: "rec_…"|null}` → `200 {record}` (manual reorder)
- `POST …/records/query` (A) → `{records: Record[], nextCursor, totalCount?}`
  body: `{ filter?, sort?: [{field, direction}], search?: string, viewId?, pageSize? (≤500), cursor?, fields?: ["fld_…"] }`
  When `viewId` is given, the view's saved filter is ANDed with `filter` and its sorts are used unless `sort` is provided.
- `GET …/records/:r` (A) → `{record}`
- `POST …/records/group` (A) → `{groups:[{key, value, count, aggregates}]}`

## 4. Field metadata

`FieldDto = { id:"fld_…", name, type, slot, config, description: string|null, isPrimary: boolean, isComputed: boolean }`
returned by `GET /v1/bases/:b` (in `tables[].fields`), `GET …/fields`, and every field mutation.

Config per type (B owns the schema in `packages/fields`):
- `single_select` / `multi_select`: `{ options: [{id, label, color}] }`
- `number`: `{ precision: 0-8 }` · `currency`: `{ symbol: "$", precision }` · `percent`: `{ precision }`
- `rating`: `{ max: 1-10, icon: "star"|"heart"|"check" }` · `duration`: `{ format: "h:mm"|"h:mm:ss" }`
- `date`: `{ format: "local"|"iso"|"us"|"eu" }` · `datetime`: `{ format, timeFormat: "12h"|"24h", timeZone?: string }`
- `link`: `{ linkedTableId:"tbl_…", inverseFieldId:"fld_…"|null, allowMultiple: boolean }`
- `lookup`: `{ linkFieldId:"fld_…", targetFieldId:"fld_…" }`
- `rollup`: `{ linkFieldId, targetFieldId, aggregation: "sum"|"avg"|"min"|"max"|"count"|"counta"|"countall"|"concat"|"and"|"or"|"unique" }`
- `count`: `{ linkFieldId }`
- `formula`: `{ expression: string /* {Field Name} refs, stored with field ids internally */, resultType?: "number"|"text"|"date"|"boolean" }`
- `collaborator`: `{ allowMultiple: boolean, notify?: boolean }` · `attachment`: `{}` · `barcode`: `{}`
- `button`: `{ label, style?, action: { type: "open_url", url: string } | { type: "run_automation", automationId } }`

Field endpoints (B):
- `POST …/fields` `{name, type, config?, description?}` → `201 {field: FieldDto}` (link type creates the relation + inverse field; computed types are backfilled)
- `PATCH …/fields/:f` `{name?, description?, config?, type?}` → `200 {field}` — `type` change converts existing values (long op if large)
- `DELETE …/fields/:f` → 204 (409 `PRIMARY_FIELD_REQUIRED` for primary)
- `POST …/fields/:f/duplicate` `{withValues: boolean}` → `201 {field}`
- `POST …/fields/reorder` `{fieldIds: [...]}` → 204 (table-level default order)
- `POST /v1/bases/:b/tables/:t/primary-field` `{fieldId}` → 200
Tables (F owns UI, B owns server): `PATCH …/tables/:t {name}`, `DELETE …/tables/:t`, `POST …/tables/:t/duplicate {withRecords}`, `POST /v1/bases/:b/tables/reorder {tableIds}`.

## 5. View config (`views.config` JSONB) — D owns

```ts
interface ViewConfig {
  filter: FilterAst | null;                     // §6
  sorts: { fieldId: string; direction: "asc" | "desc" }[];
  groups: { fieldId: string; direction: "asc" | "desc" }[];   // ≤ 3
  hiddenFieldIds: string[];
  fieldOrder: string[];                          // fld_ ids; fields not listed append at end
  fieldWidths: Record<string, number>;           // px
  frozenFieldCount: number;                      // default 1 (primary)
  rowHeight: "short" | "medium" | "tall" | "extra";
  color: { mode: "none" } | { mode: "select"; fieldId: string } |
         { mode: "conditions"; rules: { filter: FilterAst; color: string }[] };
  summary: Record<string, "none"|"count"|"empty"|"filled"|"unique"|"sum"|"avg"|"min"|"max">;
  kanban?:   { stackFieldId: string | null; coverFieldId?: string | null; hideEmptyStacks?: boolean };
  calendar?: { dateFieldId: string | null; endDateFieldId?: string | null };
  gallery?:  { coverFieldId?: string | null; coverFit?: "cover" | "contain" };
  timeline?: { startFieldId: string | null; endFieldId?: string | null; scale?: "day"|"week"|"month" };
  form?: { title: string; description: string; fields: { fieldId: string; required: boolean; label?: string; help?: string }[];
           submitLabel: string; successMessage: string; allowResubmit: boolean };
}
```
- `GET /v1/bases/:b` and `GET …/views` return `config` (defaults filled in) for every view.
- `PATCH …/views/:v` `{ name?, config?: Partial<ViewConfig> (shallow merge), visibility? }` → `200 {view}`
- `DELETE …/views/:v` → 204 · `POST …/views/:v/duplicate` → `201 {view}` · `POST …/views/reorder {viewIds}` → 204
- View types: `grid | kanban | calendar | gallery | timeline | list | form | gantt` (gantt = timeline with dependencies).

## 6. Filter AST — A owns (`packages/filter`)

Existing shape stays: `{kind:"and"|"or", children}` | `{kind:"condition", fieldId, op, value?}`. `fieldId` may be `fld_…` or raw uuid.
Operators (A implements all, SQL + in-memory evaluator):
`eq neq contains notContains startsWith endsWith gt gte lt lte empty notEmpty anyOf noneOf hasAnyOf hasAllOf isWithin isBefore isAfter isOnOrBefore isOnOrAfter isMe`
- dates: `value` may be `"YYYY-MM-DD"` or `{ relative: "today"|"tomorrow"|"yesterday"|"oneWeekAgo"|"oneWeekFromNow"|"oneMonthAgo"|"oneMonthFromNow"|"exactDate", date?: "YYYY-MM-DD" }`; `isWithin` value `{ range: "pastWeek"|"pastMonth"|"pastYear"|"nextWeek"|"nextMonth"|"nextYear"|"thisWeek"|"thisMonth"|"pastNDays"|"nextNDays", n?: number }`
- select: `eq/neq` take an option id; `anyOf/noneOf` take option id arrays; multi-select uses `hasAnyOf/hasAllOf/noneOf`.
- Operators valid per type are exported as `operatorsForFieldType(type): FilterOp[]` with labels from `operatorLabel(op)` — UI must use these (no hard-coded lists).

## 7. Web conventions — React Query keys

| Key | Data |
|---|---|
| `["bases", baseId]` | `BaseDetail` (tables, fields, views incl. config) |
| `["records", baseId, tableId, ...rest]` | record pages; **invalidate with prefix `["records", baseId, tableId]`** |
| `["record", baseId, tableId, recordId]` | single record (drawer) |
| `["views", baseId, tableId]` | views list |
| `["comments", baseId, tableId, recordId]`, `["attachments", …]` | drawer |
| `["automations", baseId]`, `["notifications"]`, `["workspaces"]`, `["workspaces", wsId, "bases"]` | |

Realtime (F): on a `change` frame for a table → `invalidateQueries(["records", baseId, tableId])` (and `["record", …]` for touched ids); schema/view changes → `["bases", baseId]`. Own edits (matching `clientMutationId`) are skipped.

API client: add new functions in `apps/web/src/lib/api-areas/<area>.ts` using `import { request } from "../api"`. Fix existing functions in `api.ts` only within your area (§9).

## 8. Grid component contract (C implements, D wires)

```ts
interface GridViewProps {
  baseId: string; table: TableDto; view: ViewDto;   // view.config: ViewConfig
  filter: FilterAst | null;       // effective (saved + ad-hoc)
  sorts: ViewConfig["sorts"]; groups: ViewConfig["groups"];
  search: string;
  hiddenFieldIds: string[]; fieldOrder: string[]; fieldWidths: Record<string, number>;
  frozenFieldCount: number; rowHeight: ViewConfig["rowHeight"]; color: ViewConfig["color"];
  summary: ViewConfig["summary"];
  canEdit: boolean;
  onConfigChange(patch: Partial<ViewConfig>): void;   // column resize/reorder/hide/sort-from-header etc.
  onOpenRecord(recordId: string): void;
}
```
`apps/web/src/features/grid/GridView.tsx` exports `GridView`. `apps/web/src/features/record/RecordDrawer.tsx` exports `RecordDrawer({baseId, tableId, recordId, onClose, onNavigate?})` (C). Other view types (D) call `onOpenRecord` → drawer.

Field UI (C, `packages/field-ui`): `renderCellValue(field, value)`, `<FieldValueEditor field value onChange />`, `fieldTypeIcon(type)`, `fieldTypeLabel(type)`, `<FieldConfigEditor type config onChange fields tables />` — D/E reuse these in kanban/gallery/forms/public app.

## 9. Ownership

| WS | Scope | Owns (edit freely) | Migration range |
|---|---|---|---|
| **A** | Query & filter engine, record read path | `packages/filter`, `packages/query`, `apps/server/src/modules/query/**`, `apps/server/src/modules/recordstore/**` (sidecars), record read serialization helper `apps/server/src/modules/records/serialize.ts` (new, shared by B) | 0020–0029 |
| **B** | Schema, fields, compute, formula, links, record writes, tables server | `packages/fields`, `packages/compute`, `packages/formula`, `packages/links`, `packages/types` (order keys only), `apps/server/src/modules/{schema,compute,links,records}/**` (except `records/serialize.ts` read-only use), `apps/server/src/modules/base/bootstrap-default-table.ts` | 0030–0039 |
| **C** | Grid, cells, field UI, record drawer, field header/row menus | `apps/web/src/features/{grid,schema,record}/**`, `packages/field-ui`, `packages/grid`, `apps/web/src/lib/api-areas/records.ts`, `…/fields.ts` | — |
| **D** | Views: toolbar, sidebar, all view types, forms builder, views server | `apps/web/src/features/views/**`, `apps/web/src/routes/table-grid.tsx`, `apps/server/src/modules/views/**`, `apps/web/src/lib/api-areas/views.ts` | 0040–0049 |
| **E** | Sharing + public app, attachments, import/export, search, notifications, contacts, comments | `apps/web/src/features/{share,import,search,notifications}/**`, `apps/web/src/routes/contacts.tsx`, `apps/public/**`, `apps/server/src/modules/{share,attachments,import-export,search,notifications,contacts,comments,wave4,collab}/**`, `packages/storage`, `packages/search`, `apps/web/src/lib/api-areas/{share,files,search,collab}.ts` | 0050–0059 |
| **F** | Realtime, events/jobs infra, base shell, home, auth UI, undo/redo, tables UI | `apps/server/src/entrypoints/**`, `apps/server/src/kernel/**`, `apps/server/src/modules/{history,base,workspace,organization}/**` (except `base/bootstrap-default-table.ts`), `packages/{events,jobs,realtime-protocol,realtime-client,record-store}`, `apps/web/src/features/{base,tools}/**`, `apps/web/src/routes/{base,index,__root,login,signup}.tsx` and other non-listed routes, `apps/web/src/app/**`, `apps/web/src/lib/api-areas/shell.ts` | 0060–0069 |
| **G** | Automations (engine + UI), auth/security server, invitations, audit, billing, idempotency, error mapping, permissions | `apps/web/src/features/automations/**`, `apps/server/src/modules/{automations,auth,invitations,audit,billing,feature-flags,access}/**`, `apps/server/src/http/**`, `packages/permissions`, `packages/auth`, `packages/db/migrations` 0012–0019 | 0012–0019 |

**Shared regions** (re-read immediately before editing, minimal diff):
- `apps/web/src/lib/api.ts` — each WS may edit only functions for its area (A/B: records & fields & query; C: none, use api-areas; D: views; E: share/attachments/import/search/notifications/contacts/comments; F: auth/workspaces/bases/tables/undo; G: automations).
- `apps/web/src/routes/base.tsx` — F owns; D may edit only the "create view" handler block.
- `apps/server/src/http/app.ts` route registration — G owns; others add one `register…` line if they add a new routes file.
- `packages/db/src` Kysely types — anyone adding a migration may add matching types.

**Permissions (G, phase 2):** G adds `compileForUser` + `assertCan` checks across all route files **after** the other workstreams finish. In phase 1, other workstreams should already call `assertCan(snapshot, "<action>")` in new handlers they write (`apps/server/src/modules/access/assert.ts`).

---

## 10. Cross-workstream hand-offs

| Provider | Deliverable | Consumer |
|---|---|---|
| A (first task) | `apps/server/src/modules/records/serialize.ts`: `serializeRecords(db, tableId, rows, opts?) → Promise<RecordWire[]>` implementing §3 (computed unwrap, meta fields, collaborator/link/attachment hydration) | B (write responses), E (public share records), D |
| A | `packages/filter`: `operatorsForFieldType`, `operatorLabel`, `evaluateFilter(ast, record, fields, ctx)` | C, D, G (automation conditions) |
| B | **Links are authoritative in `data.record_links`.** Cells no longer hold link arrays (B migrates/ignores legacy link cells). A's serializer reads links from `record_links`. | A |
| B (early) | `keyBetween(a: string|null, b: string|null): string` exported from `@tabula/types` | B, D (view reorder), F (table reorder) |
| F (first task) | `kernel/mutation.ts`: `mctx.afterCommit(fn: () => Promise<void> | void)`; realtime publish moved after commit | B (compute job enqueue), E, G |
| F | `GET /v1/bases/:b/collaborators` → `{ collaborators: [{id:"usr_…", name, email, role}] }` | C (collaborator picker), E (mentions), G |
| E | `apps/web/src/lib/api-areas/files.ts`: `uploadAttachment(baseId, file, onProgress?) → Promise<AttachmentWire>` (presign → PUT → complete); `GET /v1/bases/:b/attachments/:id` returns fresh signed URL | C (attachment cell + drawer) |
| E | `apps/web/src/features/comments/RecordComments.tsx` `({baseId, tableId, recordId})` — list/post/edit/delete/react, @mentions | C mounts it in the drawer |
| E | `apps/web/src/features/import/ImportWizard.tsx` `({baseId, tableId?, onClose})` and `ExportMenu` `({baseId, tableId, viewId})` | F (Tools menu / table tab menu) |
| C | `apps/web/src/features/schema/FieldManager.tsx` `({baseId, table, onClose})` | F (Tools → Manage fields) |
| D | `apps/web/src/features/views/FormsIndex.tsx` `({baseId})` | F (base "Forms" tab) |
| D | may edit the views-serialization block of `getBase` in `apps/server/src/modules/base/routes.ts` (shared region) | — |

Interfaces (Airtable "Interfaces" designer) are **out of scope for this pass**; F replaces the placeholder with a clear "coming soon" empty state.

## Contract changes
(append dated notes here)

### 2026-10-06 — B: storage formats, helpers (early note; final details in B's report)
- `keyBetween(a, b)` / `keysBetween(a, b, n)` are exported from `@tabula/types` (built). Generated keys never end in '0'; legacy timestamp keys are tolerated. Throws `RangeError` when `a >= b`.
- **Cell storage** (`data.records.cells`, keyed by slot) written by B's write path:
  text-like → string · number/currency/percent/rating/duration → number · checkbox → `true` (absent = false) · date → `"YYYY-MM-DD"` · datetime → ISO UTC · single_select → `"opt_…"` · multi_select → `["opt_…"]` ·
  **collaborator → array of raw user uuids** · **attachment → array of raw attachment uuids** · barcode → `{ "text": string }` · json → any JSON ·
  **link → never in cells** (read `data.record_links`; `a_order` orders the b-records inside an a-record's list, `b_order` the reverse). Legacy link arrays in cells are ignored and stripped on the next write.
- **Computed storage** (`data.records.computed`, keyed by slot): the **unwrapped** value (number/string/boolean/ISO date string, or an array for lookups — lookup arrays are flattened one level and hold the target field's *stored* values, e.g. raw rec uuids for a lookup of a link field, `opt_` ids for a lookup of a select; serializer hydrates by the target field's type). Formula/compute errors live in `computed["_errors"] = { "<slot>": "#ERROR! message" }` → serializer emits them as `errors: { fld_…: msg }` and omits the value. Old `{value,status}` objects may exist in old rows — treat an object with a `status` key as legacy and unwrap `.value`.
- Field config is stored with **raw uuids** internally; the wire `FieldDto.config` uses public ids (`tbl_`/`fld_`) and formulas show `{Field Name}`. Use `fieldRowToDto(row, ctx)` from `apps/server/src/modules/schema/field-dto.ts` (B) to serialize fields anywhere (getBase, etc.).
- Record writes from other modules (import, public form submit, contacts) should use `apps/server/src/modules/records/write.ts` (B): `createRecordsInTx(trx, mctx, {...})` / `updateRecordsInTx` — they run validation, links, compute and counters.
