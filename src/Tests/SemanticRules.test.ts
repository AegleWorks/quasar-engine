import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { Diagnostic } from '../Types/diagnostics'

/**
 * The rules the checker gained when the Linter's dead rules were moved into the
 * analyzer.
 *
 * `Linter` was only ever reachable through `PluginAPI`, which nothing in the
 * app constructs, so `no-nested-bold`, `max-quote-depth` and
 * `invalid-url-protocol` never ran once — even though the app already shipped
 * translated messages for all three. Every rule below is checked for the thing
 * the Linter versions got wrong on top of never running: they returned
 * `range: null`, and a finding with no location cannot be jumped to.
 */

function diagnose(source: string): Diagnostic[] {
  return new BBCodeDocumentModel({ source }).analyze().diagnostics.items
}

function find(source: string, code: string): Diagnostic {
  const found = diagnose(source).find(d => d.code === code)
  expect(found, `no '${code}' for ${JSON.stringify(source)}`).toBeDefined()
  return found!
}

function slice(source: string, d: Diagnostic): string {
  expect(d.range, `'${d.code}' has no range`).not.toBeNull()
  return source.slice(d.range!.start, d.range!.end)
}

function codes(source: string): string[] {
  return diagnose(source).map(d => d.code)
}

describe('invalid-url-protocol', () => {
  it('rejects a scheme the browser would execute', () => {
    const src = '[url=javascript:alert(1)]click[/url]'
    const d = find(src, 'invalid-url-protocol')
    expect(d.severity).toBe('error')
    // Underlines the destination, not the whole tag: the reader has to see
    // which part is wrong.
    expect(slice(src, d)).toBe('javascript:alert(1)')
  })

  it('offers no automatic fix — there is no safe rewrite of an unsafe scheme', () => {
    const d = find('[url=javascript:alert(1)]x[/url]', 'invalid-url-protocol')
    expect(d.fixes).toBeUndefined()
  })

  it.each(['https://osu.ppy.sh', 'http://osu.ppy.sh', 'mailto:a@b.com'])(
    'accepts %s',
    (href) => {
      expect(codes(`[url=${href}]x[/url]`)).not.toContain('invalid-url-protocol')
    },
  )

  it('accepts the content form, where the href is the link text', () => {
    expect(codes('[url]https://osu.ppy.sh[/url]')).not.toContain('invalid-url-protocol')
  })
})

describe('missing-url-protocol', () => {
  it('is a warning, not an error: a missing scheme is a typo', () => {
    const src = '[url=www.osu.ppy.sh]click[/url]'
    const d = find(src, 'missing-url-protocol')
    expect(d.severity).toBe('warning')
    expect(slice(src, d)).toBe('www.osu.ppy.sh')
  })

  it('fixes itself by prefixing https://, and the fix is safe to batch', () => {
    const src = '[url=www.osu.ppy.sh]click[/url]'
    const d = find(src, 'missing-url-protocol')
    const fix = d.fixes![0]
    expect(fix.isAutomatic).toBe(true)

    const op = fix.operations[0]
    expect(op.kind).toBe('insert_text')
    const applied = src.slice(0, (op as { position: number }).position)
      + (op as { text: string }).text
      + src.slice((op as { position: number }).position)
    expect(applied).toBe('[url=https://www.osu.ppy.sh]click[/url]')
  })

  it('leaves a repaired link clean on the next pass', () => {
    expect(codes('[url=https://www.osu.ppy.sh]click[/url]'))
      .not.toContain('missing-url-protocol')
  })
})

