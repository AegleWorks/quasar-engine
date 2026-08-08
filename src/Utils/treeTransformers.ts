/**
 * Quasar — Tree Transformers
 *
 * Apply effects (gradient, grow, rainbow, central, multi) across an entire RedNode tree.
 * These functions walk the tree, track global text position,
 * and wrap each text leaf in internal effect nodes
 * with position metadata so the TagRegistry handlers produce
 * correctly interpolated output.
 *
 * DESIGN:
 *   Two-pass approach:
 *     1. Collect total text length (for normalization)
 *     2. Walk again, wrapping text nodes with effect nodes
 *
 *   Non-text nodes (img, video, audio, code blocks) are preserved unchanged.
 *   Structural nodes (box, quote, list) recurse into children.
 *   Formatting nodes (b, i, u, color) recurse — effects go INSIDE formatting.
 *
 *   Example:
 *     Input:  [box][b]Hello[/b] World[/box]
 *     Output: [box][b][gradient][b]H[/b][gradient][b]e[/b]...[/b]
 *                    [gradient] W[/gradient]...[/gradient]
 *
 *   Actually simpler — each text leaf gets its own gradient node with
 *   globalOffset metadata, and the handler does the interpolation.
 */

import { greenNode, greenLeaf } from '../Syntax/GreenNode'
import { RedNode } from '../Syntax/RedNode'
import type { Easing } from './color'
import { mixMultiple, hslToHex, ease, clamp } from './color'

// ─── Types ──────────────────────────────────────────────────

export interface GradientEffect {
  kind: 'gradient'
  colors: string[]
  unit?: 'character' | 'word' | 'line'
  easing?: Easing
}

export interface GrowEffect {
  kind: 'grow'
  min?: number
  max?: number
  cycles?: number
}

export interface RainbowEffect {
  kind: 'rainbow'
  saturation?: number
  lightness?: number
  spread?: number
  offset?: number
}

export interface CentralGradientEffect {
  kind: 'central_gradient'
  colors: string[]
  unit?: 'character' | 'word' | 'line'
  easing?: Easing
}

export interface MultiGradientEffect {
  kind: 'multi_gradient'
  colors: string[]
  mode?: 'wave' | 'pulse'
  unit?: 'character' | 'word' | 'line'
  easing?: Easing
}

export type TreeEffect = GradientEffect | GrowEffect | RainbowEffect | CentralGradientEffect | MultiGradientEffect

// ─── Kinds that should NOT be recursed into ─────────────────
// These are leaf containers that hold content but not text nodes
// we'd want to colorize.

const LEAF_KINDS = new Set([
  'image', 'video', 'audio', 'imagemap',
  'code', 'inline_code',
])

// ─── Helpers ────────────────────────────────────────────────

/**
 * Count total plain text length across all text leaves in a tree.
 */
export function countTextLength(node: RedNode): number {
  if (node.kind === 'text') return node.text.length
  if (LEAF_KINDS.has(node.kind)) return 0
  return node.children.reduce((sum: number, child: RedNode) => sum + countTextLength(child), 0)
}

/**
 * Deep-clone a RedNode tree (preserves kind and metadata, creates new nodes).
 */
function cloneTree(node: RedNode): RedNode {
  const cloned = new RedNode(node.green, {
    kind: node.kind,
    metadata: { ...node.metadata },
  })
  for (const child of node.children) {
    cloned.appendChild(cloneTree(child))
  }
  return cloned
}

/**
 * Wrap a text node's characters/words in effect nodes,
 * returning an array of nodes that replace the original text node.
 *
 * For character unit: returns N gradient nodes (one per char)
 *   Each node: gradient(metadata: {globalOffset, documentLength}) → text(char)
 *
 * For word unit: returns N gradient nodes (one per word)
 *   Each node: gradient(metadata: {globalOffset, documentLength}) → text(word)
 */
