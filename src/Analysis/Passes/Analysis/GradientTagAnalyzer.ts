/**
 * Quasar Analysis Framework — Gradient Tag Analyzer
 *
 * Reports every native `[gradient=…]` tag, with the source offsets of each
 * colour in its stop list.
 *
 * ## Why GradientAnalyzer does not cover these
 *
 * `GradientAnalyzer` *infers* a gradient from a run of `[color]` tags — it has
 * to, because osu! has no gradient tag and an exported document spells every
 * ramp out one letter at a time. A native `[gradient]` needs no inference: the
 * tag states its stops, so there is nothing to score and nothing to doubt.
 * It was simply invisible to restyling, which only ever looked at `[color]`.
 *
 * ## What gets located, and why so finely
 *
 * The attribute is an effect parameter list — `#a, #b 40%, #c;easing=…;at=2`
 * (see `parseEffectParams`). Restyling must change the colours and nothing
 * else: an easing, a wave or an `at`/`of` fragment position rewritten in a
 * canonical spelling would change a gradient someone configured. So each
 * colour token gets its own offsets, and a consumer edits exactly those bytes.
 *
 * ## Why this pass takes the source
 *
 * Every other analyzer reads the tree alone. This one cannot: a green node
 * keeps its delimiter's *width* but not its bytes, and `node.text` is the
 * attribute after the parser trimmed it — `[gradient=#a,#b ]` reports `=#a,#b`
 * with nothing to say a space was dropped. Offsets derived from it land one
 * character off and splice the wrong bytes. So the delimiter is read from the
 * source the tree was parsed from, and a tag whose delimiter does not read
 * back as `[gradient…]` is skipped rather than guessed at.
 *
 * Whatever the author put between the tag name and the `=` (`[GRADIENT = …]`)
 * sits before the first colour and is never touched.
 *
 * Only `#RGB` and `#RRGGBB` are located. A named colour in a stop list is
 * left alone, for the same reason `ColorUsageAnalyzer` ignores `[color=red]`:
 * rewriting it means choosing a spelling the author did not use.
 *
 * @see PaletteRemapDecision — resamples these stops onto a palette
 * @see parseColorStops — the positions here are the ones the renderer uses
 */

import type { AnalyzerPass } from '../../Contracts/Pass'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { Contribution } from '../../Contracts/Contribution'
import { ContributionKind } from '../../Contracts/Contribution'
import type { GreenNode } from '../../../Syntax/GreenNode'
import { childOffsets } from '../../../Syntax/GreenNode'
import { parseColorStops } from '../../../Utils/EffectMath'

// ── Types ─────────────────────────────────────────────────────────

export interface GradientTagStop {
  /** Uppercase `#RRGGBB`; a `#RGB` token is expanded. */
  readonly hex: string
  /** Where the stop sits along the ramp, 0–1, exactly as the renderer reads it. */
  readonly position: number
  /** Source offsets of the colour token alone — never its `40%` suffix. */
  readonly start: number
  readonly end: number
}

export interface GradientTagModel {
  /** Everything between the tag name and `]`, as written: ` = #a, #b;easing=easeInOut`. */
  readonly attribute: string
  /** Source offsets of {@link attribute}. */
  readonly attributeStart: number
  readonly attributeEnd: number
  /** Only the hex stops, in source order. */
  readonly stops: readonly GradientTagStop[]
}

const HEX_TOKEN = /^(\s*)(#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{3})(?![0-9A-Fa-f])/

/** `#abc` → `#AABBCC`; `#aabbcc` → `#AABBCC`. */
export function canonicalStopHex(token: string): string {
  const body = token.slice(1)
  const full = body.length === 3 ? body.replace(/./g, c => c + c) : body
  return `#${full.toUpperCase()}`
}

/**
 * Find the hex stops of a gradient attribute, offsets relative to it.
 *
 * Mirrors `parseEffectParams`: segments split on `;`, the one without an `=` is
 * the stop list, and a later stop list replaces an earlier one. Parts are
 * aligned with `parseColorStops` by skipping the same empty entries it drops.
 */
export function locateGradientStops(
  attribute: string,
): { hex: string; position: number; start: number; end: number }[] {
  const eq = attribute.indexOf('=')
  if (eq < 0) return []

  let found: { hex: string; position: number; start: number; end: number }[] = []
  let segmentStart = eq + 1

  for (const segment of attribute.slice(eq + 1).split(';')) {
    const isStopList = segment.trim() !== '' && !segment.includes('=')

    if (isStopList) {
      const positions = parseColorStops(segment.trim())
      const stops: typeof found = []
      let partStart = segmentStart
      let index = 0

      for (const part of segment.split(',')) {
        if (part.trim() !== '') {
          const match = HEX_TOKEN.exec(part)
          if (match && positions[index]) {
            const start = partStart + match[1].length
            stops.push({
              hex: canonicalStopHex(match[2]),
              position: positions[index].position,
              start,
              end: start + match[2].length,
            })
          }
          index++
        }
        partStart += part.length + 1
      }

      if (stops.length > 0) found = stops
    }

    segmentStart += segment.length + 1
  }

  return found
}

// ── Analyzer ──────────────────────────────────────────────────────

/** The tag name at the head of a delimiter, case as the parser accepts it. */
const GRADIENT_HEAD = /^\[gradient(?![a-z0-9_])/i

export class GradientTagAnalyzer implements AnalyzerPass {
  readonly id = 'gradient-tag'

  /** @param source — the exact text the analysed tree was parsed from. */
  constructor(private readonly source: string) {}

  run(tree: GreenNode, _context: PipelineContext): Contribution[] {
    const contributions: Contribution[] = []
    this.walk(tree, contributions, 0)
    return contributions
  }

  // ── Private ─────────────────────────────────────────────────────

  private walk(node: GreenNode, sink: Contribution[], start: number): void {
    const delimiter = node.kind === 'gradient' ? this.source.slice(start, start + node.leadingWidth) : ''
    const head = GRADIENT_HEAD.exec(delimiter)

    if (head && delimiter.endsWith(']')) {
      const attribute = delimiter.slice(head[0].length, -1)
      const attributeStart = start + head[0].length
      const attributeEnd = attributeStart + attribute.length

      const stops = locateGradientStops(attribute).map(stop => ({
        ...stop,
        start: attributeStart + stop.start,
        end: attributeStart + stop.end,
      }))

      if (stops.length > 0) {
        const model: GradientTagModel = {
          attribute,
          attributeStart,
          attributeEnd,
          stops,
        }

        sink.push({
          kind: ContributionKind.Semantic,
          label: 'GradientTag',
          // Stated by the tag, not inferred from a run of colours.
          confidence: 1,
          range: { start, end: start + node.width },
          metadata: { model },
          description: `Gradient tag ${stops.map(s => s.hex).join(', ')}`,
        })
      }
    }

    const children = node.children as readonly GreenNode[]
    if (children.length === 0) return

    const offsets = childOffsets(node, start)
    for (let i = 0; i < children.length; i++) {
      this.walk(children[i], sink, offsets[i])
    }
  }
}
