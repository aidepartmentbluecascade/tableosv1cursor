import { useEffect, useRef, type ReactElement } from "react";
import { createGrid } from "./createGrid.js";
import type { CreateGridOptions, GridHandle } from "./types.js";

export type CanvasGridProps = CreateGridOptions & {
  className?: string;
  onReady?: (handle: GridHandle) => void;
};

export function CanvasGrid(props: CanvasGridProps): ReactElement {
  const {
    className,
    onReady,
    columns,
    rowCount,
    getCellDisplay,
    requestWindow,
    onSelectionChange,
    onEditRequest,
    frozenFirstColumn,
    rowHeight,
    headerHeight,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<GridHandle | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gridOptions: CreateGridOptions = {
      columns,
      rowCount,
      getCellDisplay,
      requestWindow,
    };
    if (onSelectionChange) gridOptions.onSelectionChange = onSelectionChange;
    if (onEditRequest) gridOptions.onEditRequest = onEditRequest;
    if (frozenFirstColumn !== undefined) {
      gridOptions.frozenFirstColumn = frozenFirstColumn;
    }
    if (rowHeight !== undefined) gridOptions.rowHeight = rowHeight;
    if (headerHeight !== undefined) gridOptions.headerHeight = headerHeight;
    const handle = createGrid(canvas, gridOptions);
    handleRef.current = handle;
    onReady?.(handle);
    return () => {
      handle.destroy();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- grid recreated when structural props change
  }, []);

  useEffect(() => {
    handleRef.current?.setColumns(columns);
  }, [columns]);

  useEffect(() => {
    handleRef.current?.setRowCount(rowCount);
  }, [rowCount]);

  useEffect(() => {
    handleRef.current?.invalidate({ all: true });
  }, [getCellDisplay]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="presentation"
      aria-hidden={false}
    />
  );
}
