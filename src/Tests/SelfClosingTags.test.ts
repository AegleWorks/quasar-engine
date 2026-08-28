import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { repairNesting } from '../Repair/NestingRepair'

/**
 * Regression: a tag with no closing form is not an unclosed tag.
 *
 * `isUnclosedTag` decides by reading the source back — a tag the author closed
 * ends in its own `[/name]`, one the parser closed for them does not. That rule
 * is exact for paired tags and simply wrong for void ones. Lyne's `[hr]` and
 * `[separator=…]` are emitted by the parser as a single leaf spanning `[`..`]`;
 * there is no closing form and there never will be, so every horizontal rule
 * failed the check.
 *
 * Two consumers acted on it. The `unclosed-tag` validator warned about a
 * mistake the author had not made, and — the damaging one — `repairNesting`
 * shares the same predicate, so "repairing" a document inserted `[/separator]`
 * into the author's source, which osu!/Lyne then render as literal text.
 *
 * `list_item` was already exempt for exactly this reason (`[*]` has no closer
 * either); the fix is that the exemption is now about void tags in general
 * rather than about the one that happened to be noticed first.
 */
describe('self-closing Lyne tags', () => {
  const lyne = (source: string) => new BBCodeDocumentModel({ source, mode: 'lyne' })

  const codesFor = (source: string): string[] =>
    lyne(source).analyze().diagnostics.items.map(d => d.code)

  describe('the unclosed-tag validator', () => {
    it('does not flag [hr]', () => {
      expect(codesFor('Antes\n\n[hr]\n\nDespues')).not.toContain('unclosed-tag')
    })

    it('does not flag [separator=stars]', () => {
      expect(codesFor('Antes\n\n[separator=stars]\n\nDespues')).not.toContain('unclosed-tag')
    })

    it('still flags a genuinely unclosed tag in the same document', () => {
      // The exemption must be narrow: a real mistake sitting next to a rule is
      // still reported, so this is not just the validator going quiet.
      expect(codesFor('[hr]\n\n[b]sin cerrar')).toContain('unclosed-tag')
    })
  })

  describe('the empty-tag validator', () => {
    it('does not flag [hr] as an empty tag', () => {
      expect(codesFor('Antes\n\n[hr]\n\nDespues')).not.toContain('empty-tag')
    })

    it('reports nothing at all for a document whose only tag is a rule', () => {
      // The whole point, stated once: a horizontal rule is not a defect of any
      // kind. `[hr]` used to trip BOTH validators — `empty-tag` because a void
      // leaf has no children and no text, `unclosed-tag` because it has no
      // closing form — so an author got two diagnostics for writing a line.
      expect(codesFor('Antes\n\n[hr]\n\nDespues')).toEqual([])
      expect(codesFor('Antes\n\n[separator=stars]\n\nDespues')).toEqual([])
    })

    it('still flags a genuinely empty tag that could have held content', () => {
      // Narrowness control. `[b][/b]` has a content slot and nothing in it,
      // which is exactly what this validator is for; the exemption must not
      // have widened into "leaf nodes are never empty".
      expect(codesFor('[b][/b]')).toContain('empty-tag')
    })

    it('still flags an empty list item, which has a content slot', () => {
      // `list_item` shares the "no closing form" property with `separator` and
      // is deliberately NOT exempt here: `[*]` can hold content, so an empty
      // one is a real observation. This pins the two sets apart.
      expect(codesFor('[list][*][/list]')).toContain('empty-tag')
    })
  })

  describe('repairNesting', () => {
    const repairLyne = (source: string) => repairNesting(source, lyne(source).root)

    it('leaves a document whose only "problem" is an [hr] untouched', () => {
      const source = 'Antes\n\n[hr]\n\nDespues'
      const repair = repairLyne(source)

      expect(repair.hasChanges).toBe(false)
      expect(repair.source).toBe(source)
      expect(repair.unclosed).toEqual([])
    })

    it('does not write a [/separator] into the author\'s source', () => {
      const source = '[separator=stars]'
      const repair = repairLyne(source)

      expect(repair.source).not.toContain('[/separator]')
      expect(repair.source).toBe(source)
    })

    it('still closes a real unclosed tag, and only that one', () => {
      const source = '[hr]\n\n[b]sin cerrar'
      const repair = repairLyne(source)

      expect(repair.unclosed.map(u => u.tag)).toEqual(['b'])
      expect(repair.source).toBe('[hr]\n\n[b]sin cerrar[/b]')
    })
  })
})
