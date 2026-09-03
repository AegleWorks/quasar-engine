/**
 * Quasar — `shorten-hex`
 *
 * `[color=#FFAA00]` → `[color=#FA0]`, three characters per tag.
 *
 * Only fires when every channel is a doubled digit, which is exactly the set
 * of six-digit colours the three-digit form can express — `#FA0` expands back
 * to `#FFAA00` by duplication, so the rendered colour is bit-identical. This
 * was verified against the engine before the rule was written: three-digit hex
 * parses to a `color` node and reaches CSS as `color:#FA0`.
 *
 * The edit replaces the hex token alone, located inside the opening
 * delimiter — never the delimiter itself. `[Color = "#FFAA00"]` therefore
 * becomes `[Color = "#FA0"]`, keeping the capital C, the spaces and the
 * quotes the author typed.
 *
 * Three bytes sounds trivial and is not: an expanded gradient spends one
 * colour tag per character, so a 400-character ramp gives back 1.200.
 */

import type { PlannedEdit } from '../EditPlan'
import {
  type OptimizationRule,
  type RuleContext,
  type Positioned,
  positionedChildren,
  openRange,
} from './Rule'
import { attributeValue, shortenableHex } from './tagValue'

export const SHORTEN_HEX_PRIORITY = 10

const HEX6_TOKEN = /#[0-9a-fA-F]{6}/

export class ShortenHexRule implements OptimizationRule {
  readonly id = 'shorten-hex'
  readonly priority = SHORTEN_HEX_PRIORITY
  readonly label = 'Shorten 6-digit hex colours'

  run(context: RuleContext): PlannedEdit[] {
    const sink: PlannedEdit[] = []
    this.scan({ node: context.root, start: 0 }, context.source, sink)
    return sink
  }

  // ── Private ─────────────────────────────────────────────────────

  private scan(item: Positioned, source: string, sink: PlannedEdit[]): void {
    for (const child of positionedChildren(item)) {
      if (child.node.kind === 'color') {
        const edit = this.shorten(child, source)
        if (edit) sink.push(edit)
      }
      this.scan(child, source, sink)
    }
  }

  private shorten(item: Positioned, source: string): PlannedEdit | null {
    const short = shortenableHex(attributeValue(item.node))
    if (short === null) return null

    const open = openRange(item)
    const delimiter = source.slice(open.start, open.end)
    const match = HEX6_TOKEN.exec(delimiter)
    // The attribute said there was a six-digit hex; if it is not visible in the
    // delimiter the two disagree, and guessing an offset would corrupt bytes.
    if (!match) return null

    const start = open.start + match.index
    return {
      start,
      end: start + match[0].length,
      text: short,
      ruleId: this.id,
      priority: this.priority,
      label: `${match[0]} → ${short}`,
    }
  }
}
