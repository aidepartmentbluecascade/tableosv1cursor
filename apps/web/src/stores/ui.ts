import { create } from "zustand";

export interface GridSelection {
  recordId: string;
  fieldId: string;
}

interface UiState {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  gridSelection: GridSelection | null;
  setGridSelection: (selection: GridSelection | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  gridSelection: null,
  setGridSelection: (gridSelection) => set({ gridSelection }),
}));
