import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { andGroup } from "./evaluator.js";
import { compileFilterToSql } from "./sql.js";

describe("compileFilterToSql", () => {
  it("compiles eq on jsonb slot", () => {
    const fieldSlotById = new Map([["f1", 4]]);
    const filter = andGroup([
      { kind: "condition", fieldId: "f1", op: "eq", value: "Acme" },
    ]);
    const { sql, params } = compileFilterToSql(filter, fieldSlotById);
    assert.match(sql, /cells->>'4'/);
    assert.equal(params.length, 1);
    assert.equal(params[0], "acme");
  });

  it("compiles numeric gt", () => {
    const fieldSlotById = new Map([["f1", 2]]);
    const filter = andGroup([
      { kind: "condition", fieldId: "f1", op: "gt", value: 10 },
    ]);
    const { sql, params } = compileFilterToSql(filter, fieldSlotById, {
      fieldTypeByFieldId: new Map([["f1", "number"]]),
    });
    assert.match(sql, /::double precision/);
    assert.equal(params[0], 10);
  });
});
