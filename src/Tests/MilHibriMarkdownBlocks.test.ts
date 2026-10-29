import { describe, it, expect } from 'vitest'
import { rewriteMarkdownBlocks } from '../MilHibri/MarkdownBlocks'

describe('MilHibri — Markdown blocks rewritten as BBCode', () => {
  it('rewrites headings, lists, quotes, containers and fences in one pass', () => {
    const source = [
      '[box=T]',
      '# Heading',
      '- one',
      '- two',
      '> **peppy**',
      '> quoted',
      '::: details More',
      'inside',
      ':::',
      '```ts',
      'const a = 1',
      '```',
      '[/box]',
    ].join('\n')

    const result = rewriteMarkdownBlocks(source)

    expect(result.changed).toBe(true)
    expect(result.source).toContain('[heading]Heading[/heading]')
    expect(result.source).toContain('[list]')
    expect(result.source).toContain('[*]one')
    expect(result.source).toContain('[*]two')
    expect(result.source).toContain('[quote="peppy"]')
    expect(result.source).toContain('[box=More]')
    expect(result.source).toContain('[code]')
    expect(result.source).toContain('[/code]')
  })

  it('leaves literal BBCode bodies byte-for-byte', () => {
    const source = '[code]\n# not a heading\n> not a quote\n[/code]'

    const result = rewriteMarkdownBlocks(source)

    expect(result.changed).toBe(false)
    expect(result.source).toBe(source)
  })

  it('returns a pure BBCode document unchanged by reference', () => {
    const source = '[box=T]\ntext\n[/box]'

    const result = rewriteMarkdownBlocks(source)

    expect(result.changed).toBe(false)
    expect(result.source).toBe(source)
  })

  it('preserves CRLF line endings', () => {
    const source = '[box=T]\r\n# Heading\r\n[/box]'

    const result = rewriteMarkdownBlocks(source)

    expect(result.changed).toBe(true)
    expect(result.source).toContain('[heading]Heading[/heading]\r\n')
    expect(result.source).not.toContain('\n# Heading')
  })
})
