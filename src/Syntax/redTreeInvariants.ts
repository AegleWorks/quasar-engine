/**
 * DocumentEngine — Red Tree Invariants
 *
 * `checkPartition` proves the GREEN tree accounts for every character. This
 * module proves the same of the RED tree, which is where everything since has
 * moved: positions (accumulated from widths, then shifted lazily by
 * `setStart`), parent pointers and the index cache (rewired by adoption),
 * identity (ids carried across reparses) and the rich box titles that live
 * outside `children`. Every one of those is maintained by hand on some path —
 * the incremental splice, red-subtree reuse, `OsuPreviewTree`'s structural
 * reuse — and a mistake in any of them is silent: offsets quietly stop meaning
 * anything, and the caret, hover, diagnostics and the preview patcher inherit
 * the lie.
 *
 * Roslyn keeps a validator of exactly this kind next to its incremental
 * parser, and runs it under test after every reparse. So does this engine:
 * the property tests of the incremental paths call `assertRedTree` after every
 * random edit.
 *
 * Reading `range` materializes pending lazy shifts (see `RedNode.setStart`).
 * That changes when the walk happens, never what any offset reads, so running
 * the validator does not alter the tree it checks — but it is a full walk, and
 * belongs in tests and debug builds, not on the keystroke path.
 */

import type { GreenNode } from './GreenNode'
import type { RedNode } from './RedNode'

export type RedTreeViolationKind =
  /** A child's `parent` is not the node that lists it. */
  | 'parent'
  /** A child's `index` does not point back at its slot. */
  | 'index'
  /** A node's range disagrees with the widths before it. */
  | 'range'
  /** The red child list does not mirror the green one. */
  | 'shape'
  /** Two nodes share an id. */
  | 'duplicate-id'
  /** A rich box title node is detached or outside its box. */
  | 'title'
  /** The root does not cover the source, or a text leaf does not hold its text. */
  | 'source'

export interface RedTreeViolation {
  kind: RedTreeViolationKind
  /** Structural path, e.g. `document/box[3]/paragraph[0]`. */
  path: string
  detail: string
}

export interface CheckRedTreeOptions {
  /**
   * The source the tree was parsed from. Enables the round-trip checks: the
   * root covers it exactly and every `text` leaf holds the characters it
   * claims.
   */
  source?: string
  /** Stop after this many violations. Default 200. */
  limit?: number
}

/**
 * Verify every structural invariant of a red tree. Returns an empty array when
 * the tree is well formed. Never throws.
 */
export function checkRedTree(root: RedNode, options: CheckRedTreeOptions = {}): RedTreeViolation[] {
  const limit = options.limit ?? 200
  const source = options.source
  const violations: RedTreeViolation[] = []
  const seen = new Map<string, string>()
  const report = (kind: RedTreeViolationKind, path: string, detail: string): void => {
    if (violations.length < limit) violations.push({ kind, path, detail })
  }

  if (root.parent !== null) report('parent', root.kind, 'the root has a parent')
  if (root.range.start !== 0) report('range', root.kind, `the root starts at ${root.range.start}`)
  if (source !== undefined && root.green.width !== source.length) {
    report('source', root.kind, `root width ${root.green.width}, source length ${source.length}`)
  }

  // Iterative: documents nest deeply enough that recursion is a needless risk
  // in a validator.
  const stack: { node: RedNode; path: string }[] = [{ node: root, path: root.kind }]
  while (stack.length > 0 && violations.length < limit) {
    const { node, path } = stack.pop()!
    checkNode(node, path, source, seen, report)

    const kids = node.children
    let offset = node.innerStart
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]
      const childPath = `${path}/${child.kind}[${i}]`
      if (child.parent !== node) report('parent', childPath, `parent is ${child.parent?.kind ?? 'null'}, listed under ${node.kind}`)
      if (child.index !== i) report('index', childPath, `index ${child.index} in slot ${i}`)
      if (child.range.start !== offset) report('range', childPath, `starts at ${child.range.start}, widths put it at ${offset}`)
      offset += child.green.width
      stack.push({ node: child, path: childPath })
    }
    if (kids.length > 0 && offset !== node.innerEnd) {
      report('range', path, `children end at ${offset}, inner end is ${node.innerEnd}`)
    }

    const titles = node.metadata?.titleNodes as RedNode[] | undefined
    if (titles) {
      const { start, end } = node.range
      for (let i = 0; i < titles.length; i++) {
        const title = titles[i]
        const titlePath = `${path}/title:${title.kind}[${i}]`
        if (title.parent !== node) report('title', titlePath, `parent is ${title.parent?.kind ?? 'null'}`)
        if (title.range.start < start || title.range.end > end) {
          report('title', titlePath, `[${title.range.start}, ${title.range.end}) outside the box [${start}, ${end})`)
        }
        // Title subtrees are ordinary red trees: same invariants, same ids.
        stack.push({ node: title, path: titlePath })
      }
    }
  }

  return violations
}

function checkNode(
  node: RedNode,
  path: string,
  source: string | undefined,
  seen: Map<string, string>,
  report: (kind: RedTreeViolationKind, path: string, detail: string) => void,
): void {
  const prior = seen.get(node.id)
  if (prior !== undefined) report('duplicate-id', path, `id ${node.id} also at ${prior}`)
  else seen.set(node.id, path)

  const { start, end } = node.range
  if (end - start !== node.green.width) report('range', path, `range [${start}, ${end}) but width ${node.green.width}`)

  const greenKids = node.green.children as readonly GreenNode[]
  if (greenKids.length !== node.children.length) {
    report('shape', path, `${node.children.length} red children, ${greenKids.length} green`)
  } else {
    for (let i = 0; i < greenKids.length; i++) {
      const red = node.children[i].green
      const green = greenKids[i]
      // Structural reuse adopts a subtree whose green is EQUAL, not the same
      // object, so identity is not required — kind and width are.
      if (red !== green && (red.kind !== green.kind || red.width !== green.width)) {
        report('shape', `${path}/${node.children[i].kind}[${i}]`, `red holds ${red.kind}/${red.width}, green has ${green.kind}/${green.width}`)
      }
    }
  }

  if (source !== undefined && node.kind === 'text' && node.children.length === 0) {
    const slice = source.slice(start, end)
    if (slice !== node.text) report('source', path, `holds ${JSON.stringify(node.text)}, source has ${JSON.stringify(slice)}`)
  }
}

/** Convenience for tests: throw a readable error if any invariant is broken. */
export function assertRedTree(root: RedNode, options: CheckRedTreeOptions = {}): void {
  const violations = checkRedTree(root, { limit: 10, ...options })
  if (violations.length === 0) return
  const lines = violations.map(v => `  ${v.kind} at ${v.path}: ${v.detail}`)
  throw new Error(`Red tree invariants broken:\n${lines.join('\n')}`)
}
