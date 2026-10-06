export interface GridColumn {
  id: string;
  title: string;
  width?: number;
}

export interface GridSelection {
  anchor: { row: number; col: number };
  focus: { row: number; col: number };
}

export interface GridDamage {
  rows?: Set<number>;
  all?: boolean;
}

export interface CreateGridOptions {
  columns: GridColumn[];
  rowCount: number;
  getCellDisplay: (row: number, col: number) => string;
  requestWindow: (startRow: number, endRow: number) => void;
  onSelectionChange?: (selection: GridSelection | null) => void;
  onEditRequest?: (row: number, col: number) => void;
  frozenFirstColumn?: boolean;
  rowHeight?: number;
  headerHeight?: number;
}

export interface GridHandle {
  setRowCount: (count: number) => void;
  setColumns: (columns: GridColumn[]) => void;
  invalidate: (damage?: GridDamage) => void;
  scrollToCell: (row: number, col: number) => void;
  getSelection: () => GridSelection | null;
  destroy: () => void;
}