describe('empty-link', () => {
  it('catches the link `empty-tag` structurally cannot see', () => {
    // `[url=x][/url]` carries `=x` as its text, so the empty-tag rule's
    // `text === ''` test never matches it. Without this rule the document
    // renders an invisible anchor and nothing reports it.
    const src = '[url=https://osu.ppy.sh][/url]'
    expect(codes(src)).not.toContain('empty-tag')
    expect(find(src, 'empty-link').severity).toBe('warning')
  })

  it('ignores a link that has text', () => {
    expect(codes('[url=https://osu.ppy.sh]osu![/url]')).not.toContain('empty-link')
  })

  it('ignores the content form, whose destination IS its text', () => {
    expect(codes('[url]https://osu.ppy.sh[/url]')).not.toContain('empty-link')
  })

  it('suggests the href as the label, but never automatically', () => {
    const src = '[url=https://osu.ppy.sh][/url]'
    const fix = find(src, 'empty-link').fixes![0]
    // Manual: it puts words on screen that the author did not write.
    expect(fix.isAutomatic).toBe(false)

    const op = fix.operations[0] as { kind: string; position: number; text: string }
    const applied = src.slice(0, op.position) + op.text + src.slice(op.position)
    expect(applied).toBe('[url=https://osu.ppy.sh]https://osu.ppy.sh[/url]')
  })
})

describe('max-quote-depth', () => {
  it('stays quiet at three levels', () => {
    expect(codes('[quote][quote][quote]hi[/quote][/quote][/quote]'))
      .not.toContain('max-quote-depth')
  })

  it('fires on the fourth, and points at its opening tag only', () => {
    const src = '[quote][quote][quote][quote]hi[/quote][/quote][/quote][/quote]'
    const d = find(src, 'max-quote-depth')
    // The Linter version returned `range: null`, so this finding could not be
    // navigated to. The whole node would swallow the rest of the document.
    expect(slice(src, d)).toBe('[quote]')
  })

  it('reports the deepest quote once, not every ancestor', () => {
    const src = '[quote][quote][quote][quote]hi[/quote][/quote][/quote][/quote]'
    expect(codes(src).filter(c => c === 'max-quote-depth')).toHaveLength(1)
  })
})

describe('redundant-nesting', () => {
  it('reports a tag nested directly inside itself', () => {
    const d = find('[b][b]doble[/b][/b]', 'redundant-nesting')
    expect(d.severity).toBe('hint')
    expect(d.tags).toContain('redundant')
  })

  it('stays quiet when the nesting means something', () => {
    // The inner [color] wins, so it is not redundant — unlike [b] inside [b],
    // whose effect is idempotent.
    expect(codes('[color=#f00][color=#0f0]x[/color][/color]'))
      .not.toContain('redundant-nesting')
    expect(codes('[b][i]x[/i][/b]')).not.toContain('redundant-nesting')
  })

  it('unwraps the inner tag, and only ever on request', () => {
    const src = '[b][b]doble[/b][/b]'
    const fix = find(src, 'redundant-nesting').fixes![0]
    // Manual: unwrapping changes the emitted HTML. "Fix all" promises it never
    // changes the document's output, so this one stays out of the batch.
    expect(fix.isAutomatic).toBe(false)

    const edits = fix.operations
      .map(op => ({ start: (op as { range: { start: number } }).range.start,
                    end: (op as { range: { end: number } }).range.end }))
      .sort((a, b) => b.start - a.start)
    let out = src
    for (const e of edits) out = out.slice(0, e.start) + out.slice(e.end)
    expect(out).toBe('[b]doble[/b]')
  })
})

describe('the whole set, on one document', () => {
  it('reports every new rule and no old one twice', () => {
    const src = [
      '[url=javascript:alert(1)]malo[/url]',
      '[url=www.osu.ppy.sh]sin esquema[/url]',
      '[url=https://osu.ppy.sh][/url]',
      '[quote][quote][quote][quote]hondo[/quote][/quote][/quote][/quote]',
      '[b][b]doble[/b][/b]',
    ].join('\n')

    const found = new Set(codes(src))
    expect(found).toContain('invalid-url-protocol')
    expect(found).toContain('missing-url-protocol')
    expect(found).toContain('empty-link')
    expect(found).toContain('max-quote-depth')
    expect(found).toContain('redundant-nesting')
  })

  it('leaves a clean document clean', () => {
    expect(codes('[b]bold[/b] [url=https://osu.ppy.sh]osu![/url]')).toEqual([])
  })
})
