# Tabula UI audit (read-only, no files changed)

**Scope:** I read every `.tsx`/`.ts` file in `apps/web/src` and `apps/public/src`, plus `packages/grid`, `packages/field-ui` and `packages/ui`. Wherever a UI handler calls `apps/web/src/lib/api.ts`, I followed the call into the matching `apps/server/src/modules/*/routes.ts` to see if the request and response actually line up.

**Short version:** a lot of the UI exists but isn't wired to anything. Several API calls point at URLs the server doesn't serve, or send/expect a different body shape. The core cell editor also loses data. All paths below are relative to `E:\Blue Cascade\Projects\32TableOSClaudeCode`.

---

## 1. Grid editing — `apps/web/src/features/grid/DomGrid.tsx`, `CellEditor.tsx`

| Control | Handler | Status |
|---|---|---|
| Click a cell (`DomGrid.tsx:295-298`, `onMouseDown`) | `preventDefault()` + `startEdit()` | **BROKEN.** `preventDefault` stops the focus change, so the input being edited never blurs and its `onBlur` commit never runs. `startEdit` then replaces the `editing` state, so **whatever was typed in the previous cell is thrown away**. Clicking inside the active input also bubbles up to the cell and resets the draft to the saved value (and you can't place the caret). |
| Checkbox cell (`CellEditor.tsx:61-62`) and single-select cell (`CellEditor.tsx:85-87`) | `onDraftChange(x); onCommit()` in the same tick | **BROKEN.** `commitEdit` (`DomGrid.tsx:177-203`) closes over the old `editing.draft`, sees no change, sends no PATCH and clears editing. **Checkbox and single-select edits never save.** Checkboxes also need two clicks (the first click only mounts the input). |
| Single-select options (`CellEditor.tsx:103`) | `<option value={opt.label}>` | **BROKEN data model.** The fields package expects option **ids** (`packages/fields/src/definitions.ts:175-185`). The server's PATCH (`schema/field-map.ts`) stores the label without checking it. Kanban groups by option id, so cards disappear (see section 5). |
| Multi-select / number cells (`DomGrid.tsx:19-37`) | free text split on commas / `Number()` | **PARTIAL.** There is no option picker. Text that isn't a number gets stored as a string in a number field. |
| Enter / Tab (`CellEditor.tsx:133-140`) | `onAdvance`: commit and move **right** | **PARTIAL.** Enter acts like Tab instead of moving down / leaving edit mode as Airtable does. Tab on the last cell creates a new row. |
| Arrow keys, Esc-to-select, Delete/Backspace to clear, copy/paste, multi-cell selection | none | **MISSING.** There is no "selected but not editing" mode at all. `gridSelection` is only set by `startEdit`. |
| Cell save (`DomGrid.tsx:92-108`) | PATCH with `record.version`; on success, invalidate | **BROKEN under normal typing.** The PATCH response (`records/routes.ts:440`) has no new version, and nothing updates optimistically. Edit field A, Tab to field B, commit before the refetch lands: the second PATCH sends the old version, the server returns **409** (`records/routes.ts:376-381`, 431-433), and there is **no `onError`**, so the edit silently disappears. The cell also briefly shows the old value until the refetch. |
| "+ Add row" (`DomGrid.tsx:337-344`, and toolbar `table-grid.tsx:177-184`) | `createRecord` | **PARTIAL/BROKEN.** The row gets created. But the effect at `DomGrid.tsx:209-216` runs on every render (`fields` is a new array each time, line 69), so it immediately opens the editor on the **previous** last row, not the new one. The toolbar version doesn't focus the new row at all. |
| "+" column header (`DomGrid.tsx:256-263`) | opens `AddFieldDialog` | WORKS, but if creating the field fails, no error is shown in this path (`DomGrid.tsx:134-144`). |
| Field header (`features/schema/FieldHeader.tsx`) | plain text | **MISSING:** no menu to rename, change type, delete, sort, filter, hide, duplicate, or resize/reorder columns. The server already has PATCH/DELETE for fields (`schema/routes.ts:395,455`). |
| Row number cell (`DomGrid.tsx:273`) | plain text | **MISSING:** no expand-record button, row checkbox, drag handle, or right-click menu (no delete record, even though server DELETE exists at `records/routes.ts:457`). |
| Pagination (`DomGrid.tsx:77`, `table-grid.tsx:91`) | `pageSize: 200`, `nextCursor` ignored | **BROKEN for >200 rows.** Extra rows are never loaded. |
| `CanvasTableGrid.tsx`, `packages/grid` (CanvasGrid/createGrid with arrow-key navigation and drag selection), `field-ui/SimpleFieldEditor` | — | **DEAD CODE.** Never mounted anywhere. |

## 2. View toolbar — `features/views/ViewToolbar.tsx`, `routes/table-grid.tsx`

All toolbar state is local `useState` (`table-grid.tsx:41-54`). It is **never saved to the view** (the server has `PATCH /views/:viewId` with filters/sort/group/visibleFields at `views/routes.ts:39-43,248`; the client has no matching call). It also **isn't reset when you switch tables or views** (the component isn't keyed), so field ids from the previous table carry over.

