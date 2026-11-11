// Where the views sit in the window: every analysis's view fills it, and the analysis strip takes a band along the
// bottom or down the left. Pure: main applies the rectangles.
import { isStripShown } from './strip.ts'
import type { StripPrefs } from './strip.ts'

export type Rect = { x: number; y: number; width: number; height: number }
/** The strip's rectangle, or undefined while it is hidden; `views` is the rectangle of every analysis's view. */
export type Frame = { strip: Rect | undefined; views: Rect }

/** The strip's height along the bottom, or its width down the left, in CSS pixels. */
export const STRIP_THICKNESS = 28

export function frameFor(content: { width: number; height: number }, prefs: StripPrefs, openCount: number): Frame {
  const { width, height } = content
  if (!isStripShown(prefs, openCount)) return { strip: undefined, views: { x: 0, y: 0, width, height } }
  if (prefs.side === 'left') {
    const stripWidth = Math.min(STRIP_THICKNESS, width)
    return { strip: { x: 0, y: 0, width: stripWidth, height }, views: { x: stripWidth, y: 0, width: width - stripWidth, height } }
  }
  const viewsHeight = Math.max(0, height - STRIP_THICKNESS)
  return { strip: { x: 0, y: viewsHeight, width, height: STRIP_THICKNESS }, views: { x: 0, y: 0, width, height: viewsHeight } }
}
