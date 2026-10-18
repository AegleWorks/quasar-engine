import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { TagRegistry } from '../Model/TagRegistry'
import type { Diagnostic } from '../Types/diagnostics'
import { registerValidatorFixes } from '../Fixes/validatorFixes'
import { getCodeFix, registerCodeFix, isAutomaticFix } from '../Fixes/CodeFixRegistry'
import { applyEditsToSource } from '../Edits/applyEdits'
import { fixToSurgicalEdits } from '../Edits/fixEdits'
import { LightbulbHost } from '../Fixes/LightbulbHost'
import { PluginAPI } from '../Plugins/PluginAPI'
import { MILIASTRY_ONLY_TAGS } from '../Visitors/BBCodeExporter'

/**
 * An automatic fix — one Fix-All applies without asking — must not change
 * what the reader sees. Checked per automatic finding over the real corpus
 * and over hand-picked shapes that used to break it.
 */

/** Visible render: ids stripped, and empty inline wrappers (which paint nothing) dropped. */
function visible(source: string): string {
  const model = new BBCodeDocumentModel({ source, autoAnalyze: false })
  let html = new HTMLRenderer({ registry: new TagRegistry(), idMode: 'none' }).render(model.redRoot!)
  for (let prev = ''; prev !== html;) {
    prev = html
    html = html.replace(/<(strong|em|u|s|del|span|a)\b[^>]*><\/\1>/g, '')
  }
  return html.replace(/\s+/g, ' ').trim()
}

function applyFix(source: string, d: Diagnostic): string {
  const ops = getCodeFix(d.code)!(d, { source, node: null })
  return applyEditsToSource(source, fixToSurgicalEdits({ description: '', isAutomatic: true, operations: ops }))
}

/** Codes whose automatic fix changes the destination on purpose (a broken link made to work). */
const INTENT_REPAIRS = new Set(['url-markdown-link', 'unicode-url'])

function automaticFindings(source: string): Diagnostic[] {
  const model = new BBCodeDocumentModel({ source })
  return model.diagnostics!.items.filter(d => isAutomaticFix(d) && !INTENT_REPAIRS.has(d.code))
}

afterEach(() => registerValidatorFixes())

