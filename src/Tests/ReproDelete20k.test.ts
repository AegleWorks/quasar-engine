/**
 * Debug — dump the windowed reconcile decisions for the minimal delete-20k
 * divergence: change range, old/new window keys, orphan decisions, walk.
 */

import { describe, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { patchBlocksInto } from '../Visitors/BlockPatcher'

const renderer = new HTMLRenderer()

function loadFixture(): string {
  const candidates = [
    join(process.cwd(), 'packages', 'quasar', '500KCharsTest'),
    join(process.cwd(), '500KCharsTest'),
    join(__dirname, '..', '..', '500KCharsTest'),
  ]
  const p = candidates.find(c => existsSync(c))
  if (!p) throw new Error(`Fixture not found in: ${candidates.join(', ')}`)
  return readFileSync(p, 'utf-8')
}

const insertAt = (s: string, pos: number, text: string): string => s.slice(0, pos) + text + s.slice(pos)
function afterBlank(s: string, pos: number): number {
  const i = s.indexOf('\n\n', pos)
  return i === -1 ? s.length : i + 2
}

describe('windowed debug: minimal delete-20k', () => {
  it('dumps orphan + walk decisions', () => {
    ;(globalThis as { __BP_DEBUG__?: boolean }).__BP_DEBUG__ = true
    let src = loadFixture()
    let model = new BBCodeDocumentModel({ source: src })
    const el = document.createElement('div')
    patchBlocksInto(el, model.redRoot!, { renderer, minWindowedBlocks: 0 })

    // Step 1: insert box at 50%
    src = insertAt(src, afterBlank(src, Math.floor(src.length * 0.5)), '[box]caja nueva[/box]\n\n')
    model.applyTextUpdate(src)
    model.ensureAnalyzed()
    patchBlocksInto(el, model.redRoot!, { renderer, minWindowedBlocks: 0 })

    // Step 2: insert quote at 60%
    src = insertAt(src, afterBlank(src, Math.floor(src.length * 0.6)), '[quote]cita nueva[/quote]\n\n')
    model.applyTextUpdate(src)
    model.ensureAnalyzed()
    patchBlocksInto(el, model.redRoot!, { renderer, minWindowedBlocks: 0 })

    // Step 3: delete 20k at 50% — the diverging edit
    console.log('[dbg] --- STEP 3: delete 20k at 50% ---')
    const pos = Math.floor(src.length * 0.5)
    const next = src.slice(0, pos) + src.slice(pos + 20_000)
    model.applyTextUpdate(next)
    model.ensureAnalyzed()
    console.log('[dbg] change source pos', pos)
    patchBlocksInto(el, model.redRoot!, { renderer, minWindowedBlocks: 0 })
    ;(globalThis as { __BP_DEBUG__?: boolean }).__BP_DEBUG__ = false
  }, 300_000)
})
