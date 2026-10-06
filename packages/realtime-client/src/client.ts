import { fetchWsTicket, resolveWsUrl } from "./ticket.js";
import type {
  RealtimeChangeFrame,
  RealtimeEventMap,
  RealtimeListener,
  RealtimeOpAckFrame,
  RealtimeOpRejectFrame,
  RealtimePresenceFrame,
  RealtimeResyncFrame,
  SendOpMutation,
} from "./types.js";

export interface RealtimeClientOptions {
  apiBase?: string;
  /** Override ticket fetch (testing). */
  getTicket?: () => Promise<{ ticket: string; url: string }>;
  maxBackoffMs?: number;
}

type Frame =
  | RealtimeChangeFrame
  | RealtimePresenceFrame
  | RealtimeOpAckFrame
  | RealtimeOpRejectFrame
  | RealtimeResyncFrame
  | { type: string; [key: string]: unknown };

export class RealtimeClient {
  private readonly apiBase: string;
  private readonly getTicket: () => Promise<{ ticket: string; url: string }>;
  private readonly maxBackoffMs: number;
  private socket: WebSocket | null = null;
  private listeners: {
    [K in keyof RealtimeEventMap]?: Set<RealtimeListener<K>>;
  } = {};
  private subscribedBaseId: string | null = null;
  private afterSeq = 0;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ridCounter = 0;

  constructor(options: RealtimeClientOptions = {}) {
    this.apiBase = options.apiBase ?? "";
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.getTicket =
      options.getTicket ??
      (async () => {
        const t = await fetchWsTicket(this.apiBase);
        return { ticket: t.ticket, url: t.url };
      });
  }

  on<K extends keyof RealtimeEventMap>(
    event: K,
    listener: RealtimeListener<K>,
  ): () => void {
    const set =
      (this.listeners[event] as Set<RealtimeListener<K>> | undefined) ??
      new Set<RealtimeListener<K>>();
    set.add(listener);
    this.listeners[event] = set as (typeof this.listeners)[K];
    return () => {
      set.delete(listener);
    };
  }

  getAfterSeq(): number {
    return this.afterSeq;
  }

  setAfterSeq(seq: number): void {
    this.afterSeq = seq;
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    await this.openSocket();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, "client disconnect");
    this.socket = null;
  }

  subscribeBase(baseId: string, sinceSeq?: number): void {
    this.subscribedBaseId = baseId;
    if (sinceSeq !== undefined) this.afterSeq = sinceSeq;
    this.send({
      type: "subscribe",
      baseId,
      afterSeq: this.afterSeq,
    });
  }

  sendOp(baseId: string, _schemaVersion: number, mutations: SendOpMutation[]): void {
    for (const mutation of mutations) {
      for (const cellOp of mutation.ops) {
        this.send({
          type: "op",
          baseId,
          tableId: mutation.tableId,
          recordId: cellOp.recordId,
          fieldId: cellOp.fieldId,
          value: cellOp.value,
          clientMutationId: mutation.clientMutationId,
        });
      }
    }
  }

  private emit<K extends keyof RealtimeEventMap>(
    event: K,
    payload: RealtimeEventMap[K],
  ): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const fn of set) {
      fn(payload);
    }
  }

  private nextRid(): string {
    this.ridCounter += 1;
    return `r${this.ridCounter}`;
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    const delay = Math.min(
      1000 * 2 ** this.reconnectAttempt,
      this.maxBackoffMs,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }

  private async openSocket(): Promise<void> {
    try {
      const { ticket, url } = await this.getTicket();
      const wsUrl = resolveWsUrl(url, globalThis.location);
      const sep = wsUrl.includes("?") ? "&" : "?";
      const fullUrl = `${wsUrl}${sep}ticket=${encodeURIComponent(ticket)}`;
      const socket = new WebSocket(fullUrl, "tabula.v1");
      this.socket = socket;

      socket.addEventListener("open", () => {
        this.reconnectAttempt = 0;
      });

      socket.addEventListener("message", (ev) => {
        this.handleMessage(String(ev.data));
      });

      socket.addEventListener("close", (ev) => {
        this.emit("disconnected", { code: ev.code, reason: ev.reason });
        this.socket = null;
        if (!this.closedByUser) this.scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        /* close handler runs reconnect */
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private handleMessage(raw: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }

    switch (frame.type) {
      case "hello":
      case "authed": {
        const connId = String(
          (frame as { connId?: string }).connId ?? `c_${this.nextRid()}`,
        );
        this.emit("connected", { connId });
        if (this.subscribedBaseId) {
          this.subscribeBase(this.subscribedBaseId, this.afterSeq);
        }
        break;
      }
      case "change": {
        const change = frame as RealtimeChangeFrame;
        if (change.seq > this.afterSeq) this.afterSeq = change.seq;
        this.emit("change", change);
        break;
      }
      case "presence":
        this.emit("presence", frame as RealtimePresenceFrame);
        break;
      case "op_ack": {
        const ack = frame as RealtimeOpAckFrame;
        if (ack.seq > this.afterSeq) this.afterSeq = ack.seq;
        this.emit("op_ack", ack);
        break;
      }
      case "op_reject":
        this.emit("op_reject", frame as RealtimeOpRejectFrame);
        break;
      case "resync_required":
        this.emit("resync", frame as RealtimeResyncFrame);
        break;
      default:
        break;
    }
  }
}
