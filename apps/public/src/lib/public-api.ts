import type { TabulaError } from "@tabula/types";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

export interface PublicField {
  id: string;
  name: string;
  type: string;
}

export interface PublicRecord {
  id: string;
  version: number;
  fields: Record<string, unknown>;
}

export interface PublicSharePayload {
  kind: "table" | "form";
  title: string;
  baseId: string;
  tableId: string;
  fields: PublicField[];
  records?: PublicRecord[];
}

async function parseProblem(response: Response): Promise<TabulaError> {
  try {
    return (await response.json()) as TabulaError;
  } catch {
    return {
      code: "VALIDATION_FAILED",
      title: response.statusText,
      status: response.status,
    };
  }
}

export async function fetchShare(token: string): Promise<PublicSharePayload> {
  const response = await fetch(`${API_BASE}/v1/public/shares/${token}`);
  if (!response.ok) {
    throw new Error((await parseProblem(response)).title);
  }
  return (await response.json()) as PublicSharePayload;
}

export async function submitShareForm(
  token: string,
  fields: Record<string, unknown>,
): Promise<PublicRecord> {
  const response = await fetch(`${API_BASE}/v1/public/shares/${token}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) {
    throw new Error((await parseProblem(response)).title);
  }
  const data = (await response.json()) as { record: PublicRecord };
  return data.record;
}

/** Fallback when only share token is available for record create. */
export async function submitViaShareHeader(
  token: string,
  baseId: string,
  tableId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(
    `${API_BASE}/v1/bases/${baseId}/tables/${tableId}/records`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tabula-Share-Token": token,
      },
      body: JSON.stringify({ fields }),
    },
  );
  if (!response.ok) {
    throw new Error((await parseProblem(response)).title);
  }
}
