/**
 * Quasar Analysis Framework — Character Count Analyzer (Proof of Concept)
 *
 * The simplest possible AnalyzerPass: it walks the Green Tree and counts
 * text characters.  This validates that the full pipeline works:
 *
 *   Green Tree → Analyzer → Contribution → Aggregated Report
 *
 * No algorithms, no colours, no decisions — just validating the pipe.
 */

import type { AnalyzerPass } from '../../Contracts/Pass'
import type { PipelineContext } from '../../Contracts/PipelineContext'
import type { Contribution } from '../../Contracts/Contribution'
import { ContributionKind } from '../../Contracts/Contribution'
import type { GreenNode } from '../../../Syntax/GreenNode'

export class CharacterCountAnalyzer implements AnalyzerPass {
  readonly id = 'character-count'

  run(tree: GreenNode, _context: PipelineContext): Contribution[] {
    const count = this.countChars(tree)

    return [
      {
        kind: ContributionKind.Metrics,
        metrics: {
          characters: count,
        },
      },
    ]
  }

  // ── Private ─────────────────────────────────────────────────────

  private countChars(node: GreenNode): number {
    let total = node.text?.length ?? 0
    if (node.children) {
      for (const child of node.children) {
        total += this.countChars(child)
      }
    }
    return total
  }
}
