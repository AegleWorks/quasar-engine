/**
 * Quasar Analysis Framework — Color Utilities
 *
 * Shared utility functions for color node analysis across all passes.
 * Extracted here to avoid duplication across GradientAnalyzer,
 * RainbowAnalyzer, MergeableColorAnalyzer, etc.
 *
 * @module
 */

import type { GreenNode } from '../../Syntax/GreenNode'

// ── Hex extraction ────────────────────────────────────────────────

/**
 * Extract the hex colour from a [color] GreenNode.
 * Supports both "=#FF0000" and "#FF0000" formats.
 * Returns null if the node is not a color node or has invalid hex.
 */
export function extractHex(node: GreenNode): string | null {
  if (node.kind !== 'color') return null
  const text = node.text || ''
  const eqIdx = text.indexOf('=')
  const hex = eqIdx >= 0 ? text.slice(eqIdx + 1).trim() : text.trim()
  return /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex.toUpperCase() : null
}

/**
 * Extract the size value from a [size] / [font_size] GreenNode.
 * Supports "=150", "=90" formats.
 * Returns null if the node is not a size node.
 */
export function extractSize(node: GreenNode): number | null {
  if (node.kind !== 'font_size') return null
  const text = node.text || ''
  const eqIdx = text.indexOf('=')
  const val = eqIdx >= 0 ? text.slice(eqIdx + 1).trim() : text.trim()
  const num = parseInt(val, 10)
  return isNaN(num) ? null : num
}

// ── Sigmoid ───────────────────────────────────────────────────────

/**
 * Sigmoid function to map a raw score to [0, 1] confidence.
 * Centered at 0: sigmoid(0) = 0.5
 * steepness controls the sharpness of the transition.
 */
export function sigmoid(x: number, steepness: number = 6): number {
  return 1 / (1 + Math.exp(-x * steepness))
}

// ── Sequence helpers ──────────────────────────────────────────────

/**
 * A detected sequence of adjacent similar nodes in the Green Tree.
 */
export interface NodeSequence {
  /** Extracted values (hex colours, sizes, etc.) in order */
  readonly values: (string | number)[]
  /** Start index in the parent's children array */
  readonly startIdx: number
  /** End index (exclusive) in the parent's children array */
  readonly endIdx: number
}

/**
 * Extract consecutive sequences of [color] or [font_size] nodes
 * from a parent's children array.
 *
 * @param children - Direct children of a container node
 * @param kind     - The node kind to extract ('color' or 'font_size')
 * @param extract  - Function to extract values from matching nodes
 * @returns Array of sequences found
 */
export function extractSequences<T extends string | number>(
  children: GreenNode[],
  kind: string,
  extract: (node: GreenNode) => T | null,
): Array<{ values: T[]; startIdx: number; endIdx: number }> {
  const sequences: Array<{ values: T[]; startIdx: number; endIdx: number }> = []
  let current: { values: T[]; startIdx: number } | null = null

  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    const val = child.kind === kind ? extract(child) : null

    if (val !== null) {
      if (current === null) {
        current = { values: [val], startIdx: i }
      } else {
        current.values.push(val)
      }
    } else if (child.kind !== 'text' || child.text.trim() !== '') {
      // Non-text, non-{kind} node OR non-whitespace text — end sequence
      if (current !== null) {
        sequences.push({ ...current, endIdx: i })
        current = null
      }
    }
  }

  if (current !== null) {
    sequences.push({ ...current, endIdx: children.length })
  }

  return sequences
}

/**
 * Check if there are formatting tags between nodes in a sequence.
 */
export function checkFormattingBreaks(
  children: GreenNode[],
  seq: { startIdx: number; endIdx: number },
  targetKind: string,
): boolean {
  for (let i = seq.startIdx; i < seq.endIdx; i++) {
    const child = children[i]
    if (child.kind !== targetKind && child.kind !== 'text') {
      return true
    }
    if (child.kind === targetKind) {
      for (const c of child.children as GreenNode[]) {
        if (c.kind !== 'text' && c.kind !== 'spacing' && c.kind !== 'empty_line') {
          return true
        }
      }
    }
  }
  return false
}
