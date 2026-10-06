import type {
  CreateGridOptions,
  GridColumn,
  GridHandle,
  GridSelection,
} from "./types.js";

const ROW_NUM_WIDTH = 48;
const DEFAULT_ROW_HEIGHT = 32;
const DEFAULT_HEADER_HEIGHT = 36;
const DEFAULT_COL_WIDTH = 120;

const COLORS = {
  bg: "#ffffff",
  headerBg: "#f1f5f9",
  border: "#cbd5e1",
  text: "#1e293b",
  textMuted: "#64748b",
  selection: "rgba(13, 148, 136, 0.15)",
  selectionBorder: "#0d9488",
  rowAlt: "#f8fafc",
};

function normalizeSelection(sel: GridSelection): {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
} {
  const r0 = Math.min(sel.anchor.row, sel.focus.row);
  const r1 = Math.max(sel.anchor.row, sel.focus.row);
  const c0 = Math.min(sel.anchor.col, sel.focus.col);
  const c1 = Math.max(sel.anchor.col, sel.focus.col);
  return { r0, r1, c0, c1 };
}

export function createGrid(
  canvas: HTMLCanvasElement,
  options: CreateGridOptions,
): GridHandle {
  const ctxRaw = canvas.getContext("2d");
  if (!ctxRaw) {
    throw new Error("Canvas 2D context unavailable");
  }
  const ctx: CanvasRenderingContext2D = ctxRaw;

  let columns = [...options.columns];
  let rowCount = options.rowCount;
  let scrollTop = 0;
  let scrollLeft = 0;
  let selection: GridSelection | null = null;
  const rowHeight = options.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const headerHeight = options.headerHeight ?? DEFAULT_HEADER_HEIGHT;
  const frozenFirstColumn = options.frozenFirstColumn ?? false;

  const container = canvas.parentElement ?? canvas;

  const a11y = document.createElement("table");
  a11y.setAttribute("role", "grid");
  a11y.setAttribute("aria-label", "Data grid");
  a11y.style.position = "absolute";
  a11y.style.width = "1px";
  a11y.style.height = "1px";
  a11y.style.overflow = "hidden";
  a11y.style.clip = "rect(0 0 0 0)";
  container.appendChild(a11y);

  function colWidth(col: number): number {
    return columns[col]?.width ?? DEFAULT_COL_WIDTH;
  }

  function totalWidth(): number {
    let w = ROW_NUM_WIDTH;
    for (let i = 0; i < columns.length; i++) w += colWidth(i);
    return w;
  }

  function totalHeight(): number {
    return headerHeight + rowCount * rowHeight;
  }

  function resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  }

  function visibleRowRange(): { start: number; end: number } {
    const h = canvas.getBoundingClientRect().height;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight));
    const visible = Math.ceil((h - headerHeight) / rowHeight) + 2;
    const end = Math.min(rowCount - 1, start + visible);
    return { start, end };
  }

  function paint(): void {
    const w = canvas.getBoundingClientRect().width;
    const h = canvas.getBoundingClientRect().height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    const { start: startRow, end: endRow } = visibleRowRange();
    options.requestWindow(startRow, endRow);

    ctx.fillStyle = COLORS.headerBg;
    ctx.fillRect(0, 0, w, headerHeight);
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;

    ctx.fillStyle = COLORS.textMuted;
    ctx.font = "600 12px Source Sans 3, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("#", ROW_NUM_WIDTH / 2, headerHeight / 2);

    let x = ROW_NUM_WIDTH - scrollLeft;
    for (let c = 0; c < columns.length; c++) {
      const cw = colWidth(c);
      if (x + cw < ROW_NUM_WIDTH && c > 0) {
        x += cw;
        continue;
      }
      if (x > w) break;
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = "left";
      const label = columns[c]?.title ?? "";
      ctx.fillText(label, x + 8, headerHeight / 2, cw - 16);
      ctx.strokeRect(x, 0, cw, headerHeight);
      x += cw;
    }
    ctx.strokeRect(0, 0, ROW_NUM_WIDTH, headerHeight);

    for (let r = startRow; r <= endRow; r++) {
      const y = headerHeight + r * rowHeight - scrollTop;
      if (y + rowHeight < headerHeight || y > h) continue;
      ctx.fillStyle = r % 2 === 0 ? COLORS.bg : COLORS.rowAlt;
      ctx.fillRect(0, y, w, rowHeight);

      ctx.fillStyle = COLORS.textMuted;
      ctx.textAlign = "center";
      ctx.fillText(String(r + 1), ROW_NUM_WIDTH / 2, y + rowHeight / 2);

      let cx = ROW_NUM_WIDTH - scrollLeft;
      for (let c = 0; c < columns.length; c++) {
        const cw = colWidth(c);
        const drawFrozen = frozenFirstColumn && c === 0;
        const cellX = drawFrozen ? ROW_NUM_WIDTH : cx;
        if (!drawFrozen && cx + cw < ROW_NUM_WIDTH) {
          cx += cw;
          continue;
        }
        if (cellX > w) break;

        if (selection) {
          const norm = normalizeSelection(selection);
          if (
            r >= norm.r0 &&
            r <= norm.r1 &&
            c >= norm.c0 &&
            c <= norm.c1
          ) {
            ctx.fillStyle = COLORS.selection;
            ctx.fillRect(cellX, y, cw, rowHeight);
            ctx.strokeStyle = COLORS.selectionBorder;
            ctx.strokeRect(cellX + 0.5, y + 0.5, cw - 1, rowHeight - 1);
            ctx.strokeStyle = COLORS.border;
          }
        }

        ctx.fillStyle = COLORS.text;
        ctx.textAlign = "left";
        ctx.font = "400 13px Source Sans 3, Segoe UI, sans-serif";
        const text = options.getCellDisplay(r, c);
        ctx.fillText(text, cellX + 8, y + rowHeight / 2, cw - 16);
        ctx.strokeRect(cellX, y, cw, rowHeight);
        cx += cw;
      }
      ctx.strokeRect(0, y, ROW_NUM_WIDTH, rowHeight);
    }

    syncA11y(startRow, endRow);
  }

  function syncA11y(startRow: number, endRow: number): void {
    a11y.replaceChildren();
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    const th0 = document.createElement("th");
    th0.scope = "col";
    th0.textContent = "Row";
    hr.appendChild(th0);
    for (const col of columns) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = col.title;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    a11y.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (let r = startRow; r <= endRow; r++) {
      const tr = document.createElement("tr");
      const td0 = document.createElement("td");
      td0.textContent = String(r + 1);
      tr.appendChild(td0);
      for (let c = 0; c < columns.length; c++) {
        const td = document.createElement("td");
        td.textContent = options.getCellDisplay(r, c);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    a11y.appendChild(tbody);
  }

  function hitTest(clientX: number, clientY: number): { row: number; col: number } | null {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (y < headerHeight || x < ROW_NUM_WIDTH) return null;
    const row = Math.floor((y - headerHeight + scrollTop) / rowHeight);
    if (row < 0 || row >= rowCount) return null;
    let cx = ROW_NUM_WIDTH - scrollLeft;
    for (let c = 0; c < columns.length; c++) {
      const cw = colWidth(c);
      if (x >= cx && x < cx + cw) return { row, col: c };
      cx += cw;
    }
    return null;
  }

  function onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    scrollTop = Math.max(
      0,
      Math.min(totalHeight() - canvas.clientHeight, scrollTop + ev.deltaY),
    );
    scrollLeft = Math.max(
      0,
      Math.min(totalWidth() - canvas.clientWidth, scrollLeft + ev.deltaX),
    );
    paint();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (!selection) {
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(ev.key)) {
        selection = { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } };
        options.onSelectionChange?.(selection);
        paint();
        ev.preventDefault();
      }
      return;
    }
    const { focus } = selection;
    let { row, col } = focus;
    if (ev.key === "ArrowDown") row = Math.min(rowCount - 1, row + 1);
    else if (ev.key === "ArrowUp") row = Math.max(0, row - 1);
    else if (ev.key === "ArrowRight") col = Math.min(columns.length - 1, col + 1);
    else if (ev.key === "ArrowLeft") col = Math.max(0, col - 1);
    else if (ev.key === "Enter") {
      options.onEditRequest?.(focus.row, focus.col);
      return;
    } else return;

    ev.preventDefault();
    if (ev.shiftKey) {
      selection = { anchor: selection.anchor, focus: { row, col } };
    } else {
      selection = { anchor: { row, col }, focus: { row, col } };
    }
    options.onSelectionChange?.(selection);
    ensureVisible(row, col);
    paint();
  }

  function ensureVisible(row: number, col: number): void {
    const viewH = canvas.clientHeight - headerHeight;
    const rowTop = row * rowHeight;
    if (rowTop < scrollTop) scrollTop = rowTop;
    if (rowTop + rowHeight > scrollTop + viewH) {
      scrollTop = rowTop + rowHeight - viewH;
    }
    let colLeft = 0;
    for (let i = 0; i < col; i++) colLeft += colWidth(i);
    const cw = colWidth(col);
    const viewW = canvas.clientWidth - ROW_NUM_WIDTH;
    const colX = colLeft - scrollLeft;
    if (colX < 0) scrollLeft = colLeft;
    else if (colX + cw > viewW) scrollLeft = colLeft + cw - viewW;
  }

  let dragAnchor: { row: number; col: number } | null = null;

  function onPointerDown(ev: PointerEvent): void {
    canvas.focus();
    const hit = hitTest(ev.clientX, ev.clientY);
    if (!hit) return;
    dragAnchor = hit;
    selection = { anchor: hit, focus: hit };
    options.onSelectionChange?.(selection);
    paint();
  }

  function onPointerMove(ev: PointerEvent): void {
    if (!dragAnchor || ev.buttons !== 1) return;
    const hit = hitTest(ev.clientX, ev.clientY);
    if (!hit) return;
    selection = { anchor: dragAnchor, focus: hit };
    options.onSelectionChange?.(selection);
    paint();
  }

  function onPointerUp(): void {
    dragAnchor = null;
  }

  function onDblClick(ev: MouseEvent): void {
    const hit = hitTest(ev.clientX, ev.clientY);
    if (hit) options.onEditRequest?.(hit.row, hit.col);
  }

  canvas.tabIndex = 0;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.outline = "none";

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("dblclick", onDblClick);
  const ro = new ResizeObserver(() => resizeCanvas());
  ro.observe(canvas);
  resizeCanvas();

  return {
    setRowCount(count: number) {
      rowCount = count;
      paint();
    },
    setColumns(cols: GridColumn[]) {
      columns = [...cols];
      paint();
    },
    invalidate() {
      paint();
    },
    scrollToCell(row: number, col: number) {
      selection = { anchor: { row, col }, focus: { row, col } };
      options.onSelectionChange?.(selection);
      ensureVisible(row, col);
      paint();
    },
    getSelection: () => selection,
    destroy() {
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("dblclick", onDblClick);
      a11y.remove();
    },
  };
}
