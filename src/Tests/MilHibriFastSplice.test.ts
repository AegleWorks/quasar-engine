import { describe, expect, it } from 'vitest'
import { MilHibriDocumentModel } from '../MilHibri/MilHibriDocumentModel'
import type { RedNode } from '../Syntax/RedNode'

/**
 * A source big enough for the fast path (>= 4000 bytes), made only of osu!
 * BBCode: no Markdown block is rewritten, so the green tree partitions the
 * source and every leaf offset is a real source offset.
 */
function fixture(): string {
  const lines: string[] = []
  for (let i = 0; i < 80; i++) {
    const hex = (0x100000 + i * 0x020305).toString(16).padStart(6, '0').toUpperCase()
    lines.push(`[color=#${hex}]Paragraph ${i} has enough plain prose to type into safely.[/color]`)
  }
  return `[box=Prose]\n${lines.join('\n')}\n[/box]\n`
}

function dump(root: RedNode): string {
  const out: string[] = []
  const walk = (node: RedNode): void => {
    out.push(`${node.kind}@${node.range.start}-${node.range.end}|${node.text}`)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return out.join('\n')
}

function findByText(root: RedNode, text: string): RedNode | null {
  if (root.kind === 'text' && root.text === text) return root
  for (const child of root.children) {
    const hit = findByText(child, text)
    if (hit) return hit
  }
  return null
}

function positionInProse(source: string): number {
  const anchor = 'Paragraph 40 has enough plain prose'
  const at = source.indexOf(anchor)
  if (at === -1) throw new Error('fixture anchor missing')
  return at + anchor.length
}

describe('MilHibri text-leaf fast path', () => {
  it('types a letter through a leaf splice and the tree matches a full import', () => {
    const source = fixture()
    const model = new MilHibriDocumentModel({ source, autoAnalyze: false })
    const at = positionInProse(source)
    const inserted = source.slice(0, at) + 'X' + source.slice(at)

    model.applyChange({ start: at, end: at, text: 'X' })

    expect(model.source).toBe(inserted)
    expect(model.lastReparsePath).toBe('text_leaf')
    expect(model.lastReparseWindow).toEqual({ start: at, end: at + 1 })
    expect(dump(model.redRoot!)).toBe(dump(new MilHibriDocumentModel({ source: inserted, autoAnalyze: false }).redRoot!))
  })

  it('keeps the ids of untouched siblings across the splice', () => {
    const source = fixture()
    const model = new MilHibriDocumentModel({ source, autoAnalyze: false })
    const untouched = findByText(model.redRoot!, 'Paragraph 10 has enough plain prose to type into safely.')
    const edited = findByText(model.redRoot!, 'Paragraph 40 has enough plain prose to type into safely.')
    expect(untouched).not.toBeNull()
    expect(edited).not.toBeNull()

    model.applyChange({ start: positionInProse(source), end: positionInProse(source), text: 'Y' })

    expect(model.lastReparsePath).toBe('text_leaf')
    expect(findByText(model.redRoot!, untouched!.text)!.id).toBe(untouched!.id)
    const anchor = 'Paragraph 40 has enough plain prose'
    const editedAfter = anchor + 'Y' + edited!.text.slice(anchor.length)
    // The edited leaf is a genuinely new node; only its unaffected siblings
    // are adopted.
    expect(findByText(model.redRoot!, editedAfter)!.id).not.toBe(edited!.id)
  })

  it('falls back to a full import when the edit touches syntax', () => {
    const source = fixture()
    const model = new MilHibriDocumentModel({ source, autoAnalyze: false })
    const at = positionInProse(source)
    const inserted = source.slice(0, at) + '[' + source.slice(at)

    model.applyChange({ start: at, end: at, text: '[' })

    expect(model.source).toBe(inserted)
    expect(model.lastReparsePath).toBe('full_rebuild')
    expect(dump(model.redRoot!)).toBe(dump(new MilHibriDocumentModel({ source: inserted, autoAnalyze: false }).redRoot!))
  })

  it('falls back for a Markdown-special character even inside prose', () => {
    const source = fixture()
    const model = new MilHibriDocumentModel({ source, autoAnalyze: false })
    const at = positionInProse(source)

    model.applyChange({ start: at, end: at, text: "'" })

    expect(model.lastReparsePath).toBe('full_rebuild')
  })
})
