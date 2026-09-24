import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { applyEffect, type TreeEffect } from '../Utils/treeTransformers'
import { checkRedTree } from '../Syntax/redTreeInvariants'
import type { RedNode } from '../Syntax/RedNode'

/**
 * The effect transformers return a NEW tree and must leave their input alone.
 *
 * They did not: media and code leaves (and empty text) were handed back as
 * the input's own node, and `appendChild` then reparented that node into the
 * output. The input tree kept listing it, but the node now claimed a parent
 * in the other tree — its `index`, its siblings (which the HTML renderer
 * walks) and every range lookup through it went wrong. Found by
 * `checkRedTree`.
 */

const SOURCE = '[b]hola [img]https://a.b/c.png[/img] mundo[/b]\n\n[code]x = 1[/code]\n\n[i][/i] fin'

function shape(n: RedNode): string {
  return `${n.id}:${n.kind}(${n.children.map(c => (c.parent === n ? '' : '!') + shape(c)).join(',')})`
}

const EFFECTS: TreeEffect[] = [
  { kind: 'gradient', colors: ['#ff0000', '#0000ff'] },
  { kind: 'grow' },
  { kind: 'rainbow' },
  { kind: 'central_gradient', colors: ['#ff0000', '#00ff00'] },
  { kind: 'multi_gradient', colors: ['#ff0000', '#00ff00', '#0000ff'] },
]

describe('tree effects leave their input untouched', () => {
  it.each(EFFECTS.map(e => [e.kind, e] as const))('%s', (_name, effect) => {
    const root = new BBCodeDocumentModel({ source: SOURCE, dialect: 'osu', autoAnalyze: false }).redRoot!
    const before = shape(root)
    const out = applyEffect(root, effect)
    expect(out).not.toBe(root)
    expect(shape(root)).toBe(before)
    expect(checkRedTree(root, { source: SOURCE })).toEqual([])
  })
})
