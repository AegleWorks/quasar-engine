import { RedNode } from '../Syntax/RedNode'
import { isUnclosedTag, openingTagName } from '../Semantic/SemanticAnalyzer'
import type { SurgicalEdit } from '../Reconciler/SurgicalReconciler'

/** A closing tag the source never opened, kept by the parser as literal text. */
export interface OrphanCloser {
  /** The tag name as written, lowercased. */
  tag: string
  /** Where the `[/tag]` sits in the source. */
  range: { start: number; end: number }
}

/** An opening tag the parser had to close on the author's behalf. */
export interface UnclosedOpener {
  tag: string
  /** Where its `[/tag]` belongs. */
  at: number
}

export interface NestingRepair {
  /** Deletions for the orphans and insertions for the missing closers. */
  edits: SurgicalEdit[]
  orphans: OrphanCloser[]
  unclosed: UnclosedOpener[]
  /** The repaired source, for callers that want it whole. */
  source: string
  hasChanges: boolean
}

/**
 * A `[/tag]` that closed nothing.
 *
 * The parser leaves two traces, and both are damage this repairs:
 *
 *  - `discarded_tag`, a closer that arrived after its tag had already been
 *    auto-closed. The node exists only to own its range;
 *  - a text leaf whose whole content is a closing tag — a closer that never
 *    had an opener at all, kept as text so no character belongs to nothing.
 */
const CLOSING_TAG = /^\[\/([a-zA-Z][a-zA-Z0-9]*)\]$/

/**
 * Repairs BBCode nesting without touching a byte the author wrote elsewhere.
 *
 * Two kinds of damage, two kinds of edit:
 *
 *  - a closing tag with no opener is deleted, because that is what osu! does
 *    with it — Quasar renders it as literal text, which is the one place the
 *    two disagree (see `Tests/OsuNestingFidelity.test.ts`);
 *  - an opener the parser had to close silently gets its `[/tag]` written in,
 *    at the offset the parser already chose.
 *
 * Crossed tags need no rule of their own. `[a][b]x[/a][/b]` already parses to
 * the same tree as `[a][b]x[/b][/a]`; removing the leftover `[/b]` is all the
 * repair it takes.
 *
 * Deliberately *not* an export of the tree. Round-tripping through
 * `BBCodeExporter` also yields balanced BBCode, but it rewrites the whole
 * document — re-spelling attributes, collapsing spacing — and none of that is
 * a change the author asked for. Edits keep the blast radius at the damage.
 */
export function repairNesting(source: string, root: RedNode | null): NestingRepair {
  const orphans: OrphanCloser[] = []
  const unclosed: UnclosedOpener[] = []

  if (root) {
    root.walk((node: RedNode) => {
      if (node.kind === 'discarded_tag') {
        const match = CLOSING_TAG.exec(node.text)
        if (match) {
          orphans.push({
            tag: match[1].toLowerCase(),
            range: { start: node.range.start, end: node.range.end },
          })
        }
        return
      }
      if (node.kind === 'text') {
        const match = CLOSING_TAG.exec(node.text)
        // The range check keeps a literal the author typed inside `[code]` out
        // of this: there the text is content, not a delimiter in the source.
        if (match && source.slice(node.range.start, node.range.end) === node.text) {
          orphans.push({
            tag: match[1].toLowerCase(),
            range: { start: node.range.start, end: node.range.end },
          })
        }
        return
      }
      if (isUnclosedTag(node, source)) {
        const tag = openingTagName(node, source)
        if (tag) unclosed.push({ tag, at: node.range.end })
      }
    })
  }

  const edits: SurgicalEdit[] = [
    ...orphans.map(o => ({ start: o.range.start, end: o.range.end, text: '' })),
    ...unclosed.map(u => ({ start: u.at, end: u.at, text: `[/${u.tag}]` })),
  ]

  // Bottom-to-top, so an earlier range is still valid once a later one applied.
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end)
  let repaired = source
  for (const edit of ordered) {
    repaired = repaired.slice(0, edit.start) + edit.text + repaired.slice(edit.end)
  }

  return {
    edits: ordered,
    orphans,
    unclosed,
    source: repaired,
    hasChanges: ordered.length > 0,
  }
}