function wrapTextWithGradient(
  node: RedNode,
  colors: string[],
  globalOffset: number,
  documentLength: number,
  unit: string,
  easing: Easing,
): RedNode {
  const text = node.text
  if (!text) return node

  const segments = unit === 'word'
    ? text.split(/(\s+)/).filter((s: string) => s.length > 0)
    : unit === 'line'
      ? text.split('\n')
      : [...text]

  if (segments.length === 0) return node

  // Create a parent group node to hold all the segments
  const groupGreen = greenLeaf('group', '')
  const group = new RedNode(groupGreen, { kind: 'group' })

  let pos = globalOffset
  for (const seg of segments) {
    const textGreen = greenLeaf('text', seg)
    const textRed = new RedNode(textGreen, { kind: 'text' })

    if (/^\s+$/.test(seg)) {
      group.appendChild(textRed)
    } else {
      const gradGreen = greenLeaf('gradient', '')
      const gradRed = new RedNode(gradGreen, {
        kind: 'gradient',
        metadata: {
          colors,
          unit,
          easing,
          globalOffset: pos,
          documentLength,
        },
      })
      gradRed.appendChild(textRed)
      group.appendChild(gradRed)
    }
    pos += seg.length
  }

  return group
}

/**
 * Wrap a text node's characters in grow nodes.
 */
function wrapTextWithGrow(
  node: RedNode,
  min: number,
  max: number,
  cycles: number,
  globalOffset: number,
  documentLength: number,
): RedNode {
  const text = node.text
  if (!text) return node

  const chars = [...text]
  if (chars.length === 0) return node

  const groupGreen = greenLeaf('group', '')
  const group = new RedNode(groupGreen, { kind: 'group' })

  let pos = globalOffset
  for (const ch of chars) {
    const textGreen = greenLeaf('text', ch)
    const textRed = new RedNode(textGreen, { kind: 'text' })

    if (/^\s+$/.test(ch)) {
      group.appendChild(textRed)
    } else {
      const growGreen = greenLeaf('grow', '')
      const growRed = new RedNode(growGreen, {
        kind: 'grow',
        metadata: { min, max, cycles, globalOffset: pos, documentLength },
      })
      growRed.appendChild(textRed)
      group.appendChild(growRed)
    }
    pos += ch.length
  }

  return group
}

/**
 * Wrap a text node's characters in rainbow nodes.
 */
function wrapTextWithRainbow(
  node: RedNode,
  saturation: number,
  lightness: number,
  spread: number,
  offset: number,
  globalOffset: number,
  documentLength: number,
): RedNode {
  const text = node.text
  if (!text) return node

  const chars = [...text]
  if (chars.length === 0) return node

  const groupGreen = greenLeaf('group', '')
  const group = new RedNode(groupGreen, { kind: 'group' })

  let pos = globalOffset
  for (const ch of chars) {
    const textGreen = greenLeaf('text', ch)
    const textRed = new RedNode(textGreen, { kind: 'text' })

    if (/^\s+$/.test(ch)) {
      group.appendChild(textRed)
    } else {
      const rainbowGreen = greenLeaf('rainbow', '')
      const rainbowRed = new RedNode(rainbowGreen, {
        kind: 'rainbow',
        metadata: {
          saturation,
          lightness,
          spread,
          offset,
          globalOffset: pos,
          documentLength,
        },
      })
      rainbowRed.appendChild(textRed)
      group.appendChild(rainbowRed)
    }
    pos += ch.length
  }

  return group
}

/**
 * Wrap a text node's characters in gradient nodes for central mode.
 * Central mode: gradient from center outward (mirrored).
 */
