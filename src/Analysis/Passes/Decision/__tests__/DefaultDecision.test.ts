/**
 * Tests for DefaultDecision
 */

import { describe, it, expect } from 'vitest'
import { DefaultDecision } from '../DefaultDecision'
import { ContributionKind } from '../../../Contracts/Contribution'
import type { AnalysisReport } from '../../../Contracts/AnalysisReport'
import type { PipelineContext } from '../../../Contracts/PipelineContext'
import { PipelineMode, ExportTarget } from '../../../Contracts/PipelineContext'

const baseReport: AnalysisReport = {
  contributions: [],
  passCount: 1,
  elapsedMs: 10,
}

function osuContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    mode: PipelineMode.Batch,
    target: ExportTarget.Osu,
    featureFlags: {},
    metadata: {},
    ...overrides,
  }
}

function miliastryContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    mode: PipelineMode.Interactive,
    target: ExportTarget.Miliastry,
    featureFlags: {},
    metadata: {},
    ...overrides,
  }
}

describe('DefaultDecision', () => {
  describe('gradient detection', () => {
    it('excludes gradients below the threshold for osu target', () => {
      const decision = new DefaultDecision()
      const report: AnalysisReport = {
        ...baseReport,
        contributions: [
          {
            kind: ContributionKind.Semantic,
            label: 'Gradient',
            confidence: 0.5, // Below threshold
            range: { start: 0, end: 50 },
            metadata: {
              model: { colors: ['#FF0000', '#00FF00'], easing: 'linear', charCount: 5 },
              diagnostics: {},
            },
          },
        ],
      }

      const plan = decision.run(report, osuContext())
      expect(plan.actions).toHaveLength(0)
    })

    it('includes gradients above auto-threshold for osu target', () => {
      const decision = new DefaultDecision()
      const report: AnalysisReport = {
        ...baseReport,
        contributions: [
          {
            kind: ContributionKind.Semantic,
            label: 'Gradient',
            confidence: 0.96, // Above osu threshold (0.95)
            range: { start: 0, end: 50 },
            metadata: {
              model: { colors: ['#FF0000', '#EE1100', '#DD2200'], easing: 'linear', charCount: 3 },
              diagnostics: {},
            },
          },
        ],
      }

      const plan = decision.run(report, osuContext())
      expect(plan.actions).toHaveLength(1)
      expect(plan.actions[0].kind).toBe('collapse-gradient')
    })

    it('uses lower threshold for miliastry target', () => {
      const decision = new DefaultDecision()
      const report: AnalysisReport = {
        ...baseReport,
        contributions: [
          {
            kind: ContributionKind.Semantic,
            label: 'Gradient',
            confidence: 0.7, // Above miliastry threshold (0.6)
            range: { start: 0, end: 50 },
            metadata: {
              model: { colors: ['#FF0000', '#EE1100', '#DD2200'], easing: 'linear', charCount: 3 },
              diagnostics: {},
            },
          },
        ],
      }

      const plan = decision.run(report, miliastryContext())
      expect(plan.actions).toHaveLength(1)
      expect(plan.actions[0].kind).toBe('collapse-gradient')
    })

    it('uses forceCollapse for very high confidence', () => {
      const decision = new DefaultDecision()
      const report: AnalysisReport = {
        ...baseReport,
        contributions: [
          {
            kind: ContributionKind.Semantic,
            label: 'Gradient',
            confidence: 0.9,
            range: { start: 0, end: 50 },
            metadata: {
              model: { colors: ['#FF0000', '#EE1100', '#DD2200'], easing: 'linear', charCount: 3 },
              diagnostics: {},
            },
          },
        ],
      }

      const plan = decision.run(report, miliastryContext())
      // 0.9 ≥ 0.85 = force collapse
      expect(plan.actions[0].payload.autoCollapse).toBe(true)
    })
  })

  describe('optimization detection', () => {
    it('includes merge-colors optimizations', () => {
      const decision = new DefaultDecision()
      const report: AnalysisReport = {
        ...baseReport,
        contributions: [
          {
            kind: ContributionKind.Optimization,
            label: 'Merge Colors',
            description: '3 consecutive [color=#FF0000] tags',
            estimatedImprovement: '-66%',
            range: { start: 0, end: 30 },
          },
        ],
      }

      const plan = decision.run(report, osuContext())
      expect(plan.actions).toHaveLength(1)
      expect(plan.actions[0].kind).toBe('merge-colors')
    })
  })

  describe('edge cases', () => {
    it('returns empty plan for empty report', () => {
      const decision = new DefaultDecision()
      const plan = decision.run(baseReport, osuContext())
      expect(plan.actions).toHaveLength(0)
    })

    it('ignores non-semantic and non-optimization contributions', () => {
      const decision = new DefaultDecision()
      const report: AnalysisReport = {
        ...baseReport,
        contributions: [
          { kind: ContributionKind.Metrics, metrics: { characters: 100 } },
          {
            kind: ContributionKind.Diagnostic,
            severity: 'info',
            message: 'Test diagnostic',
          },
        ],
      }

      const plan = decision.run(report, osuContext())
      expect(plan.actions).toHaveLength(0)
    })
  })
})
