/**
 * The one rule for CSS that comes from a document or a plugin and lands in a
 * `style="…"` attribute: which properties may be set, and which values are
 * refused. `HTMLRenderer` applies it to `[style]` tags and `RenderTree` to
 * plugin render nodes, so both paths stop at the same line.
 */

/** Properties a document or plugin may set inline. */
export const STYLE_PROP_WHITELIST: ReadonlySet<string> = new Set([
  'width', 'height', 'padding', 'margin', 'display',
  'background', 'border', 'opacity', 'filter', 'transform',
  'float', 'clear', 'white-space', 'font-variant', 'text-transform',
  'text-align', 'gap', 'color', 'font-size', 'font-weight',
  'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
  'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
  'line-height', 'letter-spacing', 'word-spacing',
])

/**
 * A value with the characters that could leave the declaration or the
 * attribute removed, at most 100 long. Parentheses stay: `rgba()`, `blur()`,
 * `rotate()` and `color-mix()` are legitimate.
 */
export function stripStyleValue(value: string): string {
  return value.replace(/["'{}<>]/g, '').slice(0, 100)
}

/** Whether a value loads or runs something: `url()`, `expression()`, `javascript:`. */
export function isDangerousStyleValue(value: string): boolean {
  return /url\s*\(|expression\s*\(|javascript\s*:/i.test(value)
}