function wrapTextWithCentralGradient(
  node: RedNode,
  colors: string[],
  globalOffset: number,
  documentLength: number,
  unit: string,
  easing: Easing,
): RedNode {
  const text = node.text
  if (!text) return node

  const segments = unit === 'word'
    ? text.split(/(\s+)/).filter((s: string) => s.length > 0)
    : unit === 'line'
      ? text.split('\n')
      : [...text]

  if (segments.length === 0) return node

  const groupGreen = greenLeaf('group', '')
  const group = new RedNode(groupGreen, { kind: 'group' })

  // For central mode, we mirror from the center
  const mid = Math.floor(segments.length / 2)

  let pos = globalOffset
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const textGreen = greenLeaf('text', seg)
    const textRed = new RedNode(textGreen, { kind: 'text' })

    if (/^\s+$/.test(seg)) {
      group.appendChild(textRed)
    } else {
      // Calculate position from center (0 at center, 1 at edges)
      let t: number
      if (i <= mid) {
        t = mid === 0 ? 0 : i / mid
      } else {
        t = segments.length - 1 - mid === 0 ? 0 : (i - mid) / (segments.length - 1 - mid)
      }

      const easedT = ease(clamp(t), easing)
      // For central mode, we use the colors array in forward then reverse
      const colorArr = i <= mid ? colors : [...colors].reverse()
      const color = mixMultiple(colorArr, easedT)

      const gradGreen = greenLeaf('gradient', '')
      const gradRed = new RedNode(gradGreen, {
        kind: 'gradient',
        metadata: {
          colors: [color, color], // Single color interpolation
          unit,
          easing,
          globalOffset: pos,
          documentLength,
        },
      })
      gradRed.appendChild(textRed)
      group.appendChild(gradRed)
    }
    pos += seg.length
  }

  return group
}

/**
 * Wrap a text node's characters in gradient nodes for multi mode.
 * Multi mode: wave or pulse patterns across the text.
 */
