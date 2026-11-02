/**
 * Loss reporting shared by both directions of the standard-Markdown bridge.
 *
 * A converter never drops content silently: whatever the target dialect has
 * no form for is counted here, per kind, with the first affected text as a
 * short sample.
 */

export interface MarkdownLoss {
  /** Machine-readable category, e.g. `table`, `html`, `underline`. */
  kind: string
  /** How many times it happened. */
  count: number
  /** A short piece of the first affected text. */
  sample?: string
}

const SAMPLE_LIMIT = 48

export class LossBook {
  private readonly byKind = new Map<string, MarkdownLoss>()

  add(kind: string, sample?: string): void {
    const text = sample?.replace(/\s+/g, ' ').trim()
    const clipped = text && text.length > SAMPLE_LIMIT ? `${text.slice(0, SAMPLE_LIMIT - 1)}…` : text
    const existing = this.byKind.get(kind)
    if (existing) {
      existing.count++
      if (existing.sample === undefined && clipped) existing.sample = clipped
      return
    }
    const entry: MarkdownLoss = { kind, count: 1 }
    if (clipped) entry.sample = clipped
    this.byKind.set(kind, entry)
  }

  list(): MarkdownLoss[] {
    return [...this.byKind.values()]
  }
}
