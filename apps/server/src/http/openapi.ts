export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  servers?: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
}

/** Minimal OpenAPI 3.0 document for core MVP routes. */
export function buildOpenApiDocument(apiUrl: string): OpenApiDocument {
  const serverUrl = apiUrl.replace(/\/$/, "");

  return {
    openapi: "3.0.3",
    info: {
      title: "Tabula API",
      version: "0.1.0-mvp",
    },
    paths: {
      "/v1/auth/signup": {
        post: {
          tags: ["auth"],
          summary: "Create account",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password", "name"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string", minLength: 8 },
                    name: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Created" } },
        },
      },
      "/v1/auth/login": {
        post: {
          tags: ["auth"],
          summary: "Sign in",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/auth/me": {
        get: {
          tags: ["auth"],
          summary: "Current user",
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/bases": {
        get: {
          tags: ["bases"],
          summary: "List bases",
          responses: { "200": { description: "OK" } },
        },
        post: {
          tags: ["bases"],
          summary: "Create base",
          responses: { "201": { description: "Created" } },
        },
      },
      "/v1/bases/{baseId}/tables/{tableId}/records": {
        post: {
          tags: ["records"],
          summary: "Create record",
          parameters: [
            { name: "baseId", in: "path", required: true, schema: { type: "string" } },
            { name: "tableId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "201": { description: "Created" } },
        },
      },
      "/v1/bases/{baseId}/tables/{tableId}/records/batch": {
        post: {
          tags: ["records"],
          summary: "Batch create records",
          parameters: [
            { name: "baseId", in: "path", required: true, schema: { type: "string" } },
            { name: "tableId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/bases/{baseId}/query": {
        post: {
          tags: ["query"],
          summary: "Execute record query",
          parameters: [
            { name: "baseId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/billing/plan": {
        get: {
          tags: ["billing"],
          summary: "Current plan, limits, and usage",
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/billing/upgrade": {
        post: {
          tags: ["billing"],
          summary: "Upgrade organization to Team plan (in-app; no payment provider)",
          responses: { "200": { description: "OK" } },
        },
      },
      "/v1/feature-flags": {
        get: {
          tags: ["platform"],
          summary: "Evaluated feature flags",
          responses: { "200": { description: "OK" } },
        },
      },
    },
    servers: [{ url: serverUrl }],
  };
}

export const OPENAPI_PATH_KEYS = [
  "/v1/auth/signup",
  "/v1/auth/login",
  "/v1/auth/me",
  "/v1/bases",
  "/v1/bases/{baseId}/tables/{tableId}/records",
  "/v1/bases/{baseId}/tables/{tableId}/records/batch",
  "/v1/bases/{baseId}/query",
  "/v1/billing/plan",
  "/v1/billing/upgrade",
  "/v1/feature-flags",
] as const;