function wrapTextWithMultiGradient(
  node: RedNode,
  colors: string[],
  mode: 'wave' | 'pulse',
  globalOffset: number,
  documentLength: number,
  unit: string,
  easing: Easing,
): RedNode {
  const text = node.text
  if (!text) return node

  const segments = unit === 'word'
    ? text.split(/(\s+)/).filter((s: string) => s.length > 0)
    : unit === 'line'
      ? text.split('\n')
      : [...text]

  if (segments.length === 0) return node

  const groupGreen = greenLeaf('group', '')
  const group = new RedNode(groupGreen, { kind: 'group' })

  let pos = globalOffset
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const textGreen = greenLeaf('text', seg)
    const textRed = new RedNode(textGreen, { kind: 'text' })

    if (/^\s+$/.test(seg)) {
      group.appendChild(textRed)
    } else {
      let t: number
      if (mode === 'wave') {
        // Wave pattern: sine wave across the text
        const wavePosition = Math.sin((i / segments.length) * Math.PI * 3) * 0.5 + 0.5
        t = ease(wavePosition, easing)
      } else {
        // Pulse pattern: repeating gradient segments
        const pulseLength = Math.max(5, Math.floor(segments.length / 4))
        const pulsePosition = (i % pulseLength) / pulseLength
        t = ease(pulsePosition, easing)
      }

      const color = mixMultiple(colors, t)

      const gradGreen = greenLeaf('gradient', '')
      const gradRed = new RedNode(gradGreen, {
        kind: 'gradient',
        metadata: {
          colors: [color, color], // Single color interpolation
          unit,
          easing,
          globalOffset: pos,
          documentLength,
        },
      })
      gradRed.appendChild(textRed)
      group.appendChild(gradRed)
    }
    pos += seg.length
  }

  return group
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Apply a gradient effect across an entire RedNode tree.
 *
 * The gradient is computed across ALL text content in the tree,
 * so color transitions span across structural boundaries:
 *
 *   [b]Hello[/b] World  →  [b][color=#FF0000]H[/color]...[/b][color=#00FF00]W[/color]...
 *
 * @param root    The RedNode tree to transform
 * @param colors  Array of hex colors to interpolate across
 * @param options.unit      Split unit: 'character' (default), 'word', or 'line'
 * @param options.easing    Easing function: 'linear' (default), 'easeIn', 'easeOut', 'easeInOut'
 * @returns A new RedNode tree with gradient applied
 */
export function applyGradient(
  root: RedNode,
  colors: string[],
  options?: {
    unit?: 'character' | 'word' | 'line'
    easing?: Easing
  },
): RedNode {
  return RedNode.allowMutation(() => {
    const unit = options?.unit || 'character'
    const easing = options?.easing || 'linear'

    // Pass 1: count total text length
    const totalLength = countTextLength(root)
    if (totalLength === 0) return cloneTree(root)

    // Pass 2: walk and wrap text nodes
    let globalPos = 0

    function walk(node: RedNode): RedNode {
      // Text leaf — wrap in gradient
      if (node.kind === 'text') {
        const result = wrapTextWithGradient(node, colors, globalPos, totalLength, unit, easing)
        globalPos += node.text.length
        return result
      }

      // Leaf containers (img, code, etc.) — preserve unchanged
      if (LEAF_KINDS.has(node.kind)) {
        return node
      }

      // Structural/formatting nodes — recurse into children
      const cloned = cloneTree(node)
      cloned.children = []
      for (const child of node.children) {
        cloned.appendChild(walk(child))
      }
      return cloned
    }

    return walk(root)
  })
}

/**
 * Apply a grow (size wave) effect across an entire RedNode tree.
 *
 * Size oscillates via sine wave across ALL text content:
 *
 *   [b]Hello[/b] World  →  [b][size=90]H[/size]...[/b][size=160]W[/size]...
 *
 * @param root    The RedNode tree to transform
 * @param options.min       Minimum size % (default: 90)
 * @param options.max       Maximum size % (default: 160)
 * @param options.cycles    Number of sine cycles across text (default: 1)
 * @returns A new RedNode tree with grow applied
 */
export function applyGrow(
  root: RedNode,
  options?: {
    min?: number
    max?: number
    cycles?: number
  },
): RedNode {
  return RedNode.allowMutation(() => {
    const min = options?.min ?? 90
    const max = options?.max ?? 160
    const cycles = options?.cycles ?? 1

    const totalLength = countTextLength(root)
    if (totalLength === 0) return cloneTree(root)

    let globalPos = 0

    function walk(node: RedNode): RedNode {
      if (node.kind === 'text') {
        const result = wrapTextWithGrow(node, min, max, cycles, globalPos, totalLength)
        globalPos += node.text.length
        return result
      }

      if (LEAF_KINDS.has(node.kind)) {
        return node
      }

      const cloned = cloneTree(node)
      cloned.children = []
      for (const child of node.children) {
        cloned.appendChild(walk(child))
      }
      return cloned
    }

    return walk(root)
  })
}

/**
 * Apply a rainbow effect across an entire RedNode tree.
 *
 * Hue rotates across ALL text content using HSL color space:
 *
 *   [b]Hello[/b] World  →  [b][color=#FF0000]H[/color]...[/b][color=#00FF00]W[/color]...
 *
 * @param root    The RedNode tree to transform
 * @param options.saturation  Saturation 0-100 (default: 80)
 * @param options.lightness   Lightness 0-100 (default: 60)
 * @param options.spread      Hue spread in degrees (default: 300)
 * @param options.offset      Starting hue offset in degrees (default: 0)
 * @returns A new RedNode tree with rainbow applied
 */
export function applyRainbow(
  root: RedNode,
  options?: {
    saturation?: number
    lightness?: number
    spread?: number
    offset?: number
  },
): RedNode {
  return RedNode.allowMutation(() => {
    const saturation = ((options?.saturation ?? 80) / 100)
    const lightness = ((options?.lightness ?? 60) / 100)
    const spread = options?.spread ?? 300
    const offset = options?.offset ?? 0

    const totalLength = countTextLength(root)
    if (totalLength === 0) return cloneTree(root)

    let globalPos = 0

    function walk(node: RedNode): RedNode {
      if (node.kind === 'text') {
        const result = wrapTextWithRainbow(node, saturation, lightness, spread, offset, globalPos, totalLength)
        globalPos += node.text.length
        return result
      }

      if (LEAF_KINDS.has(node.kind)) {
        return node
      }

      const cloned = cloneTree(node)
      cloned.children = []
      for (const child of node.children) {
        cloned.appendChild(walk(child))
      }
      return cloned
    }

    return walk(root)
  })
}

/**
 * Apply a central gradient across an entire RedNode tree.
 *
 * Gradient radiates from center outward (mirrored):
 *
 *   [b]Hello[/b] World  →  [b][color=#FF0000]H[/color]...[/b][color=#00FF00]W[/color]...
 *
 * @param root    The RedNode tree to transform
 * @param colors  Array of hex colors to interpolate across
 * @param options.unit      Split unit: 'character' (default), 'word', or 'line'
 * @param options.easing    Easing function: 'linear' (default), 'easeIn', 'easeOut', 'easeInOut'
 * @returns A new RedNode tree with central gradient applied
 */
export function applyCentralGradient(
  root: RedNode,
  colors: string[],
  options?: {
    unit?: 'character' | 'word' | 'line'
    easing?: Easing
  },
): RedNode {
  return RedNode.allowMutation(() => {
    const unit = options?.unit || 'character'
    const easing = options?.easing || 'linear'

    const totalLength = countTextLength(root)
    if (totalLength === 0) return cloneTree(root)

    let globalPos = 0

    function walk(node: RedNode): RedNode {
      if (node.kind === 'text') {
        const result = wrapTextWithCentralGradient(node, colors, globalPos, totalLength, unit, easing)
        globalPos += node.text.length
        return result
      }

      if (LEAF_KINDS.has(node.kind)) {
        return node
      }

      const cloned = cloneTree(node)
      cloned.children = []
      for (const child of node.children) {
        cloned.appendChild(walk(child))
      }
      return cloned
    }

    return walk(root)
  })
}

/**
 * Apply a multi gradient (wave or pulse) across an entire RedNode tree.
 *
 * Wave mode: sine wave pattern across colors.
 * Pulse mode: repeating gradient segments.
 *
 * @param root    The RedNode tree to transform
 * @param colors  Array of hex colors to interpolate across
 * @param options.mode      'wave' (default) or 'pulse'
 * @param options.unit      Split unit: 'character' (default), 'word', or 'line'
 * @param options.easing    Easing function: 'linear' (default), 'easeIn', 'easeOut', 'easeInOut'
 * @returns A new RedNode tree with multi gradient applied
 */
export function applyMultiGradient(
  root: RedNode,
  colors: string[],
  options?: {
    mode?: 'wave' | 'pulse'
    unit?: 'character' | 'word' | 'line'
    easing?: Easing
  },
): RedNode {
  return RedNode.allowMutation(() => {
    const mode = options?.mode || 'wave'
    const unit = options?.unit || 'character'
    const easing = options?.easing || 'linear'

    const totalLength = countTextLength(root)
    if (totalLength === 0) return cloneTree(root)

    let globalPos = 0

    function walk(node: RedNode): RedNode {
      if (node.kind === 'text') {
        const result = wrapTextWithMultiGradient(node, colors, mode, globalPos, totalLength, unit, easing)
        globalPos += node.text.length
        return result
      }

      if (LEAF_KINDS.has(node.kind)) {
        return node
      }

      const cloned = cloneTree(node)
      cloned.children = []
      for (const child of node.children) {
        cloned.appendChild(walk(child))
      }
      return cloned
    }

    return walk(root)
  })
}

/**
 * Apply any supported effect across an entire RedNode tree.
 */
export function applyEffect(root: RedNode, effect: TreeEffect): RedNode {
  switch (effect.kind) {
    case 'gradient':
      return applyGradient(root, effect.colors, {
        unit: effect.unit,
        easing: effect.easing,
      })
    case 'grow':
      return applyGrow(root, {
        min: effect.min,
        max: effect.max,
        cycles: effect.cycles,
      })
    case 'rainbow':
      return applyRainbow(root, {
        saturation: effect.saturation,
        lightness: effect.lightness,
        spread: effect.spread,
        offset: effect.offset,
      })
    case 'central_gradient':
      return applyCentralGradient(root, effect.colors, {
        unit: effect.unit,
        easing: effect.easing,
      })
    case 'multi_gradient':
      return applyMultiGradient(root, effect.colors, {
        mode: effect.mode,
        unit: effect.unit,
        easing: effect.easing,
      })
  }
}
