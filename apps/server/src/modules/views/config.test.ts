import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultConfigForType,
  normalizeViewConfig,
  viewConfigPatchSchema,
} from "./config.js";
import { canEditView } from "./serialize.js";

const fields = [
  { id: "fld_name", type: "text", isPrimary: true },
  { id: "fld_status", type: "single_select", isPrimary: false },
  { id: "fld_due", type: "date", isPrimary: false },
  { id: "fld_end", type: "date", isPrimary: false },
  { id: "fld_formula", type: "formula", isPrimary: false },
];

test("type defaults", () => {
  assert.equal(defaultConfigForType("kanban", fields).kanban?.stackFieldId, "fld_status");
  assert.equal(defaultConfigForType("calendar", fields).calendar?.dateFieldId, "fld_due");
  const tl = defaultConfigForType("gantt", fields).timeline;
  assert.deepEqual([tl?.startFieldId, tl?.endFieldId], ["fld_due", "fld_end"]);
  const form = defaultConfigForType("form", fields, "Tasks").form!;
  assert.equal(form.title, "Tasks");
  assert.deepEqual(
    form.fields.map((f) => f.fieldId),
    ["fld_name", "fld_status", "fld_due", "fld_end"],
  );
});

test("normalize fills defaults, migrates legacy keys, drops junk", () => {
  const c = normalizeViewConfig(
    { sort: [{ fieldId: "fld_due", direction: "desc" }], rowHeight: "bogus", junk: 1 },
    "grid",
    fields,
  );
  assert.deepEqual(c.sorts, [{ fieldId: "fld_due", direction: "desc" }]);
  assert.equal(c.rowHeight, "short");
  assert.equal((c as unknown as Record<string, unknown>)["junk"], undefined);
  assert.equal(c.frozenFieldCount, 1);
  const k = normalizeViewConfig({ kanban: { hideEmptyStacks: true } }, "kanban", fields);
  assert.equal(k.kanban?.stackFieldId, "fld_status");
  assert.equal(k.kanban?.hideEmptyStacks, true);
});

test("patch schema validates", () => {
  assert.equal(viewConfigPatchSchema.safeParse({ rowHeight: "tall" }).success, true);
  assert.equal(viewConfigPatchSchema.safeParse({ rowHeight: "huge" }).success, false);
  assert.equal(viewConfigPatchSchema.safeParse({ groups: new Array(4).fill({ fieldId: "a", direction: "asc" }) }).success, false);
  assert.equal(
    viewConfigPatchSchema.safeParse({
      filter: { kind: "and", children: [{ kind: "or", children: [{ kind: "condition", fieldId: "f", op: "eq", value: 1 }] }] },
    }).success,
    true,
  );
});

test("canEditView", () => {
  assert.equal(canEditView({ visibility: "collaborative", owner_user_id: null, created_by: "a" }, "b"), true);
  assert.equal(canEditView({ visibility: "locked", owner_user_id: null, created_by: "a" }, "b"), false);
  assert.equal(canEditView({ visibility: "locked", owner_user_id: null, created_by: "a" }, "b", true), true);
  assert.equal(canEditView({ visibility: "personal", owner_user_id: "a", created_by: "a" }, "b", true), false);
});
