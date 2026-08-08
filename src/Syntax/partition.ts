/**
 * DocumentEngine — Partition Invariant
 *
 * The green tree must PARTITION the source text: every character of the input
 * is accounted for exactly once, and the tree can answer "which node owns
 * offset N?" without ambiguity.
 *
 * Before the width model this was false in three ways, all measured:
 *
 *  1. Delimiters were not represented at all. `[b]hola[/b]` produced a `bold`
 *     spanning `[0..13]` whose only child spanned `[3..7]` — 6 characters
 *     inside the parent belonged to no node. 32.630 occurrences of
 *     `parent.start != firstChild.start` in a single real document.
 *  2. Siblings could occupy the same range. `"hola\n\nmundo"` produced
 *     `spacing [4..6]` AND `empty_line [4..6]`, so offset 5 had two owners.
 *  3. Orphaned closing tags were dropped silently, leaving holes in the root.
 *
 * ─── What this module still checks, and what it no longer needs to ──────────
 *
 * Most of the invariant is now STRUCTURAL. A green node has no position, and
 * its width is computed by its own constructor as
 * `leadingWidth + Σ child widths + trailingWidth`, so gaps, overlaps and
 * mismatched delimiters are not states the type can be in. The checks for them
 * were deleted along with the ability to fail them.
 *
 * Two things remain genuinely checkable, and they are the two that matter:
 *
 *  - **Coverage.** The root's width must equal the source length. If the parser
 *    drops a token — which is exactly what the orphaned-closing-tag bug did —
 *    the tree is internally consistent but describes a shorter document.
 *  - **Leaf honesty.** A `text` token's width must equal the text it holds.
 *    Nothing derives this, so nothing enforces it.
 */

import type { GreenNode } from './GreenNode'

export type PartitionViolationKind =
  /** The root's width does not match the source length. */
  | 'root-coverage'
  /** A leaf's width does not match the text it claims to hold. */
  | 'leaf-width'
  /** A node's width disagrees with its own children plus delimiters. */
  | 'width-mismatch'

export interface PartitionViolation {
  kind: PartitionViolationKind
  /** Structural path to the offending node, e.g. `document/paragraph[0]/bold[1]`. */
  path: string
  nodeKind: string
  detail: string
}

export interface CheckPartitionOptions {
  /** Stop after this many violations. Default 200 — enough to diagnose, cheap to print. */
  limit?: number
  /**
   * Also require leaf widths to match `text.length`. Off by default: `text` on
   * a leaf is overloaded (it holds tag attributes on element nodes and is empty
   * on `spacing`/`empty_line`), so only `text`-kind leaves are checked even
   * when this is on.
   */
  checkLeafWidths?: boolean
}

/**
 * Verify that `root` partitions `[0..sourceLength]`.
 *
 * Returns an empty array when the tree is well formed. Never throws.
 */
export function checkPartition(
  root: GreenNode,
  sourceLength: number,
  options: CheckPartitionOptions = {},
): PartitionViolation[] {
  const limit = options.limit ?? 200
  const checkLeafWidths = options.checkLeafWidths ?? false
  const violations: PartitionViolation[] = []

  const report = (
    kind: PartitionViolationKind,
    path: string,
    nodeKind: string,
    detail: string,
  ): void => {
    if (violations.length < limit) {
      violations.push({ kind, path, nodeKind, detail })
    }
  }

  if (root.width !== sourceLength) {
    report(
      'root-coverage',
      root.kind,
      root.kind,
      `root width ${root.width}, source length ${sourceLength}`,
    )
  }

  // Iterative walk: documents nest deeply enough (lists inside boxes inside
  // centres) that recursion here is a needless risk in a validator.
  const stack: { node: GreenNode; path: string }[] = [{ node: root, path: root.kind }]

  while (stack.length > 0 && violations.length < limit) {
    const { node, path } = stack.pop()!
    const children = node.children as readonly GreenNode[]

    if (children.length === 0) {
      // A childless node is either a token whose whole width is its own
      // content, or an empty element (`[b][/b]`) whose whole width is its two
      // delimiters. Either way the delimiters cannot claim more room than the
      // node occupies.
      if (node.leadingWidth + node.trailingWidth > node.width) {
        report(
          'width-mismatch',
          path,
          node.kind,
          `width ${node.width} but leading ${node.leadingWidth} + trailing ${node.trailingWidth}`,
        )
      }
      if (
        checkLeafWidths &&
        node.kind === 'text' &&
        node.width !== node.text.length
      ) {
        report(
          'leaf-width',
          path,
          node.kind,
          `width ${node.width} but text.length ${node.text.length}`,
        )
      }
      continue
    }

    // Belt and braces: the constructor computes this, so a failure here means
    // somebody built a GreenNode by a route that bypassed it.
    let sum = node.leadingWidth + node.trailingWidth
    for (let i = 0; i < children.length; i++) {
      sum += children[i].width
      stack.push({ node: children[i], path: `${path}/${children[i].kind}[${i}]` })
    }
    if (sum !== node.width) {
      report(
        'width-mismatch',
        path,
        node.kind,
        `width ${node.width} but children + delimiters sum to ${sum}`,
      )
    }
  }

  return violations
}

/** Convenience for tests: throw a readable error if the invariant is broken. */
export function assertPartition(root: GreenNode, sourceLength: number): void {
  const violations = checkPartition(root, sourceLength, { limit: 10 })
  if (violations.length === 0) return
  const lines = violations.map(v => `  ${v.kind} at ${v.path}: ${v.detail}`)
  throw new Error(`Tree does not partition the source:\n${lines.join('\n')}`)
}
