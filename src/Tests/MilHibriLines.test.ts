import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { MarkdownDocumentModel } from '../Markdown/MarkdownDocumentModel'
import { MilHibriDocumentModel } from '../MilHibri/MilHibriDocumentModel'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

const renderer = new HTMLRenderer()
const exporter = new BBCodeExporter(undefined, 'miliastry')

function milHibri(source: string): string {
  return renderer.render(MilHibriDocumentModel.fromSource(source).redRoot!)
}

function exportMilHibri(source: string): string {
  return exporter.export(MilHibriDocumentModel.fromSource(source).redRoot!)
}

/** Ids are per-tree bookkeeping; the shape is what these tests are about. */
function shape(html: string): string {
  return html.replace(/ data-node-id="[^"]*"/g, '')
}

function breaks(html: string): number {
  return (html.match(/<br[^>]*>/g) ?? []).length
}

describe('MilHibri line behaviour — BBCode lines, not Markdown soft wraps', () => {
  it('turns every newline into its own line', () => {
    const html = shape(milHibri('uno\ndos\ntres'))

    expect(html).toBe(
      '<span class="bb-paragraph">uno</span><br>'
      + '<span class="bb-paragraph">dos</span><br>'
      + '<span class="bb-paragraph">tres</span>',
    )
    expect(html).not.toContain('uno\ndos')
  })

  it('renders one blank line per extra newline and exports them all', () => {
    expect(shape(milHibri('uno\n\ndos'))).toBe(
      '<span class="bb-paragraph">uno</span><br>'
      + '<div class="bb-empty-line"><br></div>'
      + '<span class="bb-paragraph">dos</span>',
    )
    expect(exportMilHibri('uno\n\n\ndos')).toBe('uno\n\n\ndos')
  })

  it('keeps a trailing newline, as BBCode does', () => {
    expect(exportMilHibri('uno\ndos\n')).toBe('uno\ndos\n')
    expect(shape(milHibri('uno\ndos\n'))).toMatch(/dos<\/span><br>$/)
  })

  it('breaks lines inside a box without adding a line at its edges', () => {
    const source = '[box=T]\nuno\ndos\n[/box]'
    const html = shape(milHibri(source))

    // A pure BBCode box is parsed by the BBCode engine, so its inline runs
    // are not wrapped in MilHibri's `bb-paragraph` spans. The line rule is
    // still the one that matters: one `<br>` between the lines, none at the
    // box's own edges.
    expect(html).toContain('>uno<br>dos<')
    expect(html).not.toMatch(/<br><br>/)
    expect(html).toContain('dos<span data-bb-nl hidden></span></div>')
    expect(exportMilHibri(source)).toBe(source)
  })

  it('keeps a blank line inside a box', () => {
    const source = '[box=T]\nuno\n\ndos\n[/box]'

    expect(shape(milHibri(source))).toContain(
      'uno<br><div class="bb-empty-line"><br></div>dos',
    )
    expect(exportMilHibri(source)).toBe(source)
  })

  it('puts every notice and quote line on its own line', () => {
    for (const tag of ['notice', 'quote'] as const) {
      const html = shape(milHibri(`[${tag}]\nuno\ndos\n[/${tag}]`))
      expect(html, tag).toContain('uno<br>dos')
    }
  })

  it('counts exactly the newlines BBCode counts on a mixed document', () => {
    const source = 'uno\ndos\n\ntres\n[box=T]\na\nb\n[/box]\nfin'
    const bbcode = new BBCodeDocumentModel({ source })

    expect(breaks(milHibri(source))).toBe(breaks(renderer.render(bbcode.redRoot!)))
  })

  it('leaves the Markdown importer on its soft-break rule', () => {
    const html = renderer.render(new MarkdownDocumentModel({ source: 'uno\ndos' }).redRoot!)

    expect(html).toContain('uno\ndos')
  })
})
