import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { LanguageService } from '../Language/LanguageService'
import { Workspace } from '../Language/Workspace'
import { applyEditsToSource } from '../Edits/applyEdits'
import { SymbolTable } from '../Symbols/SymbolTable'
import { RestyleAnalyzer } from '../Analysis/Passes/Analysis/RestyleAnalyzer'
import { GradientAnalyzer } from '../Analysis/Passes/Analysis/GradientAnalyzer'
import { ColorUsageAnalyzer } from '../Analysis/Passes/Analysis/ColorUsageAnalyzer'
import { GradientTagAnalyzer } from '../Analysis/Passes/Analysis/GradientTagAnalyzer'
import { SymbolAnalyzer } from '../Analysis/Passes/Analysis/SymbolAnalyzer'
import type { Contribution } from '../Analysis/Contracts/Contribution'
import type { PipelineContext } from '../Analysis/Contracts/PipelineContext'

const SOURCE = [
  '[heading]Intro[/heading]',
  '[url=#intro]go to intro[/url]',
  '[box=Details][b]Bold[/b] text[/box]',
  '[heading]Intro[/heading]',
  '[url=#intro-2]second[/url]',
  '[code]✧ literal[/code]',
].join('\n')

const context: PipelineContext = {
  mode: 'interactive',
  target: 'miliastry',
  featureFlags: {},
  metadata: {},
}

function model(source = SOURCE): BBCodeDocumentModel {
  return new BBCodeDocumentModel({ source, autoAnalyze: true })
}

describe('LanguageService — outline', () => {
  it('lists the blocks an author wrote and nests them by containment', () => {
    const service = new LanguageService(model())
    const symbols = service.getDocumentSymbols()

    expect(symbols.map(s => s.name)).toEqual(['Intro', 'Details', 'Intro', 'Code Block: ✧ literal'])
    expect(symbols[0].kind).toBe('heading')
    expect(symbols[1].kind).toBe('box')
    expect(symbols[1].selectionRange.start).toBe(SOURCE.indexOf('[box=Details]'))
  })

  it('never lists paragraphs, spacing or list items', () => {
    const service = new LanguageService(model('[list][*]one[*]two[/list]'))
    expect(service.getDocumentSymbols().map(s => s.kind)).toEqual(['list'])
  })

  it('caches by version and rebuilds after an edit', () => {
    const doc = model('[heading]One[/heading]')
    const service = new LanguageService(doc)
    const first = service.getDocumentSymbols()

    expect(service.getDocumentSymbols()).toBe(first)
    doc.applyTextUpdate('[heading]One[/heading][heading]Two[/heading]')
    expect(service.getDocumentSymbols().map(s => s.name)).toEqual(['One', 'Two'])
  })
})

describe('LanguageService — symbols, definition and references', () => {
  it('builds heading symbols and fragment references', () => {
    const table = new SymbolTable()
    table.build(model().redRoot!, SOURCE)

    const intro = table.get('intro')
    expect(intro).toBeDefined()
    expect(intro!.references).toHaveLength(1)
    expect(intro!.references[0].range).toEqual({
      start: SOURCE.indexOf('#intro'),
      end: SOURCE.indexOf('#intro') + '#intro'.length,
    })
    expect(table.get('intro-2')!.references).toHaveLength(1)
  })

  it('goes from a fragment link to its heading', () => {
    const doc = model()
    const service = new LanguageService(doc)
    const at = SOURCE.indexOf('#intro]') + 1

    expect(service.getDefinition(at)).toEqual({
      range: { start: SOURCE.indexOf('Intro'), end: SOURCE.indexOf('Intro') + 'Intro'.length },
      nodeId: doc.redRoot!.findNodeAtOffset(0)!.id,
    })
  })

  it('finds every reference including the definition, in source order', () => {
    const service = new LanguageService(model())
    const refs = service.findReferences(SOURCE.indexOf('#intro]') + 1)

    expect(refs.map(r => SOURCE.slice(r.range.start, r.range.end))).toEqual(['Intro', '#intro'])
  })

  it('returns null for ordinary text', () => {
    const service = new LanguageService(model())
    expect(service.getDefinition(SOURCE.indexOf(' text') + 1)).toBeNull()
  })
})

describe('LanguageService — quick info', () => {
  it('explains a tag from the registry', () => {
    const service = new LanguageService(model())
    const info = service.getQuickInfo(SOURCE.indexOf('[b]') + 1)

    expect(info?.kind).toBe('tag')
    expect(info?.name).toBe('b')
    expect(info?.documentation).toContain('Bold')
    expect(info?.tag?.category).toBe('formatting')
  })

  it('explains a heading symbol and counts its links', () => {
    const service = new LanguageService(model())
    const info = service.getQuickInfo(SOURCE.indexOf('Intro') + 1)

    expect(info?.kind).toBe('symbol')
    expect(info?.name).toBe('intro')
    expect(info?.referenceCount).toBe(1)
  })
})

