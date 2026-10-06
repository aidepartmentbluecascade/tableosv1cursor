import { create } from "zustand";
import type { RealtimePresenceEntry } from "@tabula/realtime-client";

interface PresenceState {
  byConnId: Map<string, RealtimePresenceEntry>;
  applyPresence: (upsert?: RealtimePresenceEntry[], remove?: string[]) => void;
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  byConnId: new Map(),
  applyPresence: (upsert, remove) => {
    set((state) => {
      const next = new Map(state.byConnId);
      if (remove) {
        for (const id of remove) next.delete(id);
      }
      if (upsert) {
        for (const entry of upsert) next.set(entry.connId, entry);
      }
      return { byConnId: next };
    });
  },
  reset: () => set({ byConnId: new Map() }),
}));

export function presenceList(): RealtimePresenceEntry[] {
  return [...usePresenceStore.getState().byConnId.values()];
}
