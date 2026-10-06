import type { WsTicketResponse } from "./types.js";

export async function fetchWsTicket(
  apiBase = "",
  init?: RequestInit,
): Promise<WsTicketResponse> {
  const response = await fetch(`${apiBase}/v1/auth/ws-ticket`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    ...init,
  });
  if (!response.ok) {
    throw new Error(`ws-ticket failed: ${response.status}`);
  }
  return (await response.json()) as WsTicketResponse;
}

/**
 * Resolve ticket URL for same-origin dev (Vite `/ws` → `/v1/ws` proxy).
 * Do not append the backend pathname under `/ws` or the proxy rewrite doubles it.
 */
export function resolveWsUrl(ticketUrl: string, location: Location): string {
  if (ticketUrl.startsWith("ws://") || ticketUrl.startsWith("wss://")) {
    try {
      const parsed = new URL(ticketUrl);
      if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        return `${proto}//${location.host}/ws${parsed.search}`;
      }
    } catch {
      /* use as-is */
    }
    return ticketUrl;
  }
  if (ticketUrl.startsWith("/")) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}${ticketUrl}`;
  }
  return ticketUrl;
}