describe('LanguageService — rename', () => {
  it('renames a heading and every fragment link to it', () => {
    const service = new LanguageService(model())
    const result = service.rename(SOURCE.indexOf('#intro]') + 1, 'Introduction')

    expect(result).not.toBeNull()
    expect(result!.edits.map(e => e.text)).toEqual(['Introduction', '#introduction'])
    const next = applyEditsToSource(SOURCE, result!.edits)
    expect(next).toContain('[heading]Introduction[/heading]')
    expect(next).toContain('[url=#introduction]go to intro[/url]')
  })

  it('refuses to flatten a heading that contains formatting', () => {
    const source = '[heading][b]Intro[/b][/heading]'
    const service = new LanguageService(model(source))

    expect(service.rename(source.indexOf('Intro') + 1, 'Other')).toBeNull()
  })
})

describe('LanguageService — semantic tokens and folding', () => {
  it('classifies delimiters, names, attributes and text in source order', () => {
    const service = new LanguageService(model('[color=#FF0000]red[/color]'))
    const tokens = service.getSemanticTokens()

    expect(tokens.map(t => t.type)).toEqual([
      'punctuation', 'tag', 'attribute', 'punctuation',
      'text',
      'punctuation', 'tag', 'punctuation',
    ])
    expect(tokens.map(t => [t.range.start, t.range.end])).toEqual([
      [0, 1], [1, 6], [6, 14], [14, 15],
      [15, 18],
      [18, 19], [20, 25], [25, 26],
    ])
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i].range.start).toBeGreaterThanOrEqual(tokens[i - 1].range.end)
    }
  })

  it('keeps code content as one string token', () => {
    const service = new LanguageService(model('[code]✧ [b]literal[/b][/code]'))
    const strings = service.getSemanticTokens().filter(t => t.type === 'string')
    expect(strings).toHaveLength(1)
    expect(strings[0].range).toEqual({ start: 6, end: 22 })
  })

  it('folds a block that spans more than one line', () => {
    const service = new LanguageService(model('[box]a\nb\nc[/box]'))
    expect(service.getFoldingRanges()).toEqual([{ startLine: 0, endLine: 2, kind: 'block' }])
  })

  it('re-tokenizes only the edited node and still equals a cold pass', () => {
    let seed = 123456789
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    const alphabet = 'ab []/=\n#colorbox'
    const doc = new BBCodeDocumentModel({
      // Large enough that the model takes the incremental reparse path; below
      // ~2.5 KB a full parse is faster and every edit rebuilds by design.
      source: Array.from({ length: 40 }, (_, i) =>
        `[box=Title ${i}]\n[color=#FF0000]red[/color] and [b]bold[/b]\n[/box]\nplain ✧ ${i}\n[code]literal[/code]`,
      ).join('\n'),
      autoAnalyze: false,
    })
    const service = new LanguageService(doc)

    for (let step = 0; step < 120; step++) {
      const length = doc.source.length
      const at = Math.floor(rand() * (length + 1))
      const remove = Math.floor(rand() * 4)
      const insert = Array.from(
        { length: Math.floor(rand() * 5) },
        () => alphabet[Math.floor(rand() * alphabet.length)],
      ).join('')
      doc.applyChange({ start: at, end: Math.min(length, at + remove), text: insert })

      const incremental = service.getSemanticTokens()
      const cold = new LanguageService(doc).getSemanticTokens()
      expect(incremental, `step ${step}: ${JSON.stringify(doc.source)}`).toEqual(cold)
      for (let i = 1; i < incremental.length; i++) {
        expect(incremental[i].range.start).toBeGreaterThanOrEqual(incremental[i - 1].range.end)
      }
    }

    // The fuzz must exercise the fast path, not rebuild every block.
    expect(service.stats.tokenBlocksReused).toBeGreaterThan(20)
  })

  it('reuses outline blocks after edits and still equals a cold pass', () => {
    let seed = 987654321
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    const alphabet = 'ab []/=\n#colorbox'
    const doc = new BBCodeDocumentModel({
      source: Array.from({ length: 40 }, (_, i) =>
        `[heading]Section ${i}[/heading]\n[box=Title ${i}]\n[color=#FF0000]red[/color]\n[/box]\nplain text`,
      ).join('\n'),
      autoAnalyze: false,
    })
    const service = new LanguageService(doc)
    service.getDocumentSymbols()

    for (let step = 0; step < 80; step++) {
      const length = doc.source.length
      const at = Math.floor(rand() * (length + 1))
      const remove = Math.floor(rand() * 3)
      const insert = Array.from(
        { length: Math.floor(rand() * 4) },
        () => alphabet[Math.floor(rand() * alphabet.length)],
      ).join('')
      doc.applyChange({ start: at, end: Math.min(length, at + remove), text: insert })

      const incremental = service.getDocumentSymbols()
      const cold = new LanguageService(doc).getDocumentSymbols()
      expect(incremental, `step ${step}: ${JSON.stringify(doc.source)}`).toEqual(cold)
    }

    expect(service.stats.outlineBlocksReused).toBeGreaterThan(20)
  })

  it('reuses folding ranges after edits and still equals a cold pass', () => {
    let seed = 246813579
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    const alphabet = 'ab []/=\n#colorbox'
    const doc = new BBCodeDocumentModel({
      source: Array.from({ length: 40 }, (_, i) =>
        `[box=Title ${i}]\nline one\nline two\nline three\n[/box]\nplain text`,
      ).join('\n'),
      autoAnalyze: false,
    })
    const service = new LanguageService(doc)
    service.getFoldingRanges()

    for (let step = 0; step < 80; step++) {
      const length = doc.source.length
      const at = Math.floor(rand() * (length + 1))
      const remove = Math.floor(rand() * 3)
      const insert = Array.from(
        { length: Math.floor(rand() * 4) },
        () => alphabet[Math.floor(rand() * alphabet.length)],
      ).join('')
      doc.applyChange({ start: at, end: Math.min(length, at + remove), text: insert })

      const incremental = service.getFoldingRanges()
      const cold = new LanguageService(doc).getFoldingRanges()
      expect(incremental, `step ${step}: ${JSON.stringify(doc.source)}`).toEqual(cold)
    }
  })
})

