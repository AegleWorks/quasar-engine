import { describe, it, expect, vi, afterEach } from 'vitest'
import type { GreenNode } from '../Syntax/GreenNode'
import type { RedNode } from '../Syntax/RedNode'

/**
 * `QUASAR_VALIDATE_TREES=1` turns `checkRedTree` into an assertion after every
 * rebuild and reparse. The flag is read once at module load, so each case
 * imports a fresh copy of the model with the environment it needs.
 */
async function freshModel(flag: string | undefined) {
  vi.resetModules()
  if (flag === undefined) vi.unstubAllEnvs()
  else vi.stubEnv('QUASAR_VALIDATE_TREES', flag)
  const { BBCodeDocumentModel } = await import('../BBCode/BBCodeDocumentModel')
  /** Builds a tree whose second block sits three characters off. */
  class Broken extends BBCodeDocumentModel {
    protected buildRedFromGreen(green: GreenNode): RedNode {
      const red = super.buildRedFromGreen(green)
      red.children[1]?.setStart(red.children[1].range.start + 3)
      return red
    }
  }
  return { BBCodeDocumentModel, Broken }
}

describe('QUASAR_VALIDATE_TREES', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('on: a model that builds a broken tree fails loudly, naming the violation', async () => {
    const { BBCodeDocumentModel, Broken } = await freshModel('1')
    expect(() => new BBCodeDocumentModel({ source: 'uno\n\n[b]dos[/b]' })).not.toThrow()
    expect(() => new Broken({ source: 'uno\n\n[b]dos[/b]' })).toThrow(/QUASAR_VALIDATE_TREES\] after rebuild[\s\S]*range at document\//)
  })

  it('off (the default): nothing is checked', async () => {
    const { Broken } = await freshModel(undefined)
    expect(() => new Broken({ source: 'uno\n\n[b]dos[/b]' })).not.toThrow()
  })
})
