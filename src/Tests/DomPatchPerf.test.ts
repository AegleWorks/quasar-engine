import { describe, it } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { patchBlocksInto } from '../Visitors/BlockPatcher'

function makeLines(n: number): string {
  const parts: string[] = []
  for (let i = 0; i < n; i++) parts.push(`line ${i}`)
  return parts.join('\n')
}

describe('dom patch worst case (perf diagnostic)', () => {
  it('repro: 40k lines, insert a-burst in middle and at start', () => {
    const source = makeLines(5000)
    const model = new BBCodeDocumentModel({ source })
    const renderer = new HTMLRenderer()
    let renderCalls = 0
    const origRender = renderer.render.bind(renderer)
    ;(renderer as unknown as { render: (n: unknown) => string }).render = (n: unknown) => {
      renderCalls++
      return origRender(n as never)
    }
    const el = document.createElement('div')

    const t0 = performance.now()
    const s1 = patchBlocksInto(el, model.redRoot!, { renderer })
    const tInit = performance.now() - t0
    console.log('[perf] init: ', JSON.stringify(s1), 'renderCalls:', renderCalls, 't:', tInit.toFixed(1), 'ms', 'rootChildren:', model.redRoot!.children.length)

    // ── Edit A: insert 'a' * 2000 en la MITAD (dentro de una línea) ──
    renderCalls = 0
    const mid = Math.floor(model.source.length / 2)
    const edited = model.source.slice(0, mid) + 'a'.repeat(2000) + model.source.slice(mid)
    const t1 = performance.now()
    model.applyTextUpdate(edited)
    const tParse = performance.now() - t1
    const t2 = performance.now()
    const s2 = patchBlocksInto(el, model.redRoot!, { renderer })
    const tPatch = performance.now() - t2
    console.log('[perf] mid-insert:', JSON.stringify(s2), 'renderCalls:', renderCalls, 'parse:', tParse.toFixed(1), 'ms', 'patch:', tPatch.toFixed(1), 'ms')

    // ── Edit B: insert 'a' * 2000 al INICIO ──
    renderCalls = 0
    const edited2 = 'a'.repeat(2000) + edited
    const t3 = performance.now()
    model.applyTextUpdate(edited2)
    const tParse2 = performance.now() - t3
    const t4 = performance.now()
    const s3 = patchBlocksInto(el, model.redRoot!, { renderer })
    const tPatch2 = performance.now() - t4
    console.log('[perf] start-insert:', JSON.stringify(s3), 'renderCalls:', renderCalls, 'parse:', tParse2.toFixed(1), 'ms', 'patch:', tPatch2.toFixed(1), 'ms')

    // ── Edit C: teclear 1 carácter en el medio ──
    renderCalls = 0
    const edited3 = edited2.slice(0, mid + 1000) + 'x' + edited2.slice(mid + 1000)
    model.applyTextUpdate(edited3)
    const s4 = patchBlocksInto(el, model.redRoot!, { renderer })
    console.log('[perf] single-key:', JSON.stringify(s4), 'renderCalls:', renderCalls)
  }, 120000)
})
