import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { MarkdownDocumentModel } from '../Markdown/MarkdownDocumentModel'
import { MarkdownExporter } from '../Visitors/MarkdownExporter'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import type { RedNode } from '../Syntax/RedNode'

const exporter = new MarkdownExporter()
const renderer = new HTMLRenderer({ dialect: 'miliastry', theme: 'osu' })

function fromBBCode(source: string): string {
  const model = new BBCodeDocumentModel({ source, autoAnalyze: false })
  return exporter.export(model.redRoot!)
}

function importMarkdown(markdown: string): RedNode {
  return new MarkdownDocumentModel({ source: markdown }).redRoot!
}

function kinds(root: RedNode): string[] {
  const out: string[] = []
  root.walk(node => { out.push(node.kind) })
  return out
}

describe('MarkdownExporter — blocks are separated', () => {
  it('puts a blank line between a heading and the paragraph after it', () => {
    expect(fromBBCode('[heading]Title[/heading]\n\nBody')).toBe('# Title\n\nBody')
  })

  it('never emits a horizontal rule directly under text', () => {
    const markdown = fromBBCode('Paragraph.\n\n[separator]')
    expect(markdown).toBe('Paragraph.\n\n[separator]')
    const roundTripped = exportAgain(markdown)
    // The document knows `[separator]` as BBCode; on import it becomes a rule,
    // and the rule keeps its blank line so it can never be read as a setext
    // heading.
    expect(roundTripped).toBe('Paragraph.\n\n---')
    expect(renderer.render(importMarkdown(roundTripped))).toContain('<hr')
  })

  it('puts a blank line between a list and the text after it', () => {
    const markdown = fromBBCode('[list][*]a[*]b[/list]\n\nAfter')
    expect(markdown).toBe('- a\n- b\n\nAfter')
    expect(kinds(importMarkdown(markdown))).toEqual(expect.arrayContaining(['list', 'list_item', 'paragraph']))
  })

  it('puts a blank line around a fenced code block', () => {
    const markdown = fromBBCode('Before\n\n[code]x = 1[/code]\n\nAfter')
    expect(markdown).toBe('Before\n\n```\nx = 1\n```\n\nAfter')
    const root = importMarkdown(markdown)
    expect(kinds(root)).toContain('code')
    expect(kinds(root).filter(k => k === 'paragraph')).toHaveLength(2)
  })

  it('puts a blank line between a quote and the text after it', () => {
    const markdown = fromBBCode('[quote=Ana]hi[/quote]\n\nAfter')
    expect(markdown).toBe('> **Ana**\n> hi\n\nAfter')
  })

  it('does not collapse blank lines inside a fenced code block', () => {
    const markdown = '```\na\n\n\n\nb\n```'
    expect(exporter.export(importMarkdown(markdown))).toBe(markdown)
  })

  it('is a fixed point after the XML-ish tags become Markdown', () => {
    const sources = [
      '[heading]H[/heading]\n\nBody',
      '[list][*]a[*]b[/list]\n\nAfter',
      '[quote=Ana]q[/quote]\n\n[heading]H[/heading]',
      '[notice]warn[/notice]\n\n[box=T]body[/box]',
    ]
    for (const source of sources) {
      const once = fromBBCode(source)
      const twice = exportAgain(once)
      expect(twice, source).toBe(once)
    }
  })
})

describe('Markdown importer — malformed hybrid BBCode recovery', () => {
  it('keeps the text after a self-closing tag', () => {
    const root = importMarkdown('before\n\n[separator]\n\n# After')
    const found = kinds(root)
    expect(found).toContain('separator')
    expect(found).toContain('heading')
    expect(renderer.render(root)).toContain('<hr')
    expect(renderer.render(root)).toContain('<h2')
  })

  it('does not let an unmatched block tag swallow the rest', () => {
    const markdown = '[box=T]unclosed\n\n# Still here'
    const root = importMarkdown(markdown)
    expect(renderer.render(root)).toContain('Still here')
    expect(renderer.render(root)).toContain('<h2')
  })

  it('does not let an unmatched inline tag swallow the rest', () => {
    const markdown = '[b]unclosed and [i]italic[/i]'
    const root = importMarkdown(markdown)
    // `[b]` had no closer, so it stays literal; the `[i]` that does close still
    // renders as markup.
    expect(renderer.render(root)).toContain('[b]')
    expect(renderer.render(root)).toContain('<em')
  })

  it('keeps a code block unclosed to EOF as code', () => {
    const root = importMarkdown('[code]let x = 1\nlet y = 2')
    const html = renderer.render(root)
    expect(html).toContain('<pre')
    expect(html).toContain('let y = 2')
  })
})

function exportAgain(markdown: string): string {
  return exporter.export(importMarkdown(markdown))
}
