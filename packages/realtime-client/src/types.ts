export type WireCellValue = string | number | boolean | string[] | null;

export interface WsTicketResponse {
  ticket: string;
  expiresAt: string;
  url: string;
}

export type RealtimeEventMap = {
  change: RealtimeChangeFrame;
  presence: RealtimePresenceFrame;
  op_ack: RealtimeOpAckFrame;
  op_reject: RealtimeOpRejectFrame;
  resync: RealtimeResyncFrame;
  connected: { connId: string };
  disconnected: { code: number; reason: string };
};

export interface RealtimeChangeFrame {
  type: "change";
  baseId: string;
  seq: number;
  tableId?: string;
  kind?: string;
  ops: Array<{
    op: string;
    recordId: string;
    fieldId: string;
    value?: WireCellValue;
  }>;
}

export interface RealtimePresenceUser {
  id: string;
  name: string;
  avatarUrl?: string;
}

export interface RealtimePresenceEntry {
  connId: string;
  user: RealtimePresenceUser;
  viewId?: string;
  color?: string;
}

export interface RealtimePresenceFrame {
  type: "presence";
  baseId: string;
  full?: boolean;
  upsert?: RealtimePresenceEntry[];
  remove?: string[];
}

export interface RealtimeOpAckFrame {
  type: "op_ack";
  baseId: string;
  clientMutationId: string;
  seq: number;
  recordVersions?: Record<string, number>;
}

export interface RealtimeOpRejectFrame {
  type: "op_reject";
  baseId: string;
  clientMutationId: string;
  code: string;
  detail?: string;
}

export interface RealtimeResyncFrame {
  type: "resync_required";
  baseId: string;
  reason: string;
  headSeq?: number;
}

export interface CellMutation {
  op: "setCell";
  recordId: string;
  fieldId: string;
  value: WireCellValue;
}

export interface SendOpMutation {
  clientMutationId: string;
  kind: "cells";
  tableId: string;
  ops: CellMutation[];
}

export type RealtimeListener<K extends keyof RealtimeEventMap> = (
  payload: RealtimeEventMap[K],
) => void;
