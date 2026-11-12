import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cellAt, fitGrid, reportedSize, sizeChanged } from './terminalGrid.ts'

const cell = { width: 10, height: 20 }
const grid = { cols: 80, rows: 24 }

test('a point is mapped to its 1-based cell', () => {
  assert.deepEqual(cellAt({ x: 5, y: 5 }, { left: 0, top: 0 }, cell, grid), { col: 1, row: 1 })
  assert.deepEqual(cellAt({ x: 105, y: 45 }, { left: 100, top: 40 }, cell, grid), { col: 1, row: 1 })
  assert.deepEqual(cellAt({ x: 35, y: 65 }, { left: 0, top: 0 }, cell, grid), { col: 4, row: 4 })
})

test('a point outside the grid is kept inside it', () => {
  assert.deepEqual(cellAt({ x: -50, y: -50 }, { left: 0, top: 0 }, cell, grid), { col: 1, row: 1 })
  assert.deepEqual(cellAt({ x: 5000, y: 5000 }, { left: 0, top: 0 }, cell, grid), { col: 80, row: 24 })
})

test('a box is filled with whole cells, at least 2 columns and 1 row', () => {
  assert.deepEqual(fitGrid(cell, { width: 805, height: 490 }), { cols: 80, rows: 24 })
  assert.deepEqual(fitGrid(cell, { width: 5, height: 5 }), { cols: 2, rows: 1 })
})

test('nothing fits while the cell or the box has no size', () => {
  assert.equal(fitGrid({ width: 0, height: 20 }, { width: 100, height: 100 }), undefined)
  assert.equal(fitGrid({ width: 10, height: 0 }, { width: 100, height: 100 }), undefined)
  assert.equal(fitGrid(cell, { width: 0, height: 100 }), undefined)
  assert.equal(fitGrid(cell, { width: 100, height: 0 }), undefined)
})

test('the reported size defaults to 80 by 24 and is never below 1', () => {
  assert.deepEqual(reportedSize(undefined, undefined), { cols: 80, rows: 24 })
  assert.deepEqual(reportedSize(120, 40), { cols: 120, rows: 40 })
  assert.deepEqual(reportedSize(0, -3), { cols: 1, rows: 1 })
})

test('a size counts as changed when nothing was reported or either side differs', () => {
  assert.equal(sizeChanged(undefined, grid), true)
  assert.equal(sizeChanged(grid, { cols: 80, rows: 24 }), false)
  assert.equal(sizeChanged(grid, { cols: 81, rows: 24 }), true)
  assert.equal(sizeChanged(grid, { cols: 80, rows: 25 }), true)
})
