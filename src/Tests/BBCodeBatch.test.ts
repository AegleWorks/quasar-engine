/**
 * The batch renderer must be byte-identical to the model path it replaces,
 * and reusing one renderer across pages must not leak state from one page
 * into the next.
 */

import { describe, expect, it } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import {
  BBCodeBatchRenderer,
  renderBBCode,
  renderBBCodeMany,
  renderBBCodeStream,
  type BBCodeRenderOptions,
} from '../BBCode/BBCodeBatch'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import type { BBCodeDialect } from '../BBCode/BBCodeToGreenNode'

const SOURCES = [
  '[b]hola[/b] [i]mundo[/i]',
  '[box=Title]body [color=#ff0000]red[/color][/box]',
  '[centre][img]https://example.com/a.png[/img][/centre]',
  '[quote="Author"]one\n\ntwo[/quote]\n[list][*]a[*]b[/list]',
  '[b]crossed[i]tags[/b] here[/i]',
  '[url=https://osu.ppy.sh/users/2]peppy[/url]',
  '[notice]line one\nline two[/notice]',
  '',
]

function expected(source: string, options: BBCodeRenderOptions): string {
  const model = new BBCodeDocumentModel({
    // The fast path spans a blank page as one space; compare against that.
    source: source || ' ',
    dialect: options.dialect,
    pairing: options.pairing,
    autoAnalyze: false,
    maxUndo: 0,
    incremental: false,
  })
  if (!model.redRoot) return ''
  return new HTMLRenderer({
    ...options,
    registry: model.tagRegistry,
    idMode: 'none',
  }).render(model.redRoot)
}

const CASES: Array<{ dialect: BBCodeDialect; pairing: 'quasar' | 'osu' }> = [
  { dialect: 'miliastry', pairing: 'quasar' },
  { dialect: 'osu', pairing: 'osu' },
  { dialect: 'lyne', pairing: 'quasar' },
]

describe('BBCode batch renderer', () => {
  for (const { dialect, pairing } of CASES) {
    it(`matches the model path (${dialect}/${pairing})`, () => {
      for (const source of SOURCES) {
        const options: BBCodeRenderOptions = {
          dialect,
          theme: dialect === 'lyne' ? 'lyne' : 'osu',
          pairing,
        }
        expect(renderBBCode(source, options)).toBe(expected(source, options))
      }
    })
  }

  it('reuses one renderer without leaking state across pages', () => {
    const options: BBCodeRenderOptions = { dialect: 'osu', theme: 'osu', pairing: 'osu' }
    const batch = new BBCodeBatchRenderer(options)
    const many = batch.renderMany(SOURCES)
    const streamed = [...batch.stream(SOURCES)]
    const individually = SOURCES.map((source) => renderBBCode(source, options))

    expect(many).toEqual(individually)
    expect(streamed).toEqual(individually)
    expect(renderBBCodeMany(SOURCES, options)).toEqual(individually)
    expect([...renderBBCodeStream(SOURCES, options)]).toEqual(individually)
  })

  it('reports parse and render time without changing the HTML', () => {
    const batch = new BBCodeBatchRenderer({ dialect: 'osu', theme: 'osu', pairing: 'osu' })
    const source = SOURCES[1]

    const detailed = batch.renderDetailed(source)
    expect(detailed.html).toBe(batch.render(source))
    expect(detailed.parseMs).toBeGreaterThanOrEqual(0)
    expect(detailed.renderMs).toBeGreaterThanOrEqual(0)
  })

  it('keeps the model static helpers on the batch path', () => {
    const options: BBCodeRenderOptions = { dialect: 'osu', theme: 'osu', pairing: 'osu' }
    const expectedPages = SOURCES.map((source) => renderBBCode(source, options))

    expect(BBCodeDocumentModel.renderMany(SOURCES, options)).toEqual(expectedPages)
    expect(SOURCES.map((source) => BBCodeDocumentModel.renderForum(source, options))).toEqual(expectedPages)
  })

  it('renders a blank page the same way the model fast path does', () => {
    // A blank page is parsed as one space, exactly like the old fast path.
    expect(renderBBCode('')).toBe(renderBBCode(' '))
    expect(renderBBCode('   ')).toBe(expected('   ', { dialect: 'miliastry' }))
  })
})
