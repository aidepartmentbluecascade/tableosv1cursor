import type { FieldSortCursor, ManualOrderCursor } from "./types.js";

export type RecordCursor = ManualOrderCursor | FieldSortCursor;

function encodeBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeRecordCursor(cursor: RecordCursor): string {
  return encodeBase64Url(JSON.stringify(cursor));
}

export function decodeRecordCursor(encoded: string): RecordCursor {
  const raw = decodeBase64Url(encoded);
  const parsed = JSON.parse(raw) as RecordCursor;
  if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) {
    throw new Error("INVALID_CURSOR");
  }
  if (parsed.kind === "manualOrder") {
    if (typeof parsed.manualOrder !== "string" || typeof parsed.id !== "string") {
      throw new Error("INVALID_CURSOR");
    }
    return parsed;
  }
  if (parsed.kind === "fieldSort") {
    if (
      typeof parsed.fieldId !== "string" ||
      typeof parsed.slot !== "number" ||
      (typeof parsed.sortKey !== "string" && typeof parsed.sortKey !== "number") ||
      typeof parsed.id !== "string"
    ) {
      throw new Error("INVALID_CURSOR");
    }
    return parsed;
  }
  throw new Error("INVALID_CURSOR");
}

/** Legacy cursor: `manualOrder|rec_xxx` */
export function decodeLegacyCursor(encoded: string): ManualOrderCursor | null {
  if (!encoded.includes("|")) return null;
  const [manualOrder, publicId] = encoded.split("|");
  if (!manualOrder || !publicId) return null;
  return { kind: "manualOrder", manualOrder, id: publicId };
}
