import assert from 'node:assert/strict'
import { test } from 'node:test'

import { THEMES, cellRecolor, contrastRatio, minimumContrast } from './theme.ts'

const { light, dark } = THEMES
const cell = (fg: number[], bg: number[]) => ({
  codepoint: 97,
  fg_r: fg[0]!,
  fg_g: fg[1]!,
  fg_b: fg[2]!,
  bg_r: bg[0]!,
  bg_g: bg[1]!,
  bg_b: bg[2]!,
})

test('default text and background swap to the other theme', () => {
  // Dark's #bfbdb6 on #0b0e14 becomes Light's #5c6166 on #f8f9fa.
  const [out] = cellRecolor(dark.terminal, light.terminal)([cell([0xbf, 0xbd, 0xb6], [0x0b, 0x0e, 0x14])])
  assert.deepEqual(out, cell([0x5c, 0x61, 0x66], [0xf8, 0xf9, 0xfa]))
})

test('ANSI colours swap, and swapping back restores the cell', () => {
  const red = cell([0xea, 0x6c, 0x73], [0x0b, 0x0e, 0x14])
  const [lit] = cellRecolor(dark.terminal, light.terminal)([red])
  assert.deepEqual(lit, cell([0xea, 0x6c, 0x6d], [0xf8, 0xf9, 0xfa]))
  assert.deepEqual(cellRecolor(light.terminal, dark.terminal)([lit!])[0], red)
})

test('colours outside the theme stay, and the input is not changed', () => {
  const custom = cell([1, 2, 3], [4, 5, 6])
  const input = [custom, cell([0xbf, 0xbd, 0xb6], [4, 5, 6])]
  const out = cellRecolor(dark.terminal, light.terminal)(input)
  assert.equal(out[0], custom)
  assert.deepEqual(out[1], cell([0x5c, 0x61, 0x66], [4, 5, 6]))
  assert.deepEqual(input[1], cell([0xbf, 0xbd, 0xb6], [4, 5, 6]))
})

test('no theme uses one colour for two cell roles, or a swap could not be undone', () => {
  for (const { terminal } of [light, dark]) {
    const { cursor: _c, cursorAccent: _a, selectionBackground: _b, selectionForeground: _f, ...cellColors } = terminal
    const values = Object.values(cellColors)
    assert.equal(new Set(values).size, values.length)
  }
})

test('minimumContrast repaints unreadable text and leaves readable text alone', () => {
  const fix = minimumContrast(light.terminal)
  const bg = [0xf8, 0xf9, 0xfa]
  // Claude Code's dark-theme white on Light's background becomes Light's text colour.
  assert.deepEqual(fix([cell([255, 255, 255], bg)]), [cell([0x5c, 0x61, 0x66], bg)])
  // Normal and dim text stay.
  const normal = cell([0x5c, 0x61, 0x66], bg)
  const dim = cell([0x82, 0x8e, 0x9f], bg)
  assert.deepEqual(fix([normal, dim]), [normal, dim])
  // White on a dark highlight stays: it reads against its own cell background.
  const inverse = cell([255, 255, 255], [0x30, 0x30, 0x30])
  assert.deepEqual(fix([inverse]), [inverse])
  // Dark text on a dark cell takes the theme background colour, which reads there.
  assert.deepEqual(fix([cell([0x20, 0x20, 0x20], [0, 0, 0])]), [cell([0xf8, 0xf9, 0xfa], [0, 0, 0])])
})

test('contrastRatio runs from 1 to 21', () => {
  assert.equal(contrastRatio([0, 0, 0], [0, 0, 0]), 1)
  assert.equal(Math.round(contrastRatio([0, 0, 0], [255, 255, 255])), 21)
})
