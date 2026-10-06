import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenApiDocument, OPENAPI_PATH_KEYS } from "./openapi.js";

test("buildOpenApiDocument includes main MVP paths", () => {
  const doc = buildOpenApiDocument("http://localhost:3000");
  for (const path of OPENAPI_PATH_KEYS) {
    assert.ok(doc.paths[path], `missing OpenAPI path ${path}`);
  }
  assert.equal(doc.openapi, "3.0.3");
});
