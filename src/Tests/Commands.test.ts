import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { createCommandRegistry } from '../Commands'
import type { CommandInput, CommandResult } from '../Commands'
import type { RedNode } from '../Syntax/RedNode'
import type { TextChange } from '../Incremental/ChangeTracker'

/**
 * The built-in commands are PLANNERS: they return the text changes that make
 * the edit and never touch the model. The host applies those changes — Monaco
 * as one undo stop, the canvas as one surgical edit, a test like this one as
 * a string replacement.
 */

function first(node: RedNode, kind: string): RedNode | null {
  if (node.kind === kind) return node
  for (const child of node.children) {
    const found = first(child, kind)
    if (found) return found
  }
  return null
}

function applyChanges(source: string, changes: readonly TextChange[]): string {
  let out = source
  for (const change of [...changes].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, change.start) + change.text + out.slice(change.end)
  }
  return out
}

function run(
  source: string,
  id: string,
  input?: CommandInput,
  selection: { start: number; end: number } = { start: 0, end: 0 },
  nodeKind?: string,
): { result: CommandResult; source: string; out: string } {
  const model = new BBCodeDocumentModel({ source })
  const root = model.redRoot!
  const node = nodeKind ? first(root, nodeKind) : null
  const result = createCommandRegistry().execute(
    id,
    { model, root, selection: { ...selection, nodeId: node?.id } },
    input,
  )
  return { result, source, out: applyChanges(source, result.changes ?? []) }
}

describe('the command registry', () => {
  it('ships the five built-ins registered', () => {
    expect(createCommandRegistry().getAll().map((c) => c.id).sort()).toEqual([
      'delete-node',
      'insert-text',
      'merge-nodes',
      'split-node',
      'wrap-in-tag',
    ])
  })

  it('still accepts host commands and reports unknown ids', () => {
    const registry = createCommandRegistry()
    registry.register({
      id: 'mi-comando',
      label: 'Mío',
      execute: () => ({ success: true, message: 'hola' }),
    })
    expect(registry.get('mi-comando')?.label).toBe('Mío')

    const model = new BBCodeDocumentModel({ source: 'hola' })
    const result = registry.execute('no-existe', { model, root: model.redRoot! })
    expect(result).toEqual({ success: false, message: 'Unknown command: no-existe' })
  })
})

describe('insert-text', () => {
  it('inserts at a caret', () => {
    const { result, out } = run('hola', 'insert-text', { type: 'insertText', text: 'X' }, { start: 2, end: 2 })
    expect(out).toBe('hoXla')
    expect(result.success).toBe(true)
    expect(result.selection).toEqual({ start: 3, end: 3 })
  })

  it('replaces a range and keeps the tags it cuts', () => {
    const { out } = run(
      '[b]hola[/b] mundo',
      'insert-text',
      { type: 'insertText', text: 'X' },
      { start: 3, end: 7 },
    )
    expect(out).toBe('[b]X[/b] mundo')
  })

  it('parses content with the document dialect to find block content', () => {
    const { out } = run(
      '[b]hola[/b]',
      'insert-text',
      { type: 'insertText', text: '[box]A[/box]' },
      { start: 4, end: 4 },
    )
    expect(out).toBe('[b]hola[/b][box]A[/box]')
  })

  it('refuses a missing or wrong payload', () => {
    const model = new BBCodeDocumentModel({ source: 'hola' })
    const registry = createCommandRegistry()
    expect(registry.execute('insert-text', { model, root: model.redRoot! }).success).toBe(false)
    expect(
      registry.execute(
        'insert-text',
        { model, root: model.redRoot!, selection: { start: 0, end: 0 } },
        { type: 'wrap', tag: 'b' },
      ).success,
    ).toBe(false)
  })
})