describe('LanguageService — completion', () => {
  it('offers tag names matching the typed prefix', () => {
    const source = '[co'
    const service = new LanguageService(model(source))
    const labels = service.getCompletions(source.length).map(c => c.label)

    expect(labels).toContain('color')
    expect(labels).not.toContain('quote')
  })

  it('offers the vocabulary of an enumerated attribute', () => {
    const source = '[effect=gl'
    const service = new LanguageService(model(source))
    const labels = service.getCompletions(source.length).map(c => c.label)

    expect(labels).toEqual(['glow'])
  })

  it('offers the open ancestors as closing tags, nearest first', () => {
    const source = '[quote][box=Title]x[/'
    const service = new LanguageService(model(source))

    expect(service.getCompletions(source.length).map(c => c.label)).toEqual(['/box', '/quote'])
    expect(new LanguageService(model('[quote][box=Title]x')).getCompletions(20)).toEqual([])
  })

  it('says nothing outside a delimiter', () => {
    const service = new LanguageService(model('plain text'))
    expect(service.getCompletions(4)).toEqual([])
  })
})

describe('LanguageService — code actions', () => {
  it('offers the unclosed-tag quick fix at the caret', () => {
    const source = '[b]hello'
    const service = new LanguageService(model(source))
    const actions = service.getCodeActions(1)

    expect(actions.length).toBeGreaterThan(0)
    expect(actions.some(a => a.kind === 'quickfix')).toBe(true)
  })
})

describe('Workspace — project/solution Fix-All', () => {
  it('fixes every open document and reports the aggregate', () => {
    const workspace = new Workspace()
    workspace.open('a.bbcode', '[b]one')
    workspace.open('b.bbcode', '[i]two')

    const result = workspace.fixAll('unclosed-tag', { scope: 'solution' })

    expect(result.applied).toBe(2)
    expect(workspace.get('a.bbcode')!.model.source).toBe('[b]one[/b]')
    expect(workspace.get('b.bbcode')!.model.source).toBe('[i]two[/i]')
  })

  it('document scope needs a single target', () => {
    const workspace = new Workspace()
    workspace.open('a.bbcode', '[b]one')
    workspace.open('b.bbcode', '[i]two')

    expect(() => workspace.fixAll('unclosed-tag', { scope: 'document' })).toThrow()
    expect(workspace.fixAll('unclosed-tag', { scope: 'document', uri: 'a.bbcode' }).applied).toBe(1)
  })
})

describe('LanguageService — diagnostics', () => {
  it('flushes the debounced analysis before answering', () => {
    const doc = model('[b]hello')
    doc.applyTextUpdate('[b]hello[/i]')
    const service = new LanguageService(doc)

    expect(service.getDiagnostics().diagnostics.length).toBeGreaterThan(0)
  })
})

describe('RestyleAnalyzer — one pass, same facts', () => {
  it('produces the same contributions as the four separate analyzers', () => {
    const doc = new BBCodeDocumentModel({ source: SOURCE + '\n✧ ━━━ ✧', autoAnalyze: false })
    const green = doc.greenRoot!

    const separate: Contribution[] = [
      ...new GradientAnalyzer().run(green, context),
      ...new ColorUsageAnalyzer().run(green, context),
      ...new GradientTagAnalyzer(doc.source).run(green, context),
      ...new SymbolAnalyzer().run(green, context),
    ]
    const combined = new RestyleAnalyzer(doc.source).run(green, context)

    const key = (c: Contribution): string => {
      if (c.kind === 'semantic') {
        return `${c.label}:${c.range.start}:${c.range.end}:${c.confidence.toFixed(6)}`
      }
      return c.kind
    }

    expect(combined.map(key).sort()).toEqual(separate.map(key).sort())
  })
})
