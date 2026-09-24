import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

/**
 * A render's id mode belongs to its renderer, not to the process.
 *
 * `renderForum` used to switch ids off by writing the static
 * `HTMLRenderer.idMode` and restoring it afterwards, so any other renderer
 * that painted in between inherited `'none'`. The resolver callbacks are
 * exactly such a window: they run in the middle of the forum render, and a
 * host that renders a preview from one got an HTML with no `data-node-id` —
 * clicks in it resolved nothing.
 */
describe('HTMLRenderer — id mode is per renderer', () => {
  const editorDoc = new BBCodeDocumentModel({ source: '[notice]editor[/notice]', dialect: 'osu' })
  const editorRenderer = new HTMLRenderer({ dialect: 'osu' })

  it('renderForum renders without ids and leaves the process default alone', () => {
    const before = HTMLRenderer.idMode
    const html = BBCodeDocumentModel.renderForum('[b]hola[/b] [notice]x[/notice]', { dialect: 'osu' })
    expect(html).not.toContain('data-node-id')
    expect(HTMLRenderer.idMode).toBe(before)
  })

  it('a renderer that paints DURING a forum render keeps its own ids', () => {
    let inner = ''
    BBCodeDocumentModel.renderForum('[profile]peppy[/profile]', {
      dialect: 'osu',
      entityLinkResolver: () => {
        inner = editorRenderer.render(editorDoc.redRoot!)
        return null
      },
    })
    expect(inner).not.toBe('')
    expect(inner).toContain('data-node-id')
  })

  it('the option overrides the default in both directions', () => {
    const root = editorDoc.redRoot!
    expect(new HTMLRenderer({ dialect: 'osu', idMode: 'none' }).render(root)).not.toContain('data-node-id')
    const blocks = new HTMLRenderer({ dialect: 'osu', idMode: 'blocks' }).render(root)
    expect(blocks).toContain('data-node-id')
    // No option: whatever the process default says, as before.
    expect(editorRenderer.render(root)).toBe(new HTMLRenderer({ dialect: 'osu', idMode: HTMLRenderer.idMode }).render(root))
  })
})
