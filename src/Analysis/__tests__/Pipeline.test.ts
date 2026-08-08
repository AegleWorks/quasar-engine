/**
 * Quasar Analysis Framework — Pipeline Tests
 *
 * Validates that the core pipeline infrastructure works:
 * - Pass interfaces are correctly typed
 * - PipelineBuilder assembles passes
 * - Pipeline executes them in order
 * - CharacterCountAnalyzer (PoC) produces expected metrics
 */

import { describe, it, expect } from 'vitest'
import { greenNode, greenLeaf } from '../../Syntax/GreenNode'
import type { GreenNode } from '../../Syntax/GreenNode'
import { Pipeline } from '../Pipeline/Pipeline'
import { PipelineBuilder } from '../Pipeline/PipelineBuilder'
import { CharacterCountAnalyzer } from '../Passes/Utility/CharacterCountAnalyzer'
import type { PipelineContext } from '../Contracts/PipelineContext'
import { PipelineMode, ExportTarget } from '../Contracts/PipelineContext'

// ── Helpers ───────────────────────────────────────────────────────

const mockContext: PipelineContext = {
  mode: PipelineMode.Batch,
  target: ExportTarget.Osu,
  featureFlags: {},
  metadata: {},
}

function buildSimpleTree(): GreenNode {
  // root
  // ├── heading "Hello"
  // └── text "World"
  const headingText = greenLeaf('text', 'Hello')
  const heading = greenNode('heading', '', [headingText])
  const worldText = greenLeaf('text', 'World')
  return greenNode('root', '', [heading, worldText])
}

// ── Tests ─────────────────────────────────────────────────────────

describe('Pipeline Infrastructure', () => {
  describe('PipelineBuilder', () => {
    it('builds a pipeline from passes', () => {
      const pipeline = new PipelineBuilder()
        .analysis(new CharacterCountAnalyzer())
        .build()

      expect(pipeline).toBeInstanceOf(Pipeline)
    })

    it('accepts multiple analysis passes', () => {
      const pipeline = new PipelineBuilder()
        .analysis(new CharacterCountAnalyzer(), new CharacterCountAnalyzer())
        .build()

      expect(pipeline).toBeInstanceOf(Pipeline)
    })

    it('rejects analysis passes in decision/transform slots at type level', () => {
      // TypeScript enforces that builder.analysis() only accepts AnalyzerPass
      // instances. This is a compile-time check that can't be validated with
      // vitest. At runtime we just verify the builder doesn't throw for valid usage.
      const builder = new PipelineBuilder()
      expect(() => builder.analysis(new CharacterCountAnalyzer())).not.toThrow()
    })
  })

  describe('Pipeline execution', () => {
    it('executes analysis passes and produces a report', () => {
      const pipeline = new PipelineBuilder()
        .analysis(new CharacterCountAnalyzer())
        .build()

      const tree = buildSimpleTree()
      const result = pipeline.run(tree, mockContext)

      expect(result.report.contributions).toHaveLength(1)
      expect(result.report.passCount).toBe(1)
      expect(result.report.elapsedMs).toBeGreaterThanOrEqual(0)
    })

    it('preserves the original tree when no transforms are registered', () => {
      const pipeline = new PipelineBuilder()
        .analysis(new CharacterCountAnalyzer())
        .build()

      const tree = buildSimpleTree()
      const result = pipeline.run(tree, mockContext)

      expect(result.tree).toBe(tree) // same reference since no transforms
    })

    it('reports correct character count', () => {
      const pipeline = new PipelineBuilder()
        .analysis(new CharacterCountAnalyzer())
        .build()

      const tree = buildSimpleTree()
      const result = pipeline.run(tree, mockContext)

      const metricsContribution = result.report.contributions[0]
      expect(metricsContribution).toMatchObject({
        kind: 'metrics',
        metrics: { characters: 10 }, // "Hello" (5) + "World" (5)
      })
    })

    it('handles empty trees gracefully', () => {
      const pipeline = new PipelineBuilder()
        .analysis(new CharacterCountAnalyzer())
        .build()

      const emptyTree = greenNode('root', '', [])
      const result = pipeline.run(emptyTree, mockContext)

      const metricsContribution = result.report.contributions[0]
      expect(metricsContribution).toMatchObject({
        kind: 'metrics',
        metrics: { characters: 0 },
      })
    })
  })

  describe('PipelineBuilder direct usage', () => {
    it('works via new PipelineBuilder()', () => {
      const pipeline = new PipelineBuilder()
        .analysis(new CharacterCountAnalyzer())
        .build()

      expect(pipeline).toBeInstanceOf(Pipeline)
    })
  })
})
