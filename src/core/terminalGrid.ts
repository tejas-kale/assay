// Where a point falls in the terminal's grid of cells, and how many cells fit in a box. Pure, so the sizes the
// terminal reports to the pty can be tested without a canvas.

export type CellSize = { width: number; height: number }
export type Grid = { cols: number; rows: number }

const MIN_COLS_WHEN_FITTING = 2

/** The 1-based column and row of the cell under a point, kept inside the grid. `origin` is the grid's top-left corner. */
export function cellAt(
  point: { x: number; y: number },
  origin: { left: number; top: number },
  cell: CellSize,
  grid: Grid,
): { col: number; row: number } {
  const column = Math.floor((point.x - origin.left) / cell.width) + 1
  const row = Math.floor((point.y - origin.top) / cell.height) + 1
  return { col: Math.max(1, Math.min(grid.cols, column)), row: Math.max(1, Math.min(grid.rows, row)) }
}

/** The grid that fills `box` with `cell`s, or undefined while the cell or the box has no size yet. */
export function fitGrid(cell: CellSize, box: { width: number; height: number }): Grid | undefined {
  if (cell.width <= 0 || cell.height <= 0 || box.width <= 0 || box.height <= 0) return undefined
  return {
    cols: Math.max(MIN_COLS_WHEN_FITTING, Math.floor(box.width / cell.width)),
    rows: Math.max(1, Math.floor(box.height / cell.height)),
  }
}

/** The size to report to the pty: the library's grid, or a default while it has none, never below 1 by 1. */
export function reportedSize(cols: number | undefined, rows: number | undefined): Grid {
  return { cols: Math.max(1, cols ?? 80), rows: Math.max(1, rows ?? 24) }
}

/** Whether `now` differs from the size last reported. */
export function sizeChanged(last: Grid | undefined, now: Grid): boolean {
  return !last || last.cols !== now.cols || last.rows !== now.rows
}
