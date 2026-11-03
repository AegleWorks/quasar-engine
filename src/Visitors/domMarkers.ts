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
