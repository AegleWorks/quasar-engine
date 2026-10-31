/**
 * Which newline is the last thing in its flow, and so needs a line painted
 * after it on an editable canvas (`HTMLRendererOptions.terminalLines`).
 *
 * A flow runs up to the block around it: inline tags are not boundaries, so the
 * `\n` in `[b]a\n[/b]` is last when nothing follows the `[/b]` either. A swallowed
 * newline after it is not "nothing": the canvas opens those on demand
 * (`revealLine`), and showing them unasked would add lines the reader never sees.
 */

import type { RedNode } from '../Syntax/RedNode'
import type { NodeKind } from '../Types/core'
import { isBlockKind } from '../BBCode/BBCodeToGreenNode'

/** Leaves that paint nothing: a stray closer osu! drops. */
const PAINTS_NOTHING: ReadonlySet<string> = new Set(['discarded_tag', 'discarded_box_close'])

export const isNewlineNode = (node: RedNode): boolean => node.kind === 'spacing' || node.kind === 'empty_line'

/** A block a flow cannot cross. A paragraph is only the element around loose inline text. */
function boundsFlow(node: RedNode): boolean {
  return node.kind !== 'paragraph' && isBlockKind(node.kind as NodeKind)
}

/**
 * Nothing is painted after `node` in its flow, and no swallowed newline follows it
 * to open that line on demand. Past an inline tag's closer one cannot: the caret
 * belongs inside the tag, so `[i]a⏎[/i]⏎[/box]` paints the line here.
 */
export function isTerminalNewline(node: RedNode, isSwallowed: (newline: RedNode) => boolean): boolean {
  for (let n: RedNode = node; ; n = n.parent!) {
    for (let next = n.nextSibling; next; next = next.nextSibling) {
      if (PAINTS_NOTHING.has(next.kind)) continue
      if (n === node || !isNewlineNode(next) || !isSwallowed(next)) return false
    }
    if (!n.parent || boundsFlow(n.parent)) return true
  }
}
