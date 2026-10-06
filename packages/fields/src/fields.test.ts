import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  convertCellValue,
  getFieldType,
  normalizeCellValue,
  FieldValidationError,
  parseDateLoose,
  parseDurationLoose,
} from "./index.js";

const sel = {
  options: [
    { id: "opt_a", label: "Todo", color: "red" },
    { id: "opt_b", label: "Done", color: "green" },
  ],
};

describe("normalize", () => {
  it("numbers accept numeric strings, reject junk", () => {
    assert.deepEqual(normalizeCellValue("number", "1,234.5", { precision: 1 }), { value: 1234.5 });
    assert.deepEqual(normalizeCellValue("currency", "$12.50", {}), { value: 12.5 });
    assert.deepEqual(normalizeCellValue("percent", "50%", {}), { value: 0.5 });
    assert.throws(() => normalizeCellValue("number", "abc", {}), FieldValidationError);
    assert.deepEqual(normalizeCellValue("number", "", {}), {});
  });

  it("selects map labels to ids and create with typecast", () => {
    assert.deepEqual(normalizeCellValue("single_select", "done", sel), { value: "opt_b" });
    assert.deepEqual(normalizeCellValue("single_select", "opt_a", sel), { value: "opt_a" });
    assert.throws(() => normalizeCellValue("single_select", "Nope", sel), FieldValidationError);
    const created: string[] = [];
    const r = normalizeCellValue("multi_select", ["Todo", "New"], sel, {
      typecast: true,
      createOption: (l) => {
        created.push(l);
        return "opt_new";
      },
    });
    assert.deepEqual(r, { value: ["opt_a", "opt_new"] });
    assert.deepEqual(created, ["New"]);
  });

  it("dates parse common formats", () => {
    assert.equal(parseDateLoose("2024-03-05"), "2024-03-05");
    assert.equal(parseDateLoose("3/5/2024"), "2024-03-05");
    assert.equal(parseDateLoose("2024-03-05T10:00:00"), "2024-03-05");
    assert.equal(parseDateLoose("2024-02-30"), null);
    assert.deepEqual(normalizeCellValue("datetime", "2024-03-05T10:00:00Z", {}), {
      value: "2024-03-05T10:00:00.000Z",
    });
  });

  it("duration, checkbox, rating", () => {
    assert.equal(parseDurationLoose("1:30"), 5400);
    assert.equal(parseDurationLoose("0:01:05"), 65);
    assert.deepEqual(normalizeCellValue("checkbox", "yes", {}), { value: true });
    assert.deepEqual(normalizeCellValue("checkbox", false, {}), {});
    assert.throws(() => normalizeCellValue("rating", 7, { max: 5 }), FieldValidationError);
    assert.deepEqual(normalizeCellValue("rating", 7, { max: 5 }, { typecast: true }), { value: 5 });
  });

  it("collaborator/attachment/link ids", () => {
    const uuid = "0190f0c2-1111-7aaa-8bbb-123456789abc";
    assert.deepEqual(normalizeCellValue("collaborator", uuid, { allowMultiple: false }), { value: [uuid] });
    assert.throws(() => normalizeCellValue("collaborator", "bob", {}), FieldValidationError);
    assert.deepEqual(normalizeCellValue("link", [], { allowMultiple: true }), { value: [] });
    assert.throws(
      () => normalizeCellValue("link", [uuid, uuid.replace("1111", "2222")], { allowMultiple: false }),
      FieldValidationError,
    );
  });

  it("barcode / json / read-only", () => {
    assert.deepEqual(normalizeCellValue("barcode", "123", {}), { value: { text: "123" } });
    assert.deepEqual(normalizeCellValue("json", { a: [1] }, {}), { value: { a: [1] } });
    assert.throws(() => normalizeCellValue("formula", 1, { expression: "1" }), FieldValidationError);
    assert.throws(() => getFieldType("nope"), FieldValidationError);
  });

  it("config defaults", () => {
    assert.deepEqual(getFieldType("number").defaultConfig(), { precision: 0 });
    assert.deepEqual(getFieldType("rating").defaultConfig(), { max: 5, icon: "star", color: "yellow" });
    const s = getFieldType("single_select").normalizeConfig({ options: ["A", { label: "B" }] });
    const opts = s.options as Array<{ id: string; label: string; color: string }>;
    assert.equal(opts.length, 2);
    assert.match(opts[0]!.id, /^opt_/);
    assert.equal(opts[1]!.color, "cyan");
    assert.throws(() => getFieldType("single_select").normalizeConfig({ options: ["A", "a"] }));
    assert.throws(() => getFieldType("lookup").normalizeConfig({ linkFieldId: "x" }));
    assert.deepEqual(getFieldType("rollup").normalizeConfig({ linkFieldId: "l", rollupFieldId: "t", aggregation: "average" }), {
      linkFieldId: "l",
      targetFieldId: "t",
      aggregation: "avg",
    });
  });
});

describe("convertCellValue", () => {
  const T = (type: string, config: Record<string, unknown> = {}) => ({ type, config });
  it("text <-> number", () => {
    assert.deepEqual(convertCellValue("42", T("text"), T("number")), { value: 42 });
    assert.deepEqual(convertCellValue("forty", T("text"), T("number")), {});
    assert.deepEqual(convertCellValue(42.5, T("number"), T("text")), { value: "42.5" });
  });
  it("text -> select creates options", () => {
    const made: string[] = [];
    const r = convertCellValue("Blue", T("text"), T("single_select", { options: [] }), {
      createOption: (l) => {
        made.push(l);
        return "opt_x";
      },
    });
    assert.deepEqual(r, { value: "opt_x" });
    assert.deepEqual(made, ["Blue"]);
  });
  it("select -> text, multi -> single, multi -> text", () => {
    assert.deepEqual(convertCellValue("opt_b", T("single_select", sel), T("text")), { value: "Done" });
    assert.deepEqual(convertCellValue(["opt_b", "opt_a"], T("multi_select", sel), T("single_select", sel)), {
      value: "opt_b",
    });
    assert.deepEqual(convertCellValue(["opt_a", "opt_b"], T("multi_select", sel), T("long_text")), {
      value: "Todo, Done",
    });
  });
  it("checkbox, dates, percent", () => {
    assert.deepEqual(convertCellValue(true, T("checkbox"), T("text")), { value: "checked" });
    assert.deepEqual(convertCellValue("yes", T("text"), T("checkbox")), { value: true });
    assert.deepEqual(convertCellValue("2024-01-02", T("text"), T("date")), { value: "2024-01-02" });
    assert.deepEqual(convertCellValue("2024-01-02T05:00:00.000Z", T("datetime"), T("date")), { value: "2024-01-02" });
    assert.deepEqual(convertCellValue("2024-01-02", T("date"), T("text")), { value: "2024-01-02" });
    assert.deepEqual(convertCellValue(0.25, T("percent"), T("text")), { value: "25%" });
    assert.deepEqual(convertCellValue(0.25, T("percent"), T("number")), { value: 0.25 });
  });
  it("ids don't cross types", () => {
    assert.deepEqual(convertCellValue(["x"], T("collaborator"), T("text")), {});
    assert.deepEqual(convertCellValue("x", T("text"), T("attachment")), {});
  });
});
