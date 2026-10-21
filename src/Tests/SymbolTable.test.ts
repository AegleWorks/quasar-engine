import { describe, it, expect } from 'vitest'
import { GreenNode } from '../Syntax/GreenNode'
import { RedNode } from '../Syntax/RedNode'
import { SymbolTable } from '../Symbols/SymbolTable'
import type { NodeKind } from '../Types/core'

/** A detached node whose metadata is the only thing the symbol table reads. */
function node(
  start: number,
  width: number,
  metadata: Record<string, unknown>,
  kind: NodeKind = 'custom',
): RedNode {
  const green = new GreenNode(kind, '', [], 0, 0, width)
  return new RedNode(green, { kind, metadata, start })
}

/** A root over the given children, keeping the offsets the nodes were built with. */
function root(children: RedNode[]): RedNode {
  const width = children.reduce((max, child) => Math.max(max, child.range.end), 0)
  const green = new GreenNode('document', '', [], 0, 0, width)
  const doc = new RedNode(green, { kind: 'document', start: 0 })
  doc.initChildren(children)
  return doc
}

describe('SymbolTable', () => {
  it('resolves definitions, references and duplicate definitions', () => {
    const definition = node(0, 13, { id: 'hero' })
    const firstRef = node(20, 11, { goto: 'hero' })
    const duplicate = node(40, 13, { id: 'hero' })
    const other = node(60, 4, {})
    const table = new SymbolTable()
    table.build(root([definition, firstRef, duplicate, other]))

    expect(table.getAll()).toHaveLength(1)
    const symbol = table.get('hero')!
    expect(symbol.id).toBe('sym:hero@0')
    expect(symbol.definitionNodeId).toBe(definition.id)
    expect(symbol.references).toHaveLength(1)
    expect(symbol.references[0].range).toEqual({ start: 20, end: 31 })

    // The bug this test exists for: the lookup used to be by symbol ID in a
    // map keyed by name, so it always returned undefined.
    expect(table.getSymbolForNode(definition.id)).toBe(symbol)
    expect(table.getSymbolForNode(firstRef.id)).toBe(symbol)
    expect(table.getSymbolForNode(duplicate.id)).toBe(symbol)
    expect(table.getSymbolForNode(other.id)).toBeUndefined()
  })

  it('resolves a reference written before its definition', () => {
    const reference = node(0, 11, { goto: 'hero' })
    const definition = node(20, 13, { id: 'hero' })
    const table = new SymbolTable()
    table.build(root([reference, definition]))

    expect(table.get('hero')!.references).toHaveLength(1)
    expect(table.getSymbolForNode(reference.id)).toBe(table.get('hero'))
  })

  it('ignores a reference with no definition', () => {
    const reference = node(0, 11, { goto: 'missing' })
    const table = new SymbolTable()
    table.build(root([reference]))
    expect(table.getAll()).toHaveLength(0)
    expect(table.getSymbolForNode(reference.id)).toBeUndefined()
  })

  it('produces the same ids for the same document every time', () => {
    const build = (): string => {
      const table = new SymbolTable()
      table.build(root([node(7, 13, { id: 'hero' })]))
      return table.get('hero')!.id
    }
    expect(build()).toBe(build())
  })

  it('ranks search results and honours maxResults', () => {
    const children = [
      node(0, 1, { id: 'hero' }),
      node(2, 1, { id: 'heroic' }),
      node(4, 1, { id: 'subhero' }),
      node(6, 1, { id: 'other' }),
    ]
    const table = new SymbolTable()
    table.build(root(children))

    expect(table.search('hero').map(r => [r.symbol.name, r.score])).toEqual([
      ['hero', 100],
      ['heroic', 75],
      ['subhero', 50],
    ])
    expect(table.search('hero', 2).map(r => r.symbol.name)).toEqual(['hero', 'heroic'])
  })

  it('clears on rebuild and on clear()', () => {
    const table = new SymbolTable()
    table.build(root([node(0, 1, { id: 'a' })]))
    table.build(root([node(0, 1, { id: 'b' })]))
    expect(table.getAll().map(s => s.name)).toEqual(['b'])
    table.clear()
    expect(table.getAll()).toEqual([])
  })
})
