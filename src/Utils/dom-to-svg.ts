// ============================================================
// DOM-to-SVG Converter — high-fidelity layout snapshot
//
// Strategy:
//  1. Walk every DOM node depth-first.
//  2. For each element, read getBoundingClientRect + getComputedStyle.
//  3. Emit SVG primitives: rect (backgrounds/borders), text (all
//     visual lines of each Text node), image, and g (groups).
//  4. Text nodes use Range character-by-character scan to map each
//     visual line to its actual substring — this is what makes
//     text wrap correctly in the SVG output.
//
// ============================================================

export interface DomToSVGOptions {
  backgroundColor?: string
  includeBackground?: boolean
  /** Scale factor applied to all coordinates (default 1) */
  scale?: number
  /** Maximum unscaled height in pixels to scan and render into the SVG (useful for thumbnails). Elements and lines below this cutoff are omitted. */
  maxHeight?: number
}

export interface SVGLayerInfo {
  id: string
  tag: string
  depth: number
  x: number
  y: number
  width: number
  height: number
  type: 'image' | 'iframe' | 'audio' | 'background' | 'border' | 'group' | 'text'
  text?: string
}

export interface DomToSVGResult {
  svg: string
  width: number
  height: number
  layerCount: number
  layers: SVGLayerInfo[]
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

export function domToSVG(root: HTMLElement, options: DomToSVGOptions = {}): string {
  return domToSVGResult(root, options).svg
}

/**
 * Very large documents mark their preview `data-bb-contain`: each top-level
 * block then skips style and layout while it is off screen, and a skipped block
 * reports an ESTIMATED size and no geometry for its descendants. This reads
 * geometry, so it lifts that containment on the blocks it needs and returns a
 * function that puts it back.
 *
 * With `maxHeight` only the blocks that make up that band are lifted (their
 * positions follow from the ones before them, all lifted in order); without it
 * the whole document is, which is what a full export needs.
 */
function liftBlockContainment(root: HTMLElement, maxHeight?: number): () => void {
  if (!root.hasAttribute('data-bb-contain')) return () => {}
  const lifted: HTMLElement[] = []
  let total = 0
  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLElement)) continue
    child.style.contentVisibility = 'visible'
    lifted.push(child)
    if (maxHeight !== undefined) {
      total += child.getBoundingClientRect().height
      if (total >= maxHeight) break
    }
  }
  return () => {
    for (const child of lifted) child.style.contentVisibility = ''
  }
}