| Control | Status |
|---|---|
| Hide fields (`ViewToolbar.tsx:97-107`, 162-186) | WORKS for the grid (session only, not saved). |
| Filter (`:108-118`, 188-272) | **BROKEN.** In grid view the filter is never passed to `DomGrid` (`table-grid.tsx:202-207`; DomGrid has its own unfiltered query). In other views it is sent, but the server compares `fld_…` public ids against a map keyed by raw UUIDs (`query/routes.ts:57-66` does not parse the ids; `packages/filter/src/sql.ts:140-143` returns `"FALSE"` for an unknown field). **Any filter returns zero records.** |
| Sort (`:126-132`, 290-315) | **BROKEN.** Not applied in grid view. In other views the same id mismatch makes the server fall back to manual order (`packages/query/src/planner.ts:35`, `build-record-query.ts:19`). Only one sort level is possible. |
| Group (`:119-125`, 274-288) | **NO-OP.** Only sets `data-group` on a wrapper (`table-grid.tsx:148`). No CSS or code uses it. The server's `/records/group` endpoint is unused. |
| Color (`:133-139`, 317-342) | **NO-OP.** Only sets `data-color`, which nothing uses. |
| Row height (`:140-147`, 344-358) | **NO-OP.** `data-row-height` has no CSS rule anywhere. |
| Search icon (`:151-158`, 360-370) | **BROKEN in grid view** (not passed to DomGrid). Works client-side on the ≤200 loaded rows in other views. |
| "Share and sync" (`:148`) | Opens ShareDialog, which is broken (section 7). |
| Panels | No click-outside or Esc to close. |

## 3. Views sidebar — `features/views/ViewsSidebar.tsx`, `routes/base.tsx`

| Control | Status |
|---|---|
| Select a view (`ViewsSidebar.tsx:53-62`) | WORKS. |
| "+ Create new…" menu (`:133-135`, `base.tsx:78-101`) | PARTIAL. Grid/Calendar/Gallery/Kanban/Form get created. **Timeline, List and Gantt are silently saved as `type: "grid"`** (`base.tsx:88-90`), even though the server accepts those types (`views/routes.ts:32-34`). That also makes the placeholder at `table-grid.tsx:226-230` unreachable. Every new view is named "X view" with no rename prompt. |
| "Collaborative grid" (`:145-152`) | WORKS. |
| Add/Remove favorite (`:76-87`) | WORKS (invalidates views and base). |
| "Jump to original…" (`:89-98`) | **NO-OP in practice.** It re-selects the same view. |
| "Rename view" (`:101-107`) | **STUB.** It only closes the menu. |
| Delete / duplicate / lock / reorder views | **MISSING.** |
| Find a view, section collapse | WORKS. A locked view you own shows up in both the personal and collaborative sections (`:37-44`). |

## 4. Base shell — `routes/base.tsx`

| Control | Status |
|---|---|
| ← Home (`:137`) | WORKS. |
| Data / Automations tabs | WORKS. |
| "Interfaces" tab (`:278-282`) | **STUB** (placeholder text). |
| "Forms" tab (`:284-288`) | **STUB** (placeholder text). |
| Undo (`:173-180`) | WORKS (server `/undo`, invalidates). No Cmd/Ctrl+Z, no Redo (server has `/redo`), and nothing is shown if it fails. |
| Share (`:182-188`) | Opens a broken dialog (section 7). |
| Table tabs (`:197-213`) | WORKS. **Missing:** rename, delete, duplicate, reorder (server PATCH/DELETE exist at `schema/routes.ts:141,198`). |
| "+" add table (`:215-231`) | WORKS, using `window.prompt`. |
| Tools ▾ (`ToolsMenu.tsx:62-64`) | Extensions, Record templates, Date dependencies and Insights are **NO-OP**. "Manage fields" just opens the *Add field* dialog (`table-grid.tsx:56-58`); there is no field manager. |
| Import CSV | **UNREACHABLE.** `onOpenImport` is passed in but only `void`ed (`table-grid.tsx:60-62`). No button opens `ImportWizard`. |
| Realtime (`BaseSessionProvider.tsx:48-112`) | **BROKEN.** (1) Incoming changes go into a `RecordStore` that nothing reads (`useBaseSession` is never used), and the client keeps only `setCell` ops (`:61`) while the server emits `record.updated`. **Other users' edits don't appear** until a refetch. (2) The effect depends on `onResync`, which depends on the `baseQuery` result object (`base.tsx:119-122`). In TanStack Query v5 that is likely a new object every render, so the WebSocket probably disconnects and reconnects on every BasePage render. |
| Presence avatars | Rendered from the presence store. Hard to verify given the reconnect issue above. |

