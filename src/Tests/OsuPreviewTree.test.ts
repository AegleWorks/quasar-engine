import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import type { BBCodeDialect } from '../BBCode/BBCodeToGreenNode'
import { OsuPreviewTree } from '../Osu/OsuPreviewTree'
import { patchBlocksInto } from '../Visitors/BlockPatcher'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import type { RedNode } from '../Syntax/RedNode'
import { checkRedTree } from '../Syntax/redTreeInvariants'

/**
 * `OsuPreviewTree` rebuilds the osu! preview tree with a FULL osu parse and
 * then adopts every block of the previous tree whose green is equal. Two
 * properties, checked after every edit of every sequence:
 *
 *   1. Fidelity: the tree equals a fresh `BBCodeDocumentModel` built with
 *      `pairing: 'osu'` from the same text — kind, text, range, metadata and
 *      rich box titles at every node. Only ids may differ.
 *   2. The patcher contract: the container patched incrementally from these
 *      trees equals a full render of the same tree with ids stripped, and no
 *      id appears twice.
 *
 * osu! pairing is document-global — a closer typed at the end can re-pair a
 * block at the top — so the edits are drawn from the tokens that move pairing
 * the most (orphan closers, div-counted block tags, lists, rich titles), not
 * just from text.
 */

const DIALECTS: readonly BBCodeDialect[] = ['osu', 'miliastry']

/**
 * The container's DOM, serialized with attributes sorted and ids dropped.
 * `morphElement` updates attributes in place, so a morphed element can list
 * them in another order than a fresh parse — the same DOM either way.
 */
function canonical(root: Node): string {
  let out = ''
  root.childNodes.forEach((n) => {
    if (n.nodeType === 3) out += JSON.stringify((n as Text).data)
    else if (n.nodeType === 1) {
      const el = n as Element
      const attrs = Array.from(el.attributes)
        .filter((a) => a.name !== 'data-node-id')
        .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
        .sort()
      out += `<${el.tagName} ${attrs.join(' ')}>${canonical(el)}</${el.tagName}>`
    }
  })
  return out
}

function fullOsuRoot(source: string, dialect: BBCodeDialect): RedNode {
  return new BBCodeDocumentModel({
    source, dialect, pairing: 'osu', incremental: false, autoAnalyze: false, maxUndo: 0,
  }).redRoot!
}

/** Everything but the id, rich box titles included. */
function dump(n: RedNode): string {
  const md: Record<string, unknown> = { ...n.metadata }
  const titles = md.titleNodes as RedNode[] | undefined
  delete md.titleNodes
  return `${n.kind}[${n.range.start},${n.range.end}]${JSON.stringify(n.text)}${JSON.stringify(md)}` +
    (titles ? `T(${titles.map(dump).join(',')})` : '') +
    (n.children.length ? `(${n.children.map(dump).join(',')})` : '')
}

