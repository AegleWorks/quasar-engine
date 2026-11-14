/**
 * The contract between the preview's HTML and the paths that read it back
 * (`HTMLToGreenNode`, `SurgicalReconciler`): markers the renderer leaves in the
 * DOM for source text that has no layout of its own.
 */

/**
 * A newline osu! swallows, carried as `<span data-bb-nl hidden></span>`: no
 * layout (osu! deletes it), but it reads back as the source `\n`.
 */
export const SWALLOWED_NEWLINE_ATTR = 'data-bb-nl'

/**
 * A flow's last newline on an editable canvas, with the line after it
 * (`HTMLRendererOptions.terminalLines`): `<span data-bb-tail …><br><br></span>`.
 * The first `<br>` is the newline and the second holds the last line open.
 */
export const TERMINAL_LINE_ATTR = 'data-bb-tail'

/**
 * A text leaf's element on an editable surface (`HTMLRendererOptions.textLeafIds`):
 * `<span data-bb-leaf="id">…</span>`, the leaf's rendered text and nothing else.
 */
export const TEXT_LEAF_ATTR = 'data-bb-leaf'

/**
 * A box's plain title, under the same attribute as a text leaf:
 * `<span data-bb-leaf="t<box id>">…</span>`. A plain title (`[box=Title]`) is
 * attribute text with no node of its own, so it is named after its box. Rich
 * titles (`[box=[b]T[/b]]`) have nodes (`metadata.titleNodes`) and mark their
 * leaves as usual.
 */
export const TITLE_LEAF_PREFIX = 't'

/**
 * A `[code]` body on an editable surface, under the same attribute as a text
 * leaf: `<span data-bb-leaf="k<text id>">…</span>`. The leaf covers the body
 * minus the edges `editableCodeEdges` drops, so it is named apart from its
 * text node: its range is not the node's.
 */
export const CODE_LEAF_PREFIX = 'k'

/**
 * How many characters of a `[code]` body an editable surface leaves off each
 * edge. osu! strips every empty line at both ends; a page being written drops
 * one newline per side (the tag on its own line, `[code]⏎…⏎[/code]`), so a
 * line Enter just made stays on screen for the caret.
 */
export function editableCodeEdges(text: string): { lead: number; trail: number } {
  // A body that is one newline is the line Enter made in an empty block: shown.
  const trail = text.length > 1 && text.endsWith('\n') ? 1 : 0
  const lead = text.startsWith('\n') && text.length - trail >= 2 ? 1 : 0
  return { lead, trail }
}