## 5. Other view types — `features/views/*`

| Control | Status |
|---|---|
| Kanban (`KanbanView.tsx:19-37`) | **BROKEN.** Columns are keyed by option id, but the grid stores labels. When options exist there's no "uncategorized" column, so **records vanish**. Cards don't open, there's no drag between columns, and it always uses the first single-select field (no picker). |
| Gallery (`GalleryView.tsx`) | PARTIAL. Read-only cards (first 3 fields); clicking does nothing; no cover image. |
| Calendar (`CalendarView.tsx`) | PARTIAL. A day-grouped list, not a month grid. Can't create or drag events. |
| Form view (`FormView.tsx:28-40`) | PARTIAL. It does create the record, but there's no success message, inputs don't clear, select/date fields are plain text boxes, and there's no form builder (field order, required, descriptions). |
| Non-grid views generally | All use the filter/sort that's broken on the server side (section 2). |

## 6. Record expand / comments / attachments — `features/record/RecordExpandDrawer.tsx`

- **Never opened.** `setDrawerRecordId` is never called (`table-grid.tsx:53,232`), so the drawer is dead UI.
- Even if it opened, it shows only the record id. **There's no field editing.**
- Comments: list/post endpoints match the server, but the server returns `createdBy`, not `authorName` (`comments/routes.ts:60-68`), so author names are blank.
- Attachments: **BROKEN.** The client calls `/tables/:t/records/:r/attachments[/presign|/complete]` (`api.ts:400-446`). The server only serves `/v1/bases/:baseId/attachments/presign|complete` and expects `{filename, mime, size}` (`attachments/routes.ts:16-20,28,78`). There's no list endpoint, so these are 404s. `onFileSelected` has no `catch`, so failures become unhandled rejections with no message (`:44-69`).

## 7. Share — `features/share/ShareDialog.tsx`, `apps/public`

- "Create link" (`ShareDialog.tsx:26-37`) → `api.createShare` posts to `/v1/bases/:b/tables/:t/shares` with `{viewId, kind}` (`api.ts:367-380`). The server route is `/v1/bases/:baseId/shares` and expects `{targetType, targetId}`, returning `{share:{token}}` (`share/routes.ts:22-34,105`). The result is a **404 with no error shown**; the button just resets. Form shares would also get a `/s/` link instead of `/f/`.
- Public app `SharePage.tsx`: `/v1/public/shares/:token` returns only `{share:{id,baseId,targetType,targetId}}` (`share/routes.ts:202-209`), but the page reads `share.fields`, `.title`, `.kind`, `.records`. **It crashes with a TypeError** (`SharePage.tsx:14,57`).
- Public form submit: `POST /v1/public/shares/:token/submit` doesn't exist. The fallback uses an `X-Tabula-Share-Token` header that the server never checks (`public-api.ts:46-83`), so **public forms can't submit**.

## 8. Import / Export

- `ImportWizard` is unreachable (section 4). It also calls the wrong URL and body: `/tables/:t/import {csv}` (`api.ts:448-457`) versus the server's `/v1/bases/:b/import/csv {tableId, rows[]}` (`import-export/routes.ts:14-18,38`). There's no error state.
- Export: the server has `/export/csv`, but there is **no UI**.

## 9. Automations — `features/automations/AutomationsPanel.tsx`

| Control | Status |
|---|---|
| Create → "Automation" (`:132`) | WORKS, but it hard-codes the `record.updated` trigger, so the "Suggested triggers" picker never shows for new automations. |
| "Section", "Browse catalog" (`:138-144`) | Permanently disabled. |
| ON/OFF toggle (`:101-109`) | WORKS. |
| "+ Add trigger" (`:194-200`) | Opens the *create* menu instead of setting a trigger. |
| Suggested trigger buttons (`:207-210`) | Each creates a **new** automation instead of setting the selected one's trigger. |
| "+ Add another automation" (`:229-237`) | WORKS. |
| "See all…" (`:240`) | **NO-OP** (no `onClick`). |
| Configure trigger, add actions, rename, delete, run history | **MISSING** (server PATCH/DELETE exist). |

## 10. Global — home, search, notifications, contacts, auth

