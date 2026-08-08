/**
 * The partition invariant (roadmap point 14).
 *
 * The tree must account for every character of the source exactly once. This
 * was false in three independent ways before the width model, and each one is
 * pinned here by the minimal case that exposed it — because the failure mode
 * is silent: nothing crashes, offsets just quietly stop meaning anything, and
 * everything built on them (`findNodeAtOffset`, the Monaco↔AST mapping,
 * diagnostics, incremental reparse) inherits the ambiguity.
 *
 * Since point 5, green nodes carry widths and no positions, so most of the
 * invariant holds by construction. What these tests check is therefore split
 * in two: the WIDTHS on the green tree, and the POSITIONS the red tree derives
 * from them — which is where a mistake would now actually show up.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseBBCode } from '../BBCode/Parser'
import { greenToRedNode } from '../BBCode/BBCodeToGreenNode'
import { checkPartition } from '../Syntax/partition'
import { GreenNode } from '../Syntax/GreenNode'
import type { RedNode } from '../Syntax/RedNode'

const violations = (source: string, strictMode = false) =>
  checkPartition(parseBBCode(source, { strictMode }), source.length, {
    limit: 50,
    checkLeafWidths: true,
  })

const expectPartitions = (source: string, strictMode = false) => {
  const vs = violations(source, strictMode)
  expect(
    vs.map(v => `${v.kind} at ${v.path}: ${v.detail}`),
    `source: ${JSON.stringify(source)}`,
  ).toEqual([])
}

/** Parse and build the red tree, where absolute positions live. */
const redOf = (source: string): RedNode => greenToRedNode(parseBBCode(source))

/** Every character offset must resolve to exactly one owning node. */
function ownersPerOffset(root: RedNode, length: number): number[] {
  const owners = new Array<number>(length).fill(0)
  const stack: RedNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    // A node OWNS only what its children do not: its delimiters.
    if (node.children.length === 0) {
      for (let i = node.range.start; i < node.range.end; i++) owners[i]++
    } else {
      const first = node.children[0]
      const last = node.children[node.children.length - 1]
      for (let i = node.range.start; i < first.range.start; i++) owners[i]++
      for (let i = last.range.end; i < node.range.end; i++) owners[i]++
      for (const c of node.children) stack.push(c)
    }
  }
  return owners
}

