/**
 * Quasar Analysis Framework — Pipeline Context
 *
 * PipelineContext is **read-only by contract**.  It is built *before*
 * the pipeline starts and MUST NOT be modified by any pass.
 *
 * If a pass needs to make information available to downstream passes it
 * should emit a Contribution rather than mutating the context.
 *
 * @immutable
 */

// ── Mode ──────────────────────────────────────────────────────────

export const PipelineMode = {
  Interactive: 'interactive',     // TextStudio, editor integration
  Batch: 'batch',                 // CLI, automated processing
  Import: 'import',               // Clipboard / file import
} as const

export type PipelineMode = (typeof PipelineMode)[keyof typeof PipelineMode]

// ── Export target ─────────────────────────────────────────────────

export const ExportTarget = {
  Osu: 'osu',
  Miliastry: 'miliastry',
  HTML: 'html',
  Markdown: 'markdown',
} as const

export type ExportTarget = (typeof ExportTarget)[keyof typeof ExportTarget]

// ── Context ───────────────────────────────────────────────────────

export interface PipelineContext {
  /** Where this pipeline run originates from. */
  readonly mode: PipelineMode

  /** The format we intend to export to (influences decisions). */
  readonly target: ExportTarget

  /** Feature flags that may enable/disable certain behaviours. */
  readonly featureFlags: Readonly<Record<string, boolean>>

  /** Free-form metadata provided by the caller (e.g. selection range). */
  readonly metadata: Readonly<Record<string, unknown>>
}