| Control | Status |
|---|---|
| Login / Signup forms | WORKS. |
| **Log out** | **MISSING everywhere** (server `/v1/auth/logout` exists). |
| Home: base links, "Create base" | WORKS. **Missing:** rename/delete base, create workspace, templates. |
| Cmd/Ctrl+K search palette (`SearchPalette.tsx:43,49`) | **BROKEN.** The server returns `{hits:[{docType, baseId, refId}]}` (`search/routes.ts:44-56`); the client reads `results` / `kind === "base"`, so it **always says "No results"**. |
| Notifications bell (`NotificationsBell.tsx:26,46,49`) | **BROKEN.** The server sends no `unreadCount` (badge never shows) and sends `read` instead of `readAt` (everything looks unread, "Mark read" never goes away). **`body` is a JSON object** (migration `0008_collab_surfaces.sql:179`), and `<p>{n.body}</p>` will **crash the whole base page** once any notification exists. |
| Contacts page (`routes/contacts.tsx:28`) | **BROKEN rendering.** The server returns `{id, fields}` (`contacts/routes.ts:56-61`), so `c.name` and `c.email` are undefined and every row is blank. |
| Session expiry | A 401 mid-session isn't redirected to login (only route `beforeLoad` checks). |

**CSS:** I scripted a check of every `styles.X` reference against its CSS module and found no missing classes, empty selectors, or unbalanced braces. All `--tabula-*` variables are defined. The only CSS gap is that the `data-row-height` / `data-group` / `data-color` attributes have no rules.

---

## Prioritized fix list

### P0 — core flow broken
1. **Cell clicks lose in-progress edits** and clicking inside the input resets it (`DomGrid.tsx:295-298`).
2. **Checkbox and single-select edits never save** because of the stale closure (`CellEditor.tsx:61-62,85-87` with `DomGrid.tsx:177-203`).
3. **Silent 409 on back-to-back edits to the same record** (no version bump, no optimistic update, no `onError`; `DomGrid.tsx:92-108`).
4. **Filter returns nothing and sort is ignored on the server** because `fld_` public ids aren't decoded (`apps/server/src/modules/query/routes.ts:57-66`). The grid doesn't apply filter, sort or search at all (`table-grid.tsx:202-207`).
5. **Notifications bell will crash the base page** once notifications exist (object `body`).
6. **Sharing is completely broken** end to end: create-share URL and body mismatch, public page crashes on the response shape, public form submit endpoint missing.
7. **Single-select stores labels instead of option ids**, which empties Kanban and breaks formatting (`CellEditor.tsx:103`, `KanbanView.tsx:34-37`).
8. **More than 200 records are never loaded** (`nextCursor` ignored).

### P1 — visible button does nothing or the wrong thing
- **Never wired up:** the record expand drawer is never opened (`table-grid.tsx:53`), and Import has no entry point (`table-grid.tsx:60-62`). Import and Attachments also call the wrong endpoints with the wrong bodies.
- **Toolbar buttons with no effect:** Group, Color and Row height do nothing, and no toolbar state is saved to the view or reset on table/view switch.
- **Views sidebar:** "Rename view" is a stub, "Jump to original" does nothing, and Timeline/List/Gantt are saved as grid.
- **Menus and actions:**
  - Tools menu: four of five items do nothing, and "Manage fields" opens Add field.
  - Automations: "+ Add trigger" and the suggested triggers create new automations instead of setting the trigger, and "See all…" has no handler.
- **Broken data display:**
  - Search palette always shows "No results".
  - Notifications: no badge, and every item looks unread.
  - Contacts rows are blank.
  - Comment author names are blank.
- **Add-row and realtime bugs:**
  - Add row puts the editor on the wrong row.
  - Realtime edits from other users never reach the grid, and the socket likely reconnects on every render.
- **Missing error messages:** Share, Import, Undo, Attachments, and the column-header Add field.
- **Smaller issues:**
  - Enter moves right instead of down.
  - The Add field dialog labels `datetime` as "Duration" (`AddFieldDialog.tsx:26`).
  - The form view gives no success feedback.

### P2 — missing Airtable-standard features
- **Fields:** a header menu to rename, change type, delete, duplicate, sort, filter or hide a field; formula, link and lookup config editors (link/formula are created with empty or default config).
- **Records:** delete, duplicate or expand records (row menu / right-click); row drag-reorder and row checkboxes / multi-select.
- **Grid keyboard and selection:** keyboard selection mode (arrows, Delete, copy/paste, fill), multi-sort, column resize/reorder/freeze, summary bar.
- **Tables, views, bases:** rename/delete for tables, views and bases; saving view config.
- **View types:** real Group-by rendering; Kanban drag; month-grid Calendar; Gallery card expand; Timeline, Gantt and List views; Interfaces; a form builder.
- **Data and account:** CSV export UI, Redo and Cmd+Z, attachment field type and cell preview, comment mentions/reactions, logout, workspace management.