export function domToSVGResult(
  root: HTMLElement,
  options: DomToSVGOptions = {},
): DomToSVGResult {
  const { backgroundColor = "#0d0d0d", includeBackground = true, scale = 1, maxHeight } = options

  // Geometry of blocks that skip layout is an estimate: lift that first.
  const restoreContainment = liftBlockContainment(root, maxHeight)

  // OPTIMIZATION & FIX: Remove visual interaction artifacts before measuring.
  // We strip the cursor-highlight class synchronously so getComputedStyle reads the pure colors.
  const highlightedElements = Array.from(root.querySelectorAll('.cursor-highlight'))
  highlightedElements.forEach(el => el.classList.remove('cursor-highlight'))

  // FIX: Force all spoilerboxes and boxes to be OPEN before taking rootRect so their content is measured.
  // Otherwise, closed <details> elements will return garbage coordinates for their hidden children,
  // causing overlapping text in the SVG output, AND the rootRect height will be too small.
  //
  // Only the ones that START inside the cut: with `maxHeight` everything below it
  // is discarded anyway, and opening a `<details>` invalidates layout, so opening
  // every box of a very large document re-laid it out twice (here and on restore)
  // to draw its first 600px. A `<details>` can only grow DOWNWARD, so one that
  // starts below the cut cannot move into it. Hidden children measure as zero,
  // which counts as "inside" and keeps nested boxes of an opened parent working.
  // All rects are read BEFORE the first write, so this is one layout, not N.
  const allClosedDetails = Array.from(root.querySelectorAll('details:not([open])'))
  let closedDetails = allClosedDetails
  if (maxHeight) {
    const top = root.getBoundingClientRect().top
    closedDetails = allClosedDetails.filter((el) => {
      const r = el.getBoundingClientRect()
      // An empty rect is a box inside a closed parent, not one below the cut.
      return (r.width === 0 && r.height === 0) || r.top - top <= maxHeight
    })
  }
  closedDetails.forEach(el => el.setAttribute('open', ''))

  const rootRect = root.getBoundingClientRect()
  const unscaledH = maxHeight ? Math.min(rootRect.height, maxHeight) : rootRect.height
  const W = Math.ceil(rootRect.width * scale)
  const H = Math.ceil(unscaledH * scale)

  if (W < 4 || H < 4) {
    // RESTORE on error
    highlightedElements.forEach(el => el.classList.add('cursor-highlight'))
    closedDetails.forEach(el => el.removeAttribute('open'))
    restoreContainment()
    throw new Error(
      "Preview element has no visible dimensions. Make sure it is rendered and visible.",
    )
  }

  try {
    const state: WalkState = { rootRect, scale, parts: [], layerCount: 0, layersList: [], maxHeight }

    const fontFamilies = collectFontFamilies(root, maxHeight, rootRect.top)

  const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  state.parts.push(svgOpen)

  if (fontFamilies.size > 0) {
    const families = Array.from(fontFamilies)
      .map((f) => encodeURIComponent(f))
      .join("|")
    state.parts.push(
      `  <defs>`,
      `    <style>@import url('https://fonts.googleapis.com/css2?family=${families}&amp;display=swap');</style>`,
      `  </defs>`,
    )
  }

  if (includeBackground) {
    state.parts.push(
      `  <rect id="background" x="0" y="0" width="${W}" height="${H}" fill="${escapeXml(backgroundColor)}" />`,
    )
    state.layersList.push({
      id: "background",
      tag: "rect",
      depth: 0,
      x: 0,
      y: 0,
      width: W,
      height: H,
      type: "background",
    })
    state.layerCount++
  }

    walkElement(root, state, 1)

    state.parts.push("</svg>")

    return {
      svg: state.parts.join("\n"),
      width: W,
      height: H,
      layerCount: state.layerCount,
      layers: state.layersList,
    }
  } finally {
    // RESTORE: Put the highlight and closed states back so the user doesn't see it blink
    highlightedElements.forEach(el => el.classList.add('cursor-highlight'))
    closedDetails.forEach(el => el.removeAttribute('open'))
    restoreContainment()
  }
}

// ────────────────────────────────────────────────────────────
// Internal walk state
// ────────────────────────────────────────────────────────────

