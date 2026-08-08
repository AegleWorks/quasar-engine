import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { ASTOptimizer } from '../Transformers/ASTOptimizer'
import { TagRegistry } from '../Model/TagRegistry'
import { RedNode } from '../Syntax/RedNode'

// ─── 0. Deterministic PRNG ────────────────────────────────────
//
// This suite used bare `Math.random()`. It failed roughly 50% of runs, and
// when it failed the payload that broke the optimizer was gone — nothing to
// reproduce, nothing to regression-test. A fuzzer you cannot replay is not a
// fuzzer, it is a coin flip attached to your CI.
//
// The seed is fixed by default and overridable, so a failure is always
// reproducible: QUASAR_FUZZ_SEED=123456 npm test

const FUZZ_SEED = Number(process.env.QUASAR_FUZZ_SEED ?? 0x5EED_1A57)

/** mulberry32 — small, fast, good enough distribution for structural fuzzing. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── 1. Fuzzing Generator ─────────────────────────────────────
class BBCodeFuzzer {
  private random: () => number

  constructor(seed: number = FUZZ_SEED) {
    this.random = mulberry32(seed)
  }

  private tags = [
    { open: '[b]', close: '[/b]' },
    { open: '[i]', close: '[/i]' },
    { open: '[color=red]', close: '[/color]' },
    { open: '[color=blue]', close: '[/color]' },
    { open: '[size=50]', close: '[/size]' },
    { open: '[size=20]', close: '[/size]' },
    { open: '[url=https://osu.ppy.sh]', close: '[/url]' },
    { open: '[notice]', close: '[/notice]' }
  ]
  private words = ['osu!', 'peppy', 'click', 'circles', 'to', 'the', 'beat', 'combo', 'FC', 'SS']
  
  private randomInt(max: number) {
    return Math.floor(this.random() * max)
  }
  
  private randomWord() {
    return this.words[this.randomInt(this.words.length)]
  }
  
  private randomSpace() {
    const spaces = [' ', '  ', '\n', '\n\n']
    return spaces[this.randomInt(spaces.length)]
  }

  // Generates a random AST structure as BBCode string
  generate(depth: number = 0, length: number = 5): string {
    if (depth > 4) return this.randomWord()
    
    let result = ''
    for (let i = 0; i < length; i++) {
      const choice = this.randomInt(10)
      
      if (choice < 3) {
        // Plain text
        result += this.randomWord() + this.randomSpace()
      } else if (choice < 6) {
        // Tag pair (validly nested)
        const tag = this.tags[this.randomInt(this.tags.length)]
        result += `${tag.open}${this.generate(depth + 1, 2)}${tag.close}`
      } else if (choice < 8) {
        // Empty tag
        const tag = this.tags[this.randomInt(this.tags.length)]
        result += `${tag.open}${tag.close}`
      } else if (choice === 8) {
        // Orphan opening tag
        const tag = this.tags[this.randomInt(this.tags.length)]
        result += tag.open
      } else {
        // Orphan closing tag
        const tag = this.tags[this.randomInt(this.tags.length)]
        result += tag.close
      }
    }
    
    return result
  }
}

// ─── 2. Validation Helpers ────────────────────────────────────

function getPlainText(node: RedNode): string {
  if (node.kind === 'text') return node.text || ''
  if (node.kind === 'spacing') return node.text || ''
  if (node.kind === 'empty_line') return '\n\n'
  return node.children.map(c => getPlainText(c)).join('')
}

// ─── 3. The Test Suite ────────────────────────────────────────
describe('Empirical Fuzz Testing - AST Optimizer', () => {
  const fuzzer = new BBCodeFuzzer()
  const registry = new TagRegistry()
  
  // Create 100 random BBCode payloads
  const samples = Array.from({ length: 100 }, () => fuzzer.generate(0, 10))
  
  // Specific pathological edge cases we know about
  samples.push(
    '[b][b]Redundant[/b][/b]',
    '[color=red][b]Inverted[/b][/color]',
    '[size=50][size=20]Overridden[/size][/size]',
    '[b]Merge[/b] [b]Me[/b]',
    '[b][color=red]A[/color][/b] [b][color=red]B[/color][/b]',
    '[color=red][b]A[/b][/color] [color=red][b]B[/b][/color]',
    '[b]Spaces   [/b]',
    '[[[[[not a tag]',
    '[b][/i][/b]'
  )

  it.each(samples.map((bbcode, i) => [i, bbcode]))('Fuzz Case %i', (_, source) => {
    // 1. Parsing should not crash
    const model = new BBCodeDocumentModel({ source, strictMode: false })
    expect(model.redRoot).toBeDefined()

    const originalText = getPlainText(model.redRoot!)
    
    // 2. Optimization should not crash
    const optimizer = new ASTOptimizer()
    optimizer.transform(model)
    
    // 3. Lossless Text: Optimization must NEVER delete or alter visible text/spacing
    const optimizedText = getPlainText(model.redRoot!)
    expect(optimizedText).toBe(originalText)
    
    // 4. Exporting should not crash
    const exporter = new BBCodeExporter(registry)
    const exported1 = exporter.export(model.redRoot!)
    
    // 5. Idempotence: optimizing an already optimized tree should produce no changes
    const model2 = new BBCodeDocumentModel({ source: exported1, strictMode: false })
    const optimizer2 = new ASTOptimizer()
    const { transaction } = optimizer2.transform(model2)
    
    // An idempotent optimizer shouldn't need to mutate the tree a second time
    // We allow 0 operations!
    if (transaction && transaction.operations.length > 0) {
      console.log('--- IDEMPOTENCE FAILURE ---')
      console.log('Exported:', exported1)
      console.log('Operations:', JSON.stringify(transaction.operations.map(o => o.kind)))
    }
    expect(transaction?.operations.length || 0).toBe(0)
    
    // 6. Round-trip stability
    const exported2 = model2.redRoot ? exporter.export(model2.redRoot) : ''
    expect(exported2).toBe(exported1)
  })
})
