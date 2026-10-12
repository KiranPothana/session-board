// Where the board opens the first time, as a share of the screen it opens on, so it fits any
// screen the way it does on the Mac it was tuned on: there the floating board is 330 x 705 pt,
// flush with the right edge and its top 23% of the way down, on a usable area of 1728 x 1025;
// a regular window is 764 x 458, centred.
export const FLOATING = { width: 330 / 1728, height: 705 / 1025, top: 235 / 1025, minW: 300, maxW: 520, minH: 420, maxH: 900 }
export const REGULAR = { width: 764 / 1728, height: 458 / 1025, minW: 560, maxW: 1100, minH: 360, maxH: 760 }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// area: the screen's usable part (work area), in points: { x, y, width, height }
export function defaultFrame(area, regular = false) {
  const r = regular ? REGULAR : FLOATING
  const width = Math.round(clamp(area.width * r.width, r.minW, Math.min(r.maxW, area.width)))
  const height = Math.round(clamp(area.height * r.height, r.minH, Math.min(r.maxH, area.height)))
  if (regular) return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height }
  const y = Math.round(clamp(area.y + area.height * r.top, area.y, area.y + area.height - height))
  return { x: area.x + area.width - width, y, width, height }
}

// A frame saved on some screen, still on the screen it opens on now? (else the default is used)
export function fits(frame, area) {
  return !!frame && frame.width >= 260 && frame.height >= 60 && frame.x + 40 >= area.x && frame.y >= area.y - 1 && frame.x + frame.width - 40 <= area.x + area.width && frame.y + 40 <= area.y + area.height
}

// Which edges a point inside the window is on, for resizing from any edge or corner, as the Mac
// board: a 6 pt band on each edge, 16 pt at the corners. Collapsed, only sideways.
export const BAND = 6
export const CORNER = 16
export function edgesAt(x, y, width, height, collapsed = false) {
  let left = x < BAND, right = x > width - BAND
  let top = !collapsed && y < BAND, bottom = !collapsed && y > height - BAND
  if (left || right) {
    top = top || (!collapsed && y < CORNER)
    bottom = bottom || (!collapsed && y > height - CORNER)
  }
  if (top || bottom) {
    left = left || x < CORNER
    right = right || x > width - CORNER
  }
  const dir = (top ? 'North' : bottom ? 'South' : '') + (left ? 'West' : right ? 'East' : '')
  return dir || null
}