interface WalkState {
  rootRect: DOMRect
  scale: number
  parts: string[]
  layerCount: number
  layersList: SVGLayerInfo[]
  maxHeight?: number
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function px(value: number): string {
  return value.toFixed(2)
}

function ind(depth: number): string {
  return "  ".repeat(Math.min(depth, 12))
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function colorToHex(color: string): string {
  if (!color) return "#000000"
  if (color.startsWith("#")) return color
  const m = color.match(/rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/)
  if (!m) return color
  const r = Math.round(parseFloat(m[1]))
  const g = Math.round(parseFloat(m[2]))
  const b = Math.round(parseFloat(m[3]))
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
}

function extractAlpha(color: string): number {
  if (!color) return 1
  const m = color.match(/rgba\(\d+(?:\.\d+)?,\s*\d+(?:\.\d+)?,\s*\d+(?:\.\d+)?,\s*(\d+(?:\.\d+)?)/)
  if (m) return parseFloat(m[1])
  return 1
}

function collectFontFamilies(root: HTMLElement, maxHeight?: number, rootTop = 0): Set<string> {
  const fonts = new Set<string>()
  const visit = (el: Element): void => {
    // Same cut as `walkElement`: below `maxHeight` nothing is drawn, so its fonts
    // are not needed either, and the subtree is not entered. This used to resolve
    // `getComputedStyle` for EVERY element of the document.
    if (maxHeight !== undefined && el !== root && el.getBoundingClientRect().top - rootTop > maxHeight) {
      return
    }
    // Mismo guard que walkElement: los overlays de edición del imagemap no
    // deben colar su fuente en el @import del SVG (p. ej. un tooltip con
    // font-family propia).
    if (!isImagemapOverlay(el)) {
      const cs = window.getComputedStyle(el)
      const family = cs.fontFamily?.split(",")[0]?.replace(/['"]/g, "").trim()
      if (family && family !== "sans-serif" && family !== "monospace" && family !== "serif") {
        fonts.add(family)
      }
    }
    for (const child of Array.from(el.children)) visit(child)
  }
  visit(root)
  return fonts
}

// ────────────────────────────────────────────────────────────
// Scan a text node into visual lines
// ────────────────────────────────────────────────────────────

interface VisualLine {
  text: string
  rect: DOMRect
}

/**
 * Walk character-by-character through the text node, using Range to get
 * the DOMRect of each character. Group consecutive characters that share
 * the same top-Y (within 2px tolerance) into one line, then accumulate
 * the text for that line.
 *
 * This is the key to correct text wrapping: instead of emitting the full
 * text string on the first line's rect, we emit only the characters that
 * actually appear on each visual line.
 */
function getVisualLines(textNode: Text, maxHeight?: number, rootTop?: number): VisualLine[] {
  const text = textNode.textContent ?? ""
  if (!text.trim()) return [] // Skip purely empty/whitespace nodes

  const range = document.createRange()
  range.selectNode(textNode)
  const fullRects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0)
  if (fullRects.length === 0) return []

  // If entire text node is below cutoff, skip immediately!
  if (rootTop !== undefined && maxHeight !== undefined && fullRects[0].top - rootTop > maxHeight) {
    return []
  }

  // OPTIMIZATION 1: If the entire text node fits on a single line, return immediately!
  // This skips the expensive scan for 90% of text nodes (short inline elements).
  if (fullRects.length <= 1) {
    return [{ text, rect: fullRects[0] }]
  }

  // OPTIMIZATION 2: Word-by-word scan instead of char-by-char for multi-line text.
  // 6x-10x faster because we do getClientRects per word (or whitespace group).
  const lines: VisualLine[] = []
  let lineText = ""
  let lineRect: DOMRect | null = null
  const TOLERANCE = 4 // px

  // Split into tokens: words and spaces
  const tokens = text.match(/(\s+|\S+)/g) || []
  let currentIndex = 0

  for (const token of tokens) {
    if (token === "\n") {
      currentIndex++
      continue
    }

    range.setStart(textNode, currentIndex)
    range.setEnd(textNode, currentIndex + token.length)
    currentIndex += token.length

    const rects = range.getClientRects()
    if (!rects.length) continue

    const tokenRect = rects[0]
    if (tokenRect.width === 0 && tokenRect.height === 0) continue

    if (rootTop !== undefined && maxHeight !== undefined && tokenRect.top - rootTop > maxHeight) {
      break
    }

    if (!lineRect) {
      lineRect = tokenRect
      lineText = token
    } else if (Math.abs(tokenRect.top - lineRect.top) <= TOLERANCE) {
      lineText += token
      const mergedRight = Math.max(lineRect.right, tokenRect.right)
      lineRect = new DOMRect(
        lineRect.left,
        lineRect.top,
        mergedRight - lineRect.left,
        Math.max(lineRect.height, tokenRect.height),
      )
    } else {
      lines.push({ text: lineText, rect: lineRect })
      lineRect = tokenRect
      lineText = token
    }
  }

  if (lineText && lineRect) {
    lines.push({ text: lineText, rect: lineRect })
  }

  return lines
}

// ────────────────────────────────────────────────────────────
// Element walker
// ────────────────────────────────────────────────────────────

const SKIP_TAGS = new Set(["script", "style", "noscript", "head", "meta", "title"])

/**
 * Overlays de EDICIÓN del imagemap que no deben salir en el vector exportado:
 * las áreas clicables (rectángulos invisibles de la región) y su tooltip de
 * hover. NO incluye el contenedor (`.imagemap-container`): ese guarda la
 * imagen real, que sí forma parte del contenido.
 *
 * El HTMLRenderer genera las áreas como `imagemap-area bbcode-imap-area`;
 * `bb-imagemap-area` es la clase legacy que también se salta por si algún
 * render anterior la dejó en el DOM.
 */
const IMAGEMAP_OVERLAY_CLASSES = new Set([
  "imagemap-area",
  "bbcode-imap-area",
  "bb-imagemap-area",
  "bb-imagemap-tooltip",
])

function isImagemapOverlay(el: Element): boolean {
  for (const c of el.classList) {
    if (IMAGEMAP_OVERLAY_CLASSES.has(c)) return true
  }
  return false
}

function walkElement(el: Element, state: WalkState, depth: number): void {
  const tag = el.tagName.toLowerCase()
  if (SKIP_TAGS.has(tag)) return

  // Skip interactive overlays that shouldn't be part of the vector export
  if (isImagemapOverlay(el)) return

  // Position first, style second: an element below the cut is dropped without
  // resolving its computed style. A `display: none` element has a zero rect, so
  // it is never dropped HERE and still reaches the check below, as before.
  const rect = el.getBoundingClientRect()
  const { rootRect, scale, maxHeight } = state

  const unscaledTop = rect.top - rootRect.top
  if (maxHeight !== undefined && unscaledTop > maxHeight) {
    return
  }

  const cs = window.getComputedStyle(el)
  if (cs.display === "none" || cs.visibility === "hidden") return
  const opacityVal = parseFloat(cs.opacity)
  if (opacityVal === 0) return

  const x = (rect.left - rootRect.left) * scale
  const y = (rect.top - rootRect.top) * scale
  const w = rect.width * scale
  const h = rect.height * scale
  const hasArea = w > 0.5 && h > 0.5

  const rawId = (el.id || el.className?.toString() || tag)
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .substring(0, 48) || tag
  const layerId = `${rawId}-${depth}-${state.layerCount}`
  state.layerCount++

  const opacityAttr = opacityVal < 1 ? ` opacity="${opacityVal.toFixed(2)}"` : ""

  // ── Leaf tags ──────────────────────────────────────────────

  if (tag === "img") {
    const src = (el as HTMLImageElement).src || el.getAttribute("src") || ""
    if (src && hasArea) {
      const rx = parseFloat(cs.borderRadius) || 0
      state.parts.push(
        `${ind(depth)}<image id="${layerId}"${opacityAttr} x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}" href="${escapeXml(src)}" preserveAspectRatio="xMidYMid meet"${rx > 0 ? ` clip-path="inset(0 round ${px(rx * scale)})"` : ""} />`,
      )
      state.layersList.push({
        id: layerId,
        tag: "img",
        depth,
        x,
        y,
        width: w,
        height: h,
        type: "image",
      })
    }
    return
  }

  if (tag === "iframe") {
    if (hasArea) {
      state.parts.push(
        `${ind(depth)}<rect id="${layerId}" x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}" fill="#0f0f1a" rx="6" />`,
        `${ind(depth)}<text x="${px(x + w / 2)}" y="${px(y + h / 2 + 5)}" text-anchor="middle" fill="#ff66ab" font-size="${Math.round(14 * scale)}" font-family="sans-serif">YouTube</text>`,
      )
      state.layersList.push({
        id: layerId,
        tag: "iframe",
        depth,
        x,
        y,
        width: w,
        height: h,
        type: "iframe",
      })
    }
    return
  }

  if (tag === "audio") {
    if (hasArea) {
      state.parts.push(
        `${ind(depth)}<rect id="${layerId}" x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}" fill="#1c1520" rx="6" stroke="#2e2030" stroke-width="1" />`,
        `${ind(depth)}<text x="${px(x + w / 2)}" y="${px(y + h / 2 + 5)}" text-anchor="middle" fill="#8a7a84" font-size="${Math.round(12 * scale)}" font-family="sans-serif">Audio Player</text>`,
      )
      state.layersList.push({
        id: layerId,
        tag: "audio",
        depth,
        x,
        y,
        width: w,
        height: h,
        type: "audio",
      })
    }
    return
  }

  // ── Background + borders ───────────────────────────────────

  if (hasArea) {
    const bg = cs.backgroundColor
    const hasBg = bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent"
    const rx = parseFloat(cs.borderRadius) || 0

    if (hasBg) {
      const hexBg = colorToHex(bg)
      const alpha = extractAlpha(bg)
      const fillAttr =
        alpha < 1
          ? `fill="${hexBg}" fill-opacity="${alpha.toFixed(3)}"`
          : `fill="${hexBg}"`
      state.parts.push(
        `${ind(depth)}<rect id="${layerId}-bg" x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}" ${fillAttr} rx="${px(rx * scale)}"${opacityAttr} />`,
      )
      state.layersList.push({
        id: `${layerId}-bg`,
        tag: "rect",
        depth,
        x,
        y,
        width: w,
        height: h,
        type: "background",
      })
      state.layerCount++
    }

    // Full border (all sides equal)
    const bTopW = parseFloat(cs.borderTopWidth) || 0
    const bLeftW = parseFloat(cs.borderLeftWidth) || 0
    const bRightW = parseFloat(cs.borderRightWidth) || 0
    const bBottomW = parseFloat(cs.borderBottomWidth) || 0
    const allSidesEqual =
      bTopW > 0 && bTopW === bLeftW && bTopW === bRightW && bTopW === bBottomW

    if (allSidesEqual) {
      const hexB = colorToHex(cs.borderTopColor || "#2e2030")
      const strokeW = bTopW * scale
      const ry = rx * scale
      state.parts.push(
        `${ind(depth)}<rect id="${layerId}-border" x="${px(x + strokeW / 2)}" y="${px(y + strokeW / 2)}" width="${px(w - strokeW)}" height="${px(h - strokeW)}" fill="none" stroke="${hexB}" stroke-width="${strokeW.toFixed(2)}" rx="${ry.toFixed(2)}" />`,
      )
      state.layersList.push({
        id: `${layerId}-border`,
        tag: "rect",
        depth,
        x: x + strokeW / 2,
        y: y + strokeW / 2,
        width: w - strokeW,
        height: h - strokeW,
        type: "border",
      })
      state.layerCount++
    } else if (bLeftW > 0 && bTopW === 0 && bRightW === 0 && bBottomW === 0) {
      // Left-only border (quote/notice blocks)
      const hexB = colorToHex(cs.borderLeftColor || "#2e2030")
      const lw = bLeftW * scale
      state.parts.push(
        `${ind(depth)}<line id="${layerId}-left-border" x1="${px(x + lw / 2)}" y1="${px(y)}" x2="${px(x + lw / 2)}" y2="${px(y + h)}" stroke="${hexB}" stroke-width="${lw.toFixed(2)}" />`,
      )
      state.layersList.push({
        id: `${layerId}-left-border`,
        tag: "line",
        depth,
        x: x + lw / 2,
        y,
        width: lw,
        height: h,
        type: "border",
      })
      state.layerCount++
    }
  }

  // ── Children ───────────────────────────────────────────────

  const hasChildren = el.childNodes.length > 0
  if (hasChildren) {
    state.parts.push(`${ind(depth)}<g id="${layerId}">`)
    state.layersList.push({
      id: layerId,
      tag: "g",
      depth,
      x,
      y,
      width: w,
      height: h,
      type: "group",
    })
  }

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      walkTextNode(child as Text, state, depth + 1)
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      walkElement(child as Element, state, depth + 1)
    }
  }

  if (hasChildren) {
    state.parts.push(`${ind(depth)}</g>`)
  }
}

// ────────────────────────────────────────────────────────────
// Gradient text (`background-clip: text`)
// ────────────────────────────────────────────────────────────

interface GradientStop {
  offset: number
  color: string
  opacity: number
}

interface TextGradient {
  stops: GradientStop[]
  x1: number
  y1: number
  x2: number
  y2: number
}

const GRADIENT_ANGLES: Record<string, number> = {
  "to top": 0,
  "to right": 90,
  "to bottom": 180,
  "to left": 270,
}

/** Split on commas that are not inside parentheses (`rgb(1, 2, 3)` stays whole). */
function splitTopLevel(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]
    if (ch === "(") depth++
    else if (ch === ")") depth--
    else if (ch === "," && depth === 0) {
      out.push(list.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(list.slice(start).trim())
  return out
}

/**
 * Parse a computed `linear-gradient(...)` over `box` (in SVG units).
 *
 * Computed styles always spell colours as `rgb()`/`rgba()`, so that is all the
 * stop parser reads. Anything it does not understand (radial and repeating
 * gradients, corner directions, length stops) returns null and the text is
 * drawn in its solid colour, which is what it did before gradients.
 */
function parseLinearGradient(image: string, box: DOMRect, rootRect: DOMRect, scale: number): TextGradient | null {
  const m = image.match(/^linear-gradient\(([\s\S]*)\)$/)
  if (!m) return null

  const args = splitTopLevel(m[1])
  let angle = 180 // CSS default: top to bottom
  const first = args[0]
  if (first in GRADIENT_ANGLES) {
    angle = GRADIENT_ANGLES[first]
    args.shift()
  } else if (/^-?\d+(\.\d+)?deg$/.test(first)) {
    angle = parseFloat(first)
    args.shift()
  } else if (/^to /.test(first)) {
    return null
  }

  const raw: { color: string; opacity: number; offset: number | null }[] = []
  for (const arg of args) {
    const stop = arg.match(/^(rgba?\([^)]*\))\s*(-?\d+(?:\.\d+)?%)?$/)
    if (!stop) return null
    raw.push({
      color: colorToHex(stop[1]),
      opacity: extractAlpha(stop[1]),
      offset: stop[2] ? Math.min(1, Math.max(0, parseFloat(stop[2]) / 100)) : null,
    })
  }
  if (raw.length < 2) return null

  // Stops without a position spread evenly between their positioned neighbours.
  if (raw[0].offset === null) raw[0].offset = 0
  if (raw[raw.length - 1].offset === null) raw[raw.length - 1].offset = 1
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i].offset !== null) continue
    let j = i
    while (raw[j].offset === null) j++
    const from = raw[i - 1].offset as number
    const to = raw[j].offset as number
    for (let k = i; k < j; k++) raw[k].offset = from + ((to - from) * (k - i + 1)) / (j - i + 1)
    i = j
  }

  // CSS gradient line: through the box centre, long enough to touch both corners.
  const rad = (angle * Math.PI) / 180
  const dx = Math.sin(rad)
  const dy = -Math.cos(rad)
  const w = box.width * scale
  const h = box.height * scale
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2
  const cx = (box.left - rootRect.left) * scale + w / 2
  const cy = (box.top - rootRect.top) * scale + h / 2

  return {
    stops: raw.map(s => ({ offset: s.offset as number, color: s.color, opacity: s.opacity })),
    x1: cx - dx * half,
    y1: cy - dy * half,
    x2: cx + dx * half,
    y2: cy + dy * half,
  }
}

