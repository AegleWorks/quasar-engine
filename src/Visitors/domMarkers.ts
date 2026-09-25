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