describe('wrap-in-tag', () => {
  it('wraps a selection in b/i/u/s by toggling', () => {
    expect(run('hola', 'wrap-in-tag', { type: 'wrap', tag: 'b' }, { start: 0, end: 4 }).out).toBe('[b]hola[/b]')
    expect(run('hola', 'wrap-in-tag', { type: 'wrap', tag: 'u' }, { start: 0, end: 4 }).out).toBe('[u]hola[/u]')
  })

  it('toggles an existing format off', () => {
    const { out } = run('[b]hola[/b]', 'wrap-in-tag', { type: 'wrap', tag: 'b' }, { start: 3, end: 7 })
    expect(out).toBe('hola')
  })

  it('wraps in an arbitrary inline tag, with attributes', () => {
    expect(run('hola', 'wrap-in-tag', { type: 'wrap', tag: 'font', attrs: 'Arial' }, { start: 0, end: 4 }).out)
      .toBe('[font=Arial]hola[/font]')
    expect(run('hola', 'wrap-in-tag', { type: 'wrap', tag: 'size', attrs: '150' }, { start: 0, end: 4 }).out)
      .toBe('[size=150]hola[/size]')
  })

  it('refuses block tags and attributes on a toggle', () => {
    expect(run('hola', 'wrap-in-tag', { type: 'wrap', tag: 'box' }, { start: 0, end: 4 }).result.success).toBe(false)
    expect(run('hola', 'wrap-in-tag', { type: 'wrap', tag: 'b', attrs: 'x' }, { start: 0, end: 4 }).result.success)
      .toBe(false)
  })
})

describe('delete-node', () => {
  it('deletes a node by id', () => {
    const { out } = run('[b]hola[/b] mundo', 'delete-node', undefined, { start: 3, end: 3 }, 'bold')
    expect(out).toBe(' mundo')
  })

  it('deletes a selected range when it is not collapsed', () => {
    const { out } = run('[b]hola[/b] mundo', 'delete-node', undefined, { start: 3, end: 7 })
    expect(out).toBe('[b][/b] mundo')
  })

  it('needs a node or a range', () => {
    expect(run('hola', 'delete-node', undefined, { start: 1, end: 1 }).result.success).toBe(false)
  })
})

describe('split-node and merge-nodes', () => {
  it('splits a line at the caret', () => {
    const { out, result } = run('uno dos', 'split-node', undefined, { start: 3, end: 3 })
    // The space after the caret begins the new line, as in any editor.
    expect(out).toBe('uno\n dos')
    expect(result.selection).toEqual({ start: 4, end: 4 })
  })

  it('merges backward (Backspace)', () => {
    const { out, result } = run('uno\ndos', 'merge-nodes', undefined, { start: 4, end: 4 })
    expect(out).toBe('unodos')
    expect(result.selection).toEqual({ start: 3, end: 3 })
  })

  it('merges forward (Delete)', () => {
    const { out, result } = run('uno\ndos', 'merge-nodes', { type: 'merge', direction: 'forward' }, { start: 3, end: 3 })
    expect(out).toBe('unodos')
    expect(result.selection).toEqual({ start: 3, end: 3 })
  })

  it('split needs a caret, not a range', () => {
    expect(run('uno dos', 'split-node', undefined, { start: 1, end: 3 }).result.success).toBe(false)
  })

  it('merging at the start of the document is an honest no-op', () => {
    const { result, out } = run('hola', 'merge-nodes', undefined, { start: 0, end: 0 })
    expect(out).toBe('hola')
    expect(result.changes).toEqual([])
    expect(result.message).toBe('Nothing to merge')
  })
})

describe('commands plan and do not mutate', () => {
  it('leaves the model source and tree untouched', () => {
    const model = new BBCodeDocumentModel({ source: '[b]hola[/b]' })
    const root = model.redRoot!
    const before = root.range.end
    const result = createCommandRegistry().execute(
      'insert-text',
      { model, root, selection: { start: 4, end: 4 } },
      { type: 'insertText', text: 'X' },
    )
    expect(result.success).toBe(true)
    expect(result.changes?.length).toBeGreaterThan(0)
    expect(model.source).toBe('[b]hola[/b]')
    expect(root.range.end).toBe(before)
  })
})