const isClear = (color: string): boolean => color === "transparent" || /,\s*0\)$/.test(color)

/**
 * The gradient painting `parent`'s text, when there is one.
 *
 * The preview draws a plain gradient as a span with a CSS gradient background
 * clipped to its glyphs, and the glyphs themselves transparent. Their own
 * `color` says nothing about what is seen, so the gradient has to be found on
 * the element that carries it: the text's parent or a few ancestors up (a
 * `[b]` inside the gradient wraps the text in one more span).
 */
function findTextGradient(parent: HTMLElement, cs: CSSStyleDeclaration, state: WalkState): TextGradient | null {
  // Cheap gate: only text with a clear fill can be showing a background through it.
  if (!isClear(cs.getPropertyValue("-webkit-text-fill-color"))) return null

  let el: HTMLElement | null = parent
  for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
    const style = depth === 0 ? cs : window.getComputedStyle(el)
    const clip = style.getPropertyValue("background-clip") || style.getPropertyValue("-webkit-background-clip")
    if (clip !== "text") continue
    return parseLinearGradient(style.backgroundImage, el.getBoundingClientRect(), state.rootRect, state.scale)
  }
  return null
}

function gradientDef(id: string, g: TextGradient): string {
  const stops = g.stops
    .map(s => `<stop offset="${s.offset.toFixed(4)}" stop-color="${s.color}"${s.opacity < 1 ? ` stop-opacity="${s.opacity.toFixed(3)}"` : ""} />`)
    .join("")
  return `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${px(g.x1)}" y1="${px(g.y1)}" x2="${px(g.x2)}" y2="${px(g.y2)}">${stops}</linearGradient></defs>`
}