function collectIds(n: RedNode, into: string[]): string[] {
  into.push(n.id)
  for (const c of n.children) collectIds(c, into)
  return into
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOKENS = [
  'texto ', 'otra palabra ', 'x', '\n', '\n\n', '\r\n',
  '[b]', '[/b]', '[i]', '[/i]', '[u]', '[/u]', '[color=#ff66ab]', '[/color]',
  '[size=150]', '[/size]', '[url=https://osu.ppy.sh]', '[/url]',
  '[centre]', '[/centre]', '[notice]', '[/notice]', '[quote]', '[quote="peppy"]', '[/quote]',
  '[box=Titulo]', '[box=[b]Rico[/b] titulo]', '[/box]', '[spoilerbox]', '[/spoilerbox]',
  '[list]', '[list=1]', '[*]', '[/list]', '[code]', '[/code]', '[heading]', '[/heading]',
  '[img]https://a.b/c.png[/img]', '[imagemap]\nhttps://a.b/i.png\n0 0 10 10 https://x Tip\n[/imagemap]',
]

function seedDoc(rand: () => number, blocks: number): string {
  const parts: string[] = []
  for (let i = 0; i < blocks; i++) {
    switch (Math.floor(rand() * 6)) {
      case 0: parts.push(`parrafo ${i} con [b]negrita[/b] y [color=red]color[/color]`); break
      case 1: parts.push(`[box=Caja ${i}]dentro de la caja ${i}\n\nsegunda linea[/box]`); break
      case 2: parts.push(`[notice]aviso ${i} con [i]cursiva[/i][/notice]`); break
      case 3: parts.push(`[list]\n[*]uno ${i}\n[*]dos\n[/list]`); break
      case 4: parts.push(`[quote="alguien"]cita ${i}[/quote]`); break
      default: parts.push(`[centre][size=150]titulo ${i}[/size][/centre]`)
    }
  }
  return parts.join('\n\n')
}

function randomEdit(source: string, rand: () => number): string {
  const at = Math.floor(rand() * (source.length + 1))
  const r = rand()
  if (r < 0.55) {
    const token = TOKENS[Math.floor(rand() * TOKENS.length)]
    return source.slice(0, at) + token + source.slice(at)
  }
  if (r < 0.85) {
    const len = 1 + Math.floor(rand() * 12)
    return source.slice(0, at) + source.slice(Math.min(source.length, at + len))
  }
  // Move a span (cut + paste elsewhere): a multi-block structural edit.
  const len = Math.floor(rand() * 80)
  const cut = source.slice(at, at + len)
  const rest = source.slice(0, at) + source.slice(at + len)
  const to = Math.floor(rand() * (rest.length + 1))
  return rest.slice(0, to) + cut + rest.slice(to)
}

describe('OsuPreviewTree — a full osu parse that keeps unchanged blocks', () => {
  describe.each(DIALECTS)('dialect=%s', (dialect) => {
    it('equals a fresh full osu parse after every random edit, and the patched DOM equals a full render', () => {
      const renderer = new HTMLRenderer({ dialect, theme: 'osu' })
      let adoptedTotal = 0
      for (let seed = 1; seed <= 24; seed++) {
        const rand = mulberry32(seed)
        let source = seedDoc(rand, 6 + Math.floor(rand() * 14))
        const tree = new OsuPreviewTree({ dialect })
        const container = document.createElement('div')
        // `minWindowedBlocks: 0` drives these small documents through the
        // windowed reconcile the 547 KB document takes.
        patchBlocksInto(container, tree.update(source), { renderer, minWindowedBlocks: 0 })
        for (let step = 0; step < 30; step++) {
          source = randomEdit(source, rand)
          const root = tree.update(source)
          adoptedTotal += tree.lastStats!.adopted
          const where = `seed ${seed} step ${step}`

          expect(dump(root), where).toBe(dump(fullOsuRoot(source, dialect)))
          const ids = collectIds(root, [])
          expect(new Set(ids).size, `${where}: duplicate ids`).toBe(ids.length)
          expect(checkRedTree(root, { source, limit: 3 }), where).toEqual([])

          patchBlocksInto(container, root, { renderer, minWindowedBlocks: 0 })
          const full = document.createElement('div')
          full.innerHTML = renderer.render(root)
          expect(canonical(container), where).toBe(canonical(full))
        }
      }
      // The point of the exercise: most edits leave most blocks alone.
      expect(adoptedTotal).toBeGreaterThan(0)
    })
  })

  it('keeps unchanged blocks as the same RedNode objects (ids included) and moves the ones after the edit', () => {
    const block = '[b]negrita[/b] parrafo\n\n[box=Caja]dentro[/box]\n\n[notice]aviso[/notice]'
    const source = `primer parrafo\n\n${block}\n\n${block}`
    const tree = new OsuPreviewTree({ dialect: 'osu' })
    const before = tree.update(source)
    const blocks = [...before.children]
    const last = blocks[blocks.length - 1]
    const lastStart = last.range.start

    // Type inside the first paragraph.
    const at = 'primer'.length
    const after = tree.update(source.slice(0, at) + 'XYZ' + source.slice(at))

    expect(after).not.toBe(before)
    expect(after.children.length).toBe(blocks.length)
    expect(after.children[0]).not.toBe(blocks[0])
    for (let i = 1; i < blocks.length; i++) {
      expect(after.children[i], `block ${i}`).toBe(blocks[i])
      expect(after.children[i].parent).toBe(after)
    }
    expect(last.range.start).toBe(lastStart + 3)
    // The span covers the one block that changed, in both coordinate systems.
    const firstEnd = blocks[0].green.width
    expect(tree.lastStats!.change).toEqual({ start: 0, end: firstEnd + 3, endOld: firstEnd })
  })

  it('returns the same root for the same source, so asking twice consumes nothing', () => {
    const tree = new OsuPreviewTree({ dialect: 'osu' })
    const a = tree.update('[b]hola[/b]\n\n[notice]x[/notice]')
    expect(tree.update('[b]hola[/b]\n\n[notice]x[/notice]')).toBe(a)
  })

  it('re-pairs a block far from the edit when osu pairing says so, and still matches a full parse', () => {
    // An orphan `[/box]` typed at the END closes the box opened at the top:
    // the edit is one span, the change in the tree is not.
    const source = '[box=Arriba]uno\n\ndos\n\ntres\n\ncuatro'
    const tree = new OsuPreviewTree({ dialect: 'osu' })
    tree.update(source)
    const edited = source + '[/box]'
    expect(dump(tree.update(edited))).toBe(dump(fullOsuRoot(edited, 'osu')))
    const reverted = tree.update(source)
    expect(dump(reverted)).toBe(dump(fullOsuRoot(source, 'osu')))
  })

  it('drops the tree on dispose', () => {
    const tree = new OsuPreviewTree({ dialect: 'osu' })
    tree.update('hola')
    tree.dispose()
    expect(tree.root).toBeNull()
    expect(tree.source).toBeNull()
  })
})

// ── The 547 KB fixture: the scenario this exists for ─────────────────────────

function loadFixture(): string | null {
  const candidates = [
    join(process.cwd(), 'packages', 'quasar', '500KCharsTest'),
    join(process.cwd(), '500KCharsTest'),
    join(__dirname, '..', '..', '500KCharsTest'),
  ]
  const p = candidates.find(c => existsSync(c))
  return p ? readFileSync(p, 'utf-8') : null
}

describe('OsuPreviewTree @ 547 KB — every rebuild after a local edit is windowed', () => {
  const fixture = loadFixture()
  it.skipIf(!fixture)('typing, a deleted closer and a pasted block: windowed patches, fidelity kept', () => {
    const src = fixture!
    const renderer = new HTMLRenderer({ dialect: 'osu', theme: 'osu' })
    const tree = new OsuPreviewTree({ dialect: 'osu' })
    const container = document.createElement('div')
    patchBlocksInto(container, tree.update(src), { renderer })

    const at = src.indexOf(' ', Math.floor(src.length / 2)) + 1
    const closer = src.indexOf('[/box]', Math.floor(src.length / 3))
    const steps: string[] = []
    let s = src
    for (const ch of 'hola') {
      const i = at + steps.length
      s = s.slice(0, i) + ch + s.slice(i)
      steps.push(s)
    }
    steps.push(s.slice(0, closer) + s.slice(closer + '[/box]'.length))
    steps.push(s.slice(0, at) + '\n\n[box=Pegado]bloque [b]pegado[/b][/box]\n\n' + s.slice(at))

    for (const [i, next] of steps.entries()) {
      const stats = patchBlocksInto(container, tree.update(next), { renderer })
      // Typing is exactly the case the windowed reconcile is for.
      if (i < 4) expect(stats.windowed, `step ${i}`).toBe(true)
    }
    const last = steps[steps.length - 1]
    expect(dump(tree.root!)).toBe(dump(fullOsuRoot(last, 'osu')))
    const full = document.createElement('div')
    full.innerHTML = renderer.render(tree.root!)
    expect(canonical(container)).toBe(canonical(full))
  })
})
