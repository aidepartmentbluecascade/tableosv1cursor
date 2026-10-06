import { RecordStore } from "@tabula/record-store";
import { RealtimeClient } from "@tabula/realtime-client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { api } from "../../lib/api.ts";
import { usePresenceStore } from "../../stores/presence.ts";

export interface BaseSessionValue {
  store: RecordStore;
  realtime: RealtimeClient;
  connected: boolean;
}

const BaseSessionContext = createContext<BaseSessionValue | null>(null);

export function BaseSessionProvider({
  baseId,
  children,
  onResync,
}: {
  baseId: string;
  children: ReactNode;
  onResync?: () => void;
}) {
  const store = useMemo(() => new RecordStore(), []);
  const realtimeRef = useRef<RealtimeClient | null>(null);
  const connectedRef = useRef(false);

  if (!realtimeRef.current) {
    realtimeRef.current = new RealtimeClient({
      getTicket: async () => {
        const t = await api.wsTicket();
        return {
          ticket: t.ticket,
          url: t.url ?? "ws://127.0.0.1:3002/v1/ws",
        };
      },
    });
  }
  const realtime = realtimeRef.current;

  useEffect(() => {
    const resetPresence = usePresenceStore.getState().reset;
    resetPresence();

    const offConnected = realtime.on("connected", () => {
      connectedRef.current = true;
      realtime.subscribeBase(baseId, store.getSnapshot().lastSeq);
    });

    const offChange = realtime.on("change", (frame) => {
      const payload: import("@tabula/record-store").ServerChangePayload = {
        seq: frame.seq,
        ops: frame.ops
          .filter((o) => o.op === "setCell" || o.op === "setComputed")
          .map((o) => ({
            op: o.op as "setCell" | "setComputed",
            recordId: o.recordId,
            fieldId: o.fieldId,
            value: o.value ?? null,
          })),
      };
      if (frame.tableId) payload.tableId = frame.tableId;
      if (frame.kind) payload.kind = frame.kind;
      store.applyServerOp(payload);
    });

    const offAck = realtime.on("op_ack", (ack) => {
      const versions = ack.recordVersions;
      const recordId = versions ? Object.keys(versions)[0] : undefined;
      const version = recordId ? versions?.[recordId] : undefined;
      store.ack(
        ack.clientMutationId,
        recordId && version !== undefined
          ? { recordId, version }
          : undefined,
      );
    });

    const offReject = realtime.on("op_reject", (rej) => {
      store.reject(rej.clientMutationId);
    });

    const offPresence = realtime.on("presence", (p) => {
      usePresenceStore.getState().applyPresence(p.upsert, p.remove);
    });

    const offResync = realtime.on("resync", () => {
      onResync?.();
    });

    void realtime.connect().then(() => {
      realtime.subscribeBase(baseId, store.getSnapshot().lastSeq);
    });

    return () => {
      offConnected();
      offChange();
      offAck();
      offReject();
      offPresence();
      offResync();
      realtime.disconnect();
      resetPresence();
    };
  }, [baseId, onResync, realtime, store]);

  const value = useMemo(
    (): BaseSessionValue => ({
      store,
      realtime,
      connected: connectedRef.current,
    }),
    [store, realtime],
  );

  return (
    <BaseSessionContext.Provider value={value}>
      {children}
    </BaseSessionContext.Provider>
  );
}

export function useBaseSession(): BaseSessionValue {
  const ctx = useContext(BaseSessionContext);
  if (!ctx) {
    throw new Error("useBaseSession requires BaseSessionProvider");
  }
  return ctx;
}