// ────────────────────────────────────────────────────────────
// Text node walker — character-scan for correct line wrapping
// ────────────────────────────────────────────────────────────

function walkTextNode(textNode: Text, state: WalkState, depth: number): void {
  const rawText = textNode.textContent ?? ""
  if (!rawText.trim()) return

  const parent = textNode.parentElement
  if (!parent) return

  const cs = window.getComputedStyle(parent)
  if (cs.display === "none" || cs.visibility === "hidden") return

  // Get correctly-split visual lines via character-scan (capped at maxHeight)
  const lines = getVisualLines(textNode, state.maxHeight, state.rootRect.top)
  if (lines.length === 0) return

  const { rootRect, scale } = state

  const gradient = findTextGradient(parent, cs, state)
  // Underline and line-through take the first stop: SVG strokes cannot reference
  // the gradient the thumbnail whitelist admits for `fill`.
  const color = gradient ? gradient.stops[0].color : colorToHex(cs.color)
  const colorAlpha = gradient ? 1 : extractAlpha(cs.color)
  const fillOpacityAttr = colorAlpha < 1 ? ` fill-opacity="${colorAlpha.toFixed(3)}"` : ""

  const fontSize = parseFloat(cs.fontSize) || 14
  const fontFamilyRaw =
    cs.fontFamily?.split(",")[0]?.replace(/['"]/g, "").trim() || "sans-serif"
  const fontFamily = escapeXml(fontFamilyRaw)
  const fontWeight = cs.fontWeight || "400"
  const fontStyleValue = cs.fontStyle || "normal"
  const textDecoration = cs.textDecorationLine || ""
  const textAlign = cs.textAlign || "left"
  const letterSpacing =
    cs.letterSpacing !== "normal" ? parseFloat(cs.letterSpacing) || 0 : 0
  const lsAttr =
    letterSpacing !== 0
      ? ` letter-spacing="${(letterSpacing * scale).toFixed(2)}"`
      : ""

  for (const line of lines) {
    if (!line.text.trim()) continue

    const lx = (line.rect.left - rootRect.left) * scale
    const ly = (line.rect.top - rootRect.top) * scale
    const lw = line.rect.width * scale
    const lh = line.rect.height * scale

    // Baseline: roughly 80% down the line box
    const baselineY = ly + fontSize * scale * 0.82

    // Anchor based on text-align
    let anchor = "start"
    let tx = lx
    if (textAlign === "center") { anchor = "middle"; tx = lx + lw / 2 }
    else if (textAlign === "right" || textAlign === "end") { anchor = "end"; tx = lx + lw }

    const textLayerId = `text-${depth}-${state.layerCount}`
    let fill = color
    if (gradient) {
      const gradientId = `${textLayerId}-gradient`
      state.parts.push(`${ind(depth)}${gradientDef(gradientId, gradient)}`)
      fill = `url(#${gradientId})`
    }
    state.parts.push(
      `${ind(depth)}<text id="${textLayerId}" x="${px(tx)}" y="${px(baselineY)}" fill="${fill}"${fillOpacityAttr} font-size="${(fontSize * scale).toFixed(2)}" font-family="${fontFamily}" font-weight="${fontWeight}" font-style="${fontStyleValue}" text-anchor="${anchor}"${lsAttr}>${escapeXml(line.text)}</text>`,
    )
    state.layersList.push({
      id: textLayerId,
      tag: "text",
      depth,
      x: lx,
      y: ly,
      width: lw,
      height: lh,
      type: "text",
      text: line.text,
    })
    state.layerCount++

    // Underline
    if (textDecoration.includes("underline")) {
      const uly = ly + fontSize * scale * 0.92 + 2
      state.parts.push(
        `${ind(depth)}<line x1="${px(lx)}" y1="${px(uly)}" x2="${px(lx + lw)}" y2="${px(uly)}" stroke="${color}" stroke-width="1" />`,
      )
    }

    // Line-through
    if (textDecoration.includes("line-through")) {
      const lty = ly + lh * 0.55
      state.parts.push(
        `${ind(depth)}<line x1="${px(lx)}" y1="${px(lty)}" x2="${px(lx + lw)}" y2="${px(lty)}" stroke="${color}" stroke-width="1" />`,
      )
    }
  }
}
