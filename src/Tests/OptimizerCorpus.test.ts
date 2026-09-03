import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { optimizeBBCode } from '../Edits/Optimizer'
import { classifyOverlap } from '../Edits/EditPlan'
import { applyEditsToSource } from '../Edits/applyEdits'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { GreenNode } from '../Syntax/GreenNode'
import { attributeValue, normalizeColorValue } from '../Edits/Rules/tagValue'

/**
 * The optimizer against real userpages.
 *
 * Synthetic cases prove a rule does what it says; only real documents prove
 * the rules do not do anything *else*. These pages are other people's work,
 * full of spellings, nesting and whitespace nobody would think to invent.
 *
 * `docs/ai/**` is gitignored, so this suite skips wherever the corpus is not
 * present — the same arrangement `OsuNestingFidelity` uses.
 */

const DOCS = join(__dirname, '../../../../docs/ai')
const GALLERIES = ['gallery', 'gallery-osu']

function corpus(): Array<{ name: string; source: string }> {
  const out: Array<{ name: string; source: string }> = []
  for (const gallery of GALLERIES) {
    const dir = join(DOCS, gallery)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter(f => f.endsWith('.bbcode')).sort()) {
      const source = readFileSync(join(dir, file), 'utf8')
      if (source.trim().length > 0) out.push({ name: `${gallery}/${file}`, source })
    }
  }
  return out
}

const CORPUS = corpus()

// ── Shared style model (see EditRules.test.ts for the reasoning) ───

const STRUCTURAL = new Set(['document', 'paragraph', 'group', 'text', 'spacing', 'empty_line'])
const FLAG_KINDS = new Set(['bold', 'italic', 'underline', 'strikethrough', 'mark'])

function computeStyle(stack: readonly { kind: string; value: string }[]): string {
  let color = ''
  let font = ''
  let size = 1
  let sup = 0
  let sub = 0
  const flags = new Set<string>()
  const other: string[] = []

  for (const entry of stack) {
    if (entry.kind === 'color') color = entry.value
    else if (entry.kind === 'font') font = entry.value
    else if (entry.kind === 'font_size') size *= Number(entry.value) || 100
    else if (entry.kind === 'sup') sup++
    else if (entry.kind === 'sub') sub++
    else if (FLAG_KINDS.has(entry.kind)) flags.add(entry.kind)
    else other.push(`${entry.kind}=${entry.value}`)
  }
  return `c:${color}|f:${font}|s:${size}|^${sup}|v${sub}|${[...flags].sort().join('+')}|${other.join('>')}`
}

function styleProfile(source: string): Array<{ char: string; styles: string }> {
  const model = new BBCodeDocumentModel({ source, dialect: 'lyne', autoAnalyze: false })
  const root = model.greenRoot
  const out: Array<{ char: string; styles: string }> = []
  if (!root) return out

  const stack: { kind: string; value: string }[] = []
  const walk = (node: GreenNode): void => {
    if (node.kind === 'text') {
      const styles = computeStyle(stack)
      for (const char of node.text ?? '') out.push({ char, styles })
      return
    }
    if (node.kind === 'spacing' || node.kind === 'empty_line') {
      out.push({ char: '\n', styles: '' })
      return
    }
    const tracked = !STRUCTURAL.has(node.kind)
    if (tracked) {
      const raw = attributeValue(node)
      stack.push({
        kind: node.kind,
        value: node.kind === 'color' ? normalizeColorValue(raw) : raw.toLowerCase(),
      })
    }
    for (const child of node.children as readonly GreenNode[]) walk(child)
    if (tracked) stack.pop()
  }
  walk(root)
  return out
}

const BLANK = /\s/
const inked = (profile: Array<{ char: string; styles: string }>) =>
  profile.filter(c => !BLANK.test(c.char)).map(c => `${c.char}{${c.styles}}`)

// ── Suite ─────────────────────────────────────────────────────────

describe.skipIf(CORPUS.length === 0)('optimizer against real userpages', () => {
  it('found a corpus to run against', () => {
    expect(CORPUS.length).toBeGreaterThan(0)
  })

  for (const { name, source } of CORPUS) {
    describe(name, () => {
      const result = optimizeBBCode(source)

      it('never grows the document', () => {
        expect(result.output.length).toBeLessThanOrEqual(source.length)
      })

      it('preserves every visible character', () => {
        const before = styleProfile(source)
        const after = styleProfile(result.output)
        expect(after.map(c => c.char).join('')).toBe(before.map(c => c.char).join(''))
      })

      it('preserves the computed style of every inked character', () => {
        expect(inked(styleProfile(result.output))).toEqual(inked(styleProfile(source)))
      })

      it('emits pairwise disjoint edits', () => {
        const edits = result.edits
        for (let i = 0; i < edits.length; i++) {
          for (let j = i + 1; j < edits.length; j++) {
            expect(classifyOverlap(edits[i], edits[j])).toBe('disjoint')
          }
        }
      })

      it('emits no straddling conflicts', () => {
        expect(result.plan.rejected.filter(r => r.reason === 'straddle')).toEqual([])
      })

      it('emits no invalid ranges', () => {
        expect(result.plan.rejected.filter(r => r.reason === 'invalid-range')).toEqual([])
      })

      it('introduces no unparseable tags', () => {
        const discarded = (text: string): number => {
          const model = new BBCodeDocumentModel({ source: text, dialect: 'lyne', autoAnalyze: false })
          let count = 0
          const walk = (node: GreenNode): void => {
            if (node.kind === 'discarded_tag') count++
            for (const child of node.children as readonly GreenNode[]) walk(child)
          }
          if (model.greenRoot) walk(model.greenRoot)
          return count
        }
        expect(discarded(result.output)).toBeLessThanOrEqual(discarded(source))
      })

      it('converges in one pass', () => {
        // The maximality claim: rules produce their normal form directly, so
        // optimizing the output again must find nothing left to do.
        expect(optimizeBBCode(result.output).output).toBe(result.output)
      })

      it('agrees with a plain replay of its own edits', () => {
        // The two appliers must not be able to disagree. Monaco resolves the
        // batch against its model; this is the other half, replayed by hand.
        expect(applyEditsToSource(source, result.edits)).toBe(result.output)
      })
    })
  }

  it('reports what it saved across the corpus', () => {
    let before = 0
    let after = 0
    const perRule = new Map<string, number>()

    for (const { source } of CORPUS) {
      const result = optimizeBBCode(source)
      before += source.length
      after += result.output.length
      for (const stat of result.stats) {
        perRule.set(stat.ruleId, (perRule.get(stat.ruleId) ?? 0) + stat.savedChars)
      }
    }

    // Not an assertion about a specific ratio — real pages vary far too much
    // for that to be anything but a brittle snapshot. What is worth pinning is
    // that the optimizer is doing *something* and never inflating.
    expect(after).toBeLessThanOrEqual(before)
    console.log(
      `\ncorpus: ${CORPUS.length} pages, ${before} → ${after} chars ` +
        `(-${before - after}, ${((1 - after / before) * 100).toFixed(2)}%)\n` +
        [...perRule.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id, saved]) => `  ${id}: -${saved}`)
          .join('\n'),
    )
  })
})