describe('automatic fixes do not change the render', () => {
  const shapes = [
    '[box][/box]', '[spoilerbox][/spoilerbox]', '[quote][/quote]', '[notice][/notice]', '[heading][/heading]',
    '[code][/code]', '[list][*]a[*][*]b[/list]', 'line one\n[centre][/centre]\nline two', '[spoiler][/spoiler]',
    '[img][/img]', 'a [i][/i] b', 'a [b][/b] b', '[b][code]x', '[centre][c]x', '[box=A][code]x\n',
    '[url]www.osu.ppy.sh[/url]', '[center]x[/centre]', '[strike]x[/s]', '[strike]a[/s]b[/strike]',
    '[strike]sin cerrar', '[b]x[i]y', '[strike]x[/strike]', '[url=www.osu.ppy.sh]x[/url]',
  ]
  for (const shape of shapes) {
    it(JSON.stringify(shape), () => {
      registerValidatorFixes()
      for (const d of automaticFindings(shape)) {
        expect(visible(applyFix(shape, d)), `${d.code} on ${JSON.stringify(shape)}`).toBe(visible(shape))
      }
    })
  }

  const corpus = '/home/airi/Main Bridge/Miliastry/docs/ai'
  it.skipIf(!existsSync(corpus))('every automatic finding on the real corpus', () => {
    registerValidatorFixes()
    const files: string[] = []
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (!/\.(md|json|html)$/i.test(f)) files.push(p)
      }
    }
    walk(corpus)
    let checked = 0
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const before = visible(source)
      for (const d of automaticFindings(source)) {
        expect(visible(applyFix(source, d)), `${d.code} in ${file} @${d.range?.start}`).toBe(before)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})

describe('the fixes the render-neutral rule forced', () => {
  it('an empty block keeps a manual fix, an empty inline tag an automatic one', () => {
    registerValidatorFixes()
    const items = new BBCodeDocumentModel({ source: '[box][/box] a [b][/b] b' }).diagnostics!.items
      .filter(d => d.code === 'empty-tag')
    expect(items.map(d => [d.nodeKind, isAutomaticFix(d)])).toEqual([['box', false], ['bold', true]])
  })

  it('Fix-All deletes only the empty tags nobody can see', () => {
    registerValidatorFixes()
    const model = new BBCodeDocumentModel({ source: '[list][*]a[*][*]b[/list] [box][/box] x [b][/b]' })
    model.fixAll('empty-tag')
    expect(model.source).toBe('[list][*]a[*][*]b[/list] [box][/box] x ')
  })

  it('an unclosed tag around an unclosed [code] waits for the code to close', () => {
    registerValidatorFixes()
    const model = new BBCodeDocumentModel({ source: '[b][code]x' })
    const outer = model.diagnostics!.items.find(d => d.code === 'unclosed-tag' && d.nodeKind === 'bold')!
    expect(getCodeFix('unclosed-tag')!(outer, { source: model.source, node: null })).toEqual([])
    model.fixAll('unclosed-tag')
    expect(model.source).toBe('[b][code]x[/code][/b]')
  })

  it('fourteen nested unclosed tags close in one pass', () => {
    registerValidatorFixes()
    const tags = ['b', 'i', 'u', 's', 'centre', 'quote', 'notice', 'box=T', 'spoiler', 'heading', 'left', 'right', 'size=150', 'color=red']
    const model = new BBCodeDocumentModel({ source: tags.map(t => `[${t}]`).join('') + 'x' })
    const result = model.fixAll('unclosed-tag')
    expect(result.cycle).toBeUndefined()
    expect(result.passes).toBe(1)
    expect(model.diagnostics!.items.filter(d => d.code === 'unclosed-tag')).toHaveLength(0)
  })

  it('a deprecated tag whose rename would re-pair closers stays out of Fix-All', () => {
    registerValidatorFixes()
    const keyOf = (source: string) =>
      new BBCodeDocumentModel({ source }).diagnostics!.items.find(d => d.code === 'deprecated-tag')?.equivalenceKey
    expect(keyOf('[strike]x[/strike]')).toBe('deprecated-tag')
    expect(keyOf('[strike]x[/s]')).toBeUndefined()
    expect(keyOf('[strike]a[/s]b[/strike]')).toBeUndefined()
    expect(keyOf('[strike]sin cerrar')).toBeUndefined()
  })

  it('a missing scheme on a label-as-address goes into an attribute', () => {
    registerValidatorFixes()
    const source = '[url]www.osu.ppy.sh[/url]'
    const d = new BBCodeDocumentModel({ source }).diagnostics!.items.find(x => x.code === 'missing-url-protocol')!
    expect(applyFix(source, d)).toBe('[url=https://www.osu.ppy.sh]www.osu.ppy.sh[/url]')
  })
})

describe('the code-fix registry', () => {
  it('a plugin override survives the lightbulb, and unregistering restores the built-in', () => {
    registerValidatorFixes()
    const builtin = getCodeFix('unclosed-tag')
    const api = new PluginAPI(new BBCodeDocumentModel())
    const custom = () => []
    api.registerPlugin({ name: 'fx', version: '1' }, { codeFixes: [{ code: 'unclosed-tag', provider: custom }] })
    new LightbulbHost()
    expect(getCodeFix('unclosed-tag')).toBe(custom)
    api.unregisterPlugin('fx')
    expect(getCodeFix('unclosed-tag')).toBe(builtin)
  })

  it('two overrides of one code come off independently', () => {
    registerValidatorFixes()
    const builtin = getCodeFix('empty-tag')
    const a = () => []
    const b = () => []
    const offA = registerCodeFix('empty-tag', a)
    const offB = registerCodeFix('empty-tag', b)
    offB()
    expect(getCodeFix('empty-tag')).toBe(a)
    offA()
    expect(getCodeFix('empty-tag')).toBe(builtin)
  })

  it('re-registering a plugin name takes the first registration back', () => {
    const api = new PluginAPI(new BBCodeDocumentModel())
    api.registerPlugin({ name: 'same', version: '1' }, { tags: [{ name: 'alpha', kind: 'alpha', label: 'A', isInline: true, isSelfClosing: false, canHaveChildren: true }] as never })
    api.registerPlugin({ name: 'same', version: '2' }, { tags: [{ name: 'beta', kind: 'beta', label: 'B', isInline: true, isSelfClosing: false, canHaveChildren: true }] as never })
    api.unregisterPlugin('same')
    expect(api.tags.get('alpha')).toBeUndefined()
    expect(api.tags.get('beta')).toBeUndefined()
  })

  it('an async activate that rejects leaves the plugin inactive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = new PluginAPI(new BBCodeDocumentModel())
    api.registerPlugin({ name: 'async', version: '1' }, { activate: async () => { throw new Error('nope') } })
    await new Promise(r => setTimeout(r, 0))
    expect(api.plugins.get('async')!.active).toBe(false)
    warn.mockRestore()
  })

  it('the exported tag sets are read-only', () => {
    expect(() => (MILIASTRY_ONLY_TAGS as Set<string>).delete('font')).toThrow()
    expect(MILIASTRY_ONLY_TAGS.has('font')).toBe(true)
  })
})