describe('partition invariant', () => {
  describe('the three original defects', () => {
    it('delimiters are accounted for by leading/trailing width', () => {
      const bold = redOf('[b]hola[/b]').children[0].children[0]

      expect(bold.range).toEqual({ start: 0, end: 11 })
      expect(bold.green.leadingWidth).toBe(3)   // '[b]'
      expect(bold.green.trailingWidth).toBe(4)  // '[/b]'
      expect(bold.children[0].range).toEqual({ start: 3, end: 7 })
      expectPartitions('[b]hola[/b]')
    })

    it('siblings never share a range — the spacing/empty_line case', () => {
      // This exact input produced `spacing [4..6]` AND `empty_line [4..6]`.
      const kinds: { kind: string; start: number; end: number }[] = []
      const collect = (n: RedNode): void => {
        if (n.kind === 'spacing' || n.kind === 'empty_line') {
          kinds.push({ kind: n.kind, start: n.range.start, end: n.range.end })
        }
        for (const c of n.children) collect(c)
      }
      collect(redOf('hola\n\nmundo'))

      expect(kinds).toEqual([
        { kind: 'spacing', start: 4, end: 5 },
        { kind: 'empty_line', start: 5, end: 6 },
      ])
      expectPartitions('hola\n\nmundo')
    })

    it('an orphaned closing tag survives as text instead of vanishing', () => {
      const source = 'hola [/b] mundo'
      const texts: string[] = []
      parseBBCode(source).walk(n => { if (n.kind === 'text') texts.push(n.text) })

      expect(texts.join('')).toBe(source)
      expectPartitions(source)
    })
  })

  it('an auto-closed inner tag does not swallow the closing delimiter', () => {
    // `[b][i]x[/b]` used to give italic and bold BOTH ending at 11.
    const bold = redOf('[b][i]x[/b]').children[0].children[0]
    const italic = bold.children[0]

    expect(bold.range).toEqual({ start: 0, end: 11 })
    expect(italic.range).toEqual({ start: 3, end: 7 })
    expect(italic.green.trailingWidth).toBe(0)
    expect(bold.green.trailingWidth).toBe(4)
  })

  it('the root always spans the whole source', () => {
    for (const source of ['', 'hola', '[/b]', '[/b][/i]', '[b]', 'a\n']) {
      const tree = parseBBCode(source)
      expect([source, tree.width]).toEqual([source, source.length])
      expect([source, redOf(source).range]).toEqual([
        source,
        { start: 0, end: source.length },
      ])
    }
  })

  describe('holds on real and hostile input', () => {
    const fixtures = ['../problematic_section.milia', '../problematic_sectionwgradient.milia']
    for (const f of fixtures) {
      it(`fixture ${path.basename(f)}`, () => {
        expectPartitions(fs.readFileSync(path.join(__dirname, f), 'utf-8'))
      })
    }

    const cases = [
      '', 'hola', 'hola\n\nmundo', '\n\n\n\n', 'a\r\n\r\nb',
      '[b]hola[/b]', '[b][i]x[/b]', '[/b]', '[b]sin cerrar', '[b][/b]',
      '[code]raw [b]x[/b][/code]', '[code]sin cerrar', '[c]x[/c]',
      '[list][*]a[*]b[/list]', '[list][*]a', '[*]suelto',
      '[Gateron]', '[90 misses]', '[[[[', ']]]]', '[',
      '[box=[b]t[/b]]c[/box]', '[b]hola[/b]texto[i]y[/i]',
      '[url=https://osu.ppy.sh]x[/url][/url]', '[quote][/b][/quote]',
      '🎵[b]á€ñ[/b]🎵',
    ]
    for (const source of cases) {
      it(`case ${JSON.stringify(source)}`, () => {
        expectPartitions(source)
        expectPartitions(source, true) // strict mode too
      })
    }
  })

  it('every offset has exactly one owner', () => {
    const source = '[centre][b]hola[/b]\n\n[/i]mundo[list][*]a[/list][b]abierto'
    const owners = ownersPerOffset(redOf(source), source.length)

    const unowned = owners.flatMap((c, i) => (c === 0 ? [i] : []))
    const shared = owners.flatMap((c, i) => (c > 1 ? [i] : []))
    expect({ unowned, shared }).toEqual({ unowned: [], shared: [] })
  })

  it('red offsets agree with the source text they claim', () => {
    // The check that only exists once positions are DERIVED: every leaf must
    // still be able to find itself in the source at the offset it reports.
    const source = fs.readFileSync(
      path.join(__dirname, '../problematic_sectionwgradient.milia'),
      'utf-8',
    )
    const mismatches: string[] = []
    const visit = (n: RedNode): void => {
      if (n.kind === 'text' && mismatches.length < 5) {
        const slice = source.slice(n.range.start, n.range.end)
        if (slice !== n.text) {
          mismatches.push(`[${n.range.start}..${n.range.end}] ${JSON.stringify(slice)} != ${JSON.stringify(n.text)}`)
        }
      }
      for (const c of n.children) visit(c)
    }
    visit(greenToRedNode(parseBBCode(source)))

    expect(mismatches).toEqual([])
  })

  describe('seeded fuzz', () => {
    // mulberry32 — same generator the other fuzz suites use, so a failure is
    // reproducible from the seed alone.
    function mulberry32(seed: number): () => number {
      let a = seed >>> 0
      return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    const TAGS = ['b', 'i', 'u', 'color=red', 'size=50', 'url=https://osu.ppy.sh',
      'notice', 'centre', 'box=t', 'spoiler', 'list', 'code', 'quote']
    const WORDS = ['osu!', 'peppy', 'combo', 'hola', 'mundo', '[', ']', '[/', 'á€ñ', '🎵']
    const SPACES = [' ', '  ', '\n', '\n\n', '\n\n\n', '\r\n', '']

    function genDoc(rnd: () => number, depth = 0): string {
      const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
      let out = ''
      const n = 1 + Math.floor(rnd() * 6)
      for (let i = 0; i < n; i++) {
        const c = Math.floor(rnd() * 12)
        if (c < 3) out += pick(WORDS) + pick(SPACES)
        else if (c < 6 && depth < 4) {
          const t = pick(TAGS)
          out += `[${t}]${genDoc(rnd, depth + 1)}[/${t.split('=')[0]}]`
        } else if (c < 7) out += `[/${pick(TAGS).split('=')[0]}]`          // orphan close
        else if (c < 8 && depth < 4) out += `[${pick(TAGS)}]${genDoc(rnd, depth + 1)}` // unclosed
        else if (c < 9) out += `[${pick(['Gateron', '90 misses', '???'])}]` // unknown tag
        else if (c < 10) out += pick(['[*]', '[*] item', '[[[[', ']]]]'])
        else out += pick(SPACES) + pick(WORDS)
      }
      return out
    }

    for (const seed of [1, 7, 42, 1337, 99999, 0x5eed1a57]) {
      it(`seed ${seed}: 1000 documents partition their source`, () => {
        const rnd = mulberry32(seed)
        for (let i = 0; i < 1000; i++) {
          const source = genDoc(rnd)
          const vs = checkPartition(parseBBCode(source), source.length, {
            limit: 3,
            checkLeafWidths: true,
          })
          if (vs.length > 0) {
            throw new Error(
              `seed ${seed} doc #${i}\n  src: ${JSON.stringify(source)}\n` +
                vs.map(v => `  ${v.kind} at ${v.path}: ${v.detail}`).join('\n'),
            )
          }
        }
      })
    }
  })
})
