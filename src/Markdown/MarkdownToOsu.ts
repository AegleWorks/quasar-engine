/**
 * Standard Markdown (CommonMark + GFM) -> osu! BBCode.
 *
 * This is deliberately NOT built on `MarkdownParser`. That parser reads
 * Miliastry's hybrid "MilHibri" dialect, where `->`, `||`, `{#color}`, raw
 * `[b]` BBCode and `~~~` rule lines all mean something. Plain Markdown that
 * happens to contain `a -> b` or a literal `[b]` would be silently
 * reinterpreted, which is the opposite of what a bridge for arbitrary
 * Markdown must do. This module is a small, self-contained CommonMark/GFM
 * reader whose only output is osu!-safe BBCode plus a list of what osu! has
 * no form for.
 *
 * osu! facts the output is built around (measured with the osu dialect
 * renderer, see `Tests/MarkdownOsuBridge.test.ts`):
 * - osu! renders newlines literally, so a Markdown blank line must stay one
 *   blank line, and no more;
 * - the newline right after `[/heading]`, `[/code]` and `[/notice]` is eaten,
 *   after `[/list]` and `[/quote]` the first TWO are, so those blocks need one
 *   newline more than a paragraph to leave one visible blank line;
 * - a URL that touches a closing tag is autolinked together with it, so every
 *   bare URL is wrapped in `[url]`;
 * - there is no escape for literal BBCode, so text that looks like a tag gets
 *   a zero-width space after its `[`.
 */

import { MAX_NESTING_DEPTH } from '../BBCode/Parser'
import { LossBook, type MarkdownLoss } from './MarkdownLoss'

export type { MarkdownLoss }

export interface MarkdownToOsuResult {
  bbcode: string
  losses: MarkdownLoss[]
}

const ZWSP = '​'
/** Markdown block nesting (quotes, list items) handled structurally. */
const MAX_BLOCK_LEVEL = 48
/** Total BBCode nesting we are willing to emit, below the parser's own limit. */
const MAX_EMIT_DEPTH = MAX_NESTING_DEPTH - 8
const EMPHASIS_LOOKBACK = 128

// ---------------------------------------------------------------------------
// Block structure
// ---------------------------------------------------------------------------

type Align = 'left' | 'center' | 'right' | null

interface ListItem {
  checked: boolean | null
  children: Block[]
}

type Block =
  | { t: 'para'; text: string }
  | { t: 'heading'; text: string }
  | { t: 'code'; value: string }
  | { t: 'quote'; children: Block[] }
  | { t: 'alert'; label: string; children: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'table'; align: Align[]; header: string[]; rows: string[][] }
  | { t: 'hr' }

// ---------------------------------------------------------------------------
// Inline structure
// ---------------------------------------------------------------------------

type In =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'br' }
  | { t: 'em' | 'strong' | 'del'; c: In[] }
  | { t: 'link'; href: string; c: In[]; bare?: boolean }
  | { t: 'img'; src: string; alt: string }
  | { t: 'hopen'; name: string; href?: string; raw: string }
  | { t: 'hclose'; name: string; raw: string }

interface Delim {
  t: 'delim'
  ch: string
  n: number
  orig: number
  open: boolean
  close: boolean
}

type Tok = In | Delim

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isBlank = (line: string): boolean => line.trim() === ''

function indentOf(line: string): number {
  let col = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === ' ') col++
    else if (ch === '\t') col += 4 - (col % 4)
    else break
  }
  return col
}

/** Remove up to `n` columns of leading whitespace, splitting a tab if needed. */
function stripCols(line: string, n: number): string {
  let col = 0
  let i = 0
  while (i < line.length && col < n) {
    const ch = line[i]
    if (ch === ' ') {
      col++
      i++
    } else if (ch === '\t') {
      const w = 4 - (col % 4)
      if (col + w > n) return ' '.repeat(col + w - n) + line.slice(i + 1)
      col += w
      i++
    } else break
  }
  return line.slice(i)
}

const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/
const ATX = /^(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const HR = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const LIST_MARKER = /^([-+*]|\d{1,9}[.)])(?=[ \t]|$)/
const SETEXT = /^(=+|-+)[ \t]*$/
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i
const TABLE_DELIM = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/
const REF_DEF = /^\[([^\]]+)\]:[ \t]*(<[^>]*>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/

function isCodeFence(t: string): boolean {
  const m = FENCE_OPEN.exec(t)
  return !!m && !(m[1][0] === '`' && m[2].includes('`'))
}

/** Does this (already left-trimmed) line start a block that interrupts a paragraph? */
function interruptsParagraph(t: string): boolean {
  if (ATX.test(t) || isCodeFence(t) || HR.test(t) || t.startsWith('>')) return true
  const m = LIST_MARKER.exec(t)
  if (!m) return false
  if (t.slice(m[1].length).trim() === '') return false
  return /^\d/.test(m[1]) ? m[1].startsWith('1') && m[1].length === 2 : true
}

const normLabel = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()

function cellWidthOf(ch: number): number {
  if (ch === 0) return 0
  if ((ch >= 0x300 && ch <= 0x36f) || (ch >= 0x200b && ch <= 0x200f) || (ch >= 0xfe00 && ch <= 0xfe0f)) return 0
  if (
    (ch >= 0x1100 && ch <= 0x115f) || (ch >= 0x2e80 && ch <= 0xa4cf) || (ch >= 0xac00 && ch <= 0xd7a3)
    || (ch >= 0xf900 && ch <= 0xfaff) || (ch >= 0xfe30 && ch <= 0xfe6f) || (ch >= 0xff00 && ch <= 0xff60)
    || (ch >= 0xffe0 && ch <= 0xffe6) || (ch >= 0x1f300 && ch <= 0x1f64f) || (ch >= 0x1f900 && ch <= 0x1f9ff)
    || (ch >= 0x20000 && ch <= 0x3fffd)
  ) return 2
  return 1
}

/** Monospace display width: CJK and emoji take two columns. */
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += cellWidthOf(ch.codePointAt(0)!)
  return w
}

const OSU_TAG_NAMES =
  'b|i|u|s|strike|color|size|centre|center|left|right|heading|url|email|img|youtube|audio|list|quote|code|c|spoiler|spoilerbox|box|boxw|notice|wnotice|imagemap|profile|font|sup|sub|\\*'
const LITERAL_TAG = new RegExp(`\\[(?=\\/?(?:${OSU_TAG_NAMES})(?=[\\]=\\s]))`, 'gi')

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  mdash: '—', ndash: '–', hellip: '…', trade: '™', times: '×', rarr: '→', larr: '←',
}

function decodeEntity(name: string | undefined, dec: string | undefined, hex: string | undefined): string | null {
  if (name) return NAMED_ENTITIES[name] ?? null
  const cp = dec ? parseInt(dec, 10) : parseInt(hex!, 16)
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�'
  return String.fromCodePoint(cp)
}

const PUNCT = /[\p{P}\p{S}]/u
const WS = /\s/

function mergeText(nodes: In[]): In[] {
  const out: In[] = []
  for (const node of nodes) {
    const last = out[out.length - 1]
    if (node.t === 'text' && last && last.t === 'text') last.v += node.v
    else out.push(node)
  }
  return out
}

function plainText(nodes: In[]): string {
  let s = ''
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code') s += n.v
    else if (n.t === 'br') s += ' '
    else if (n.t === 'em' || n.t === 'strong' || n.t === 'del' || n.t === 'link') s += plainText(n.c)
    else if (n.t === 'img') s += n.alt
  }
  return s
}

/** Links cannot nest: flatten any link inside link text to its children. */
function unlink(nodes: In[]): In[] {
  const out: In[] = []
  for (const n of nodes) {
    if (n.t === 'link') out.push(...unlink(n.c))
    else if (n.t === 'em' || n.t === 'strong' || n.t === 'del') out.push({ t: n.t, c: unlink(n.c) })
    else out.push(n)
  }
  return mergeText(out)
}

const HTML_FORMAT: Record<string, string> = {
  b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', ins: 'u', s: 's', del: 's', strike: 's', code: 'c', a: 'url',
}

const HTML_TAG =
  /<(\/)?([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/)?>/y
const URI_AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/y
const EMAIL_AUTOLINK = /<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y
const BARE_URL = /https?:\/\/[^\s<]+/iy
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/y
const FOOTNOTE_REF = /\[\^([^\]\s]+)\]/y

function htmlAttr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(attrs)
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined
}

// ---------------------------------------------------------------------------
// Converter
// ---------------------------------------------------------------------------

class Converter {
  readonly losses = new LossBook()
  private readonly refs = new Map<string, string>()

  convert(source: string): string {
    let text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
    text = this.stripFrontMatter(text)
    const blocks = this.parseBlocks(text.split('\n'), 0)
    return this.renderBlocks(blocks, 0, false).trim()
  }

  private stripFrontMatter(text: string): string {
    if (!text.startsWith('---\n')) return text
    const end = text.indexOf('\n---', 4)
    if (end < 0) return text
    const after = text.indexOf('\n', end + 1)
    const closeLine = text.slice(end + 1, after < 0 ? text.length : after).trim()
    if (closeLine !== '---') return text
    const body = text.slice(4, end)
    // Only treat it as YAML front matter when it looks like `key: value` lines.
    if (!/^[A-Za-z_][\w-]*\s*:/m.test(body)) return text
    this.losses.add('front-matter', body.split('\n')[0])
    return after < 0 ? '' : text.slice(after + 1)
  }

  // ----- block parsing -----------------------------------------------------

  private parseBlocks(lines: string[], level: number): Block[] {
    const out: Block[] = []
    const n = lines.length
    let i = 0
    while (i < n) {
      const line = lines[i]
      if (isBlank(line)) {
        i++
        continue
      }
      if (level >= MAX_BLOCK_LEVEL) {
        out.push({ t: 'para', text: lines.slice(i).join('\n') })
        break
      }
      const ind = indentOf(line)

      // Indented code.
      if (ind >= 4) {
        let j = i
        while (j < n && (isBlank(lines[j]) || indentOf(lines[j]) >= 4)) j++
        let end = j
        while (end > i && isBlank(lines[end - 1])) end--
        out.push({ t: 'code', value: lines.slice(i, end).map((l) => stripCols(l, 4)).join('\n') })
        i = j
        continue
      }

      const t = line.trimStart()

      // Fenced code.
      const fence = FENCE_OPEN.exec(t)
      if (fence && isCodeFence(t)) {
        const marker = fence[1]
        const body: string[] = []
        let j = i + 1
        while (j < n) {
          const ct = lines[j].trimStart()
          const close = FENCE_CLOSE.exec(ct)
          if (close && indentOf(lines[j]) < 4 && close[1][0] === marker[0] && close[1].length >= marker.length) break
          body.push(stripCols(lines[j], ind))
          j++
        }
        out.push({ t: 'code', value: body.join('\n') })
        i = j + 1
        continue
      }

      // ATX heading.
      const atx = ATX.exec(t)
      if (atx) {
        out.push({ t: 'heading', text: (atx[2] ?? '').trim() })
        i++
        continue
      }

      // Thematic break.
      if (HR.test(t)) {
        out.push({ t: 'hr' })
        i++
        continue
      }

      // Block quote / GFM alert.
      if (t.startsWith('>')) {
        const taken = this.takeQuote(lines, i)
        i = taken.next
        const alert = ALERT.exec(taken.inner[0]?.trim() ?? '')
        if (alert) {
          out.push({ t: 'alert', label: alert[1].toUpperCase(), children: this.parseBlocks(taken.inner.slice(1), level + 1) })
        } else {
          out.push({ t: 'quote', children: this.parseBlocks(taken.inner, level + 1) })
        }
        continue
      }

      // HTML comment block.
      if (t.startsWith('<!--')) {
        let j = i
        while (j < n && !lines[j].includes('-->')) j++
        this.losses.add('html-comment', lines[i].trim())
        i = j + 1
        continue
      }

      // List.
      if (LIST_MARKER.test(t) && !HR.test(t)) {
        const parsed = this.parseList(lines, i, level)
        out.push(parsed.block)
        i = parsed.next
        continue
      }

      // Footnote definition.
      const foot = FOOTNOTE_DEF.exec(t)
      if (foot) {
        let j = i + 1
        while (j < n && !isBlank(lines[j]) && !interruptsParagraph(lines[j].trimStart())) j++
        this.losses.add('footnote', `[^${foot[1]}]: ${foot[2]}`)
        i = j
        continue
      }

      // Link reference definition.
      const ref = REF_DEF.exec(t)
      if (ref && !ref[1].startsWith('^')) {
        const href = ref[2].startsWith('<') ? ref[2].slice(1, -1) : ref[2]
        if (!this.refs.has(normLabel(ref[1]))) this.refs.set(normLabel(ref[1]), href)
        i++
        continue
      }

      // GFM table.
      if (i + 1 < n && t.includes('|') && lines[i + 1].includes('|') && TABLE_DELIM.test(lines[i + 1].trim())) {
        const header = this.splitRow(t)
        const delim = this.splitRow(lines[i + 1].trim())
        if (header.length === delim.length) {
          const align: Align[] = delim.map((c) => {
            const s = c.trim()
            if (s.startsWith(':') && s.endsWith(':')) return 'center'
            if (s.endsWith(':')) return 'right'
            if (s.startsWith(':')) return 'left'
            return null
          })
          const rows: string[][] = []
          let j = i + 2
          while (j < n && !isBlank(lines[j])) {
            const rt = lines[j].trimStart()
            if (isCodeFence(rt) || ATX.test(rt) || rt.startsWith('>')) break
            const cells = this.splitRow(rt)
            while (cells.length < header.length) cells.push('')
            rows.push(cells.slice(0, header.length))
            j++
          }
          out.push({ t: 'table', align, header, rows })
          i = j
          continue
        }
      }

      // Paragraph (and setext headings).
      const para: string[] = [t]
      let j = i + 1
      let setext: number | null = null
      while (j < n) {
        const l = lines[j]
        if (isBlank(l)) break
        const lt = l.trimStart()
        if (indentOf(l) < 4) {
          const se = SETEXT.exec(lt)
          if (se) {
            setext = se[1][0] === '=' ? 1 : 2
            j++
            break
          }
          if (interruptsParagraph(lt)) break
        }
        para.push(lt)
        j++
      }
      const text = para.join('\n').replace(/[ \t]+$/, '')
      out.push(setext ? { t: 'heading', text: para.map((p) => p.trim()).join(' ') } : { t: 'para', text })
      i = j
    }
    return out
  }

  private takeQuote(lines: string[], start: number): { inner: string[]; next: number } {
    const inner: string[] = []
    let fenceOpen = false
    let j = start
    while (j < lines.length) {
      const l = lines[j]
      const lt = l.trimStart()
      if (indentOf(l) < 4 && lt.startsWith('>')) {
        const body = lt.slice(1).replace(/^ ?/, '')
        if (isCodeFence(body.trimStart())) fenceOpen = !fenceOpen
        inner.push(body)
        j++
        continue
      }
      const prev = inner[inner.length - 1]
      if (!isBlank(l) && prev !== undefined && !isBlank(prev) && !fenceOpen && !interruptsParagraph(lt)) {
        inner.push(lt)
        j++
        continue
      }
      break
    }
    return { inner, next: j }
  }

  private parseList(lines: string[], start: number, level: number): { block: Block; next: number } {
    const n = lines.length
    const first = LIST_MARKER.exec(lines[start].trimStart())!
    const ordered = /^\d/.test(first[1])
    const delim = ordered ? first[1].slice(-1) : first[1]
    const startNo = ordered ? parseInt(first[1], 10) : 1
    const items: ListItem[] = []
    let j = start
    while (j < n) {
      const l = lines[j]
      const lt = l.trimStart()
      const lind = indentOf(l)
      const mm = lind < 4 ? LIST_MARKER.exec(lt) : null
      if (!mm || HR.test(lt)) break
      if (ordered !== /^\d/.test(mm[1]) || delim !== (ordered ? mm[1].slice(-1) : mm[1])) break

      const rest = lt.slice(mm[1].length)
      let width: number
      let firstLine: string
      if (rest.trim() === '') {
        width = lind + mm[1].length + 1
        firstLine = ''
      } else {
        const lead = /^[ \t]*/.exec(rest)![0]
        let sp = 0
        for (const ch of lead) sp += ch === '\t' ? 4 - ((lind + mm[1].length + sp) % 4) : 1
        if (sp >= 5) {
          width = lind + mm[1].length + 1
          firstLine = ' '.repeat(sp - 1) + rest.slice(lead.length)
        } else {
          width = lind + mm[1].length + sp
          firstLine = rest.slice(lead.length)
        }
      }

      const itemLines: string[] = [firstLine]
      const pending: string[] = []
      j++
      while (j < n) {
        const l2 = lines[j]
        if (isBlank(l2)) {
          pending.push('')
          j++
          continue
        }
        if (indentOf(l2) >= width) {
          itemLines.push(...pending, stripCols(l2, width))
          pending.length = 0
          j++
          continue
        }
        const prev = itemLines[itemLines.length - 1]
        if (pending.length === 0 && !isBlank(prev) && !interruptsParagraph(l2.trimStart()) && !LIST_MARKER.test(l2.trimStart())) {
          itemLines.push(l2.trimStart())
          j++
          continue
        }
        break
      }

      const children = this.parseBlocks(itemLines, level + 1)
      let checked: boolean | null = null
      const head = children[0]
      if (head && head.t === 'para') {
        const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(head.text)
        if (task) {
          checked = task[1] !== ' '
          head.text = head.text.slice(task[0].length)
          if (head.text === '') children.shift()
        }
      }
      items.push({ checked, children })
    }
    return { block: { t: 'list', ordered, start: startNo, items }, next: j }
  }

  private splitRow(row: string): string[] {
    let s = row.trim()
    if (s.startsWith('|')) s = s.slice(1)
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
    const cells: string[] = []
    let cur = ''
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') {
        cur += '|'
        i++
      } else if (s[i] === '|') {
        cells.push(cur.trim())
        cur = ''
      } else cur += s[i]
    }
    cells.push(cur.trim())
    return cells
  }

  // ----- block rendering ---------------------------------------------------

  /**
   * Newlines osu! swallows right after a block's closing tag. A paragraph
   * break needs `max(2, swallowed + 1)` newlines to leave exactly one visible
   * blank line.
   */
  private static readonly SWALLOW: Record<string, number> = { heading: 1, code: 1, notice: 1, list: 2, quote: 2 }

  private renderBlocks(blocks: Block[], depth: number, compact: boolean): string {
    const pieces: Array<{ kind: string; text: string }> = []
    for (const block of blocks) {
      const piece = this.renderBlock(block, depth)
      if (piece && piece.text !== '') pieces.push(piece)
    }
    let out = ''
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0) {
        const swallow = Converter.SWALLOW[pieces[i - 1].kind] ?? 0
        out += '\n'.repeat(compact ? 1 : Math.max(2, swallow + 1))
      }
      out += pieces[i].text
    }
    return out
  }

  private renderBlock(block: Block, depth: number): { kind: string; text: string } | null {
    if (depth >= MAX_EMIT_DEPTH) {
      const text = this.blockPlainText(block)
      return text ? { kind: 'para', text: escapeBB(text, this.losses) } : null
    }
    switch (block.t) {
      case 'para': {
        const text = this.renderInline(this.inline(block.text), depth).trim()
        return text ? { kind: 'para', text } : null
      }
      case 'heading': {
        const text = this.renderInline(this.inline(block.text), depth + 1).replace(/\s*\n\s*/g, ' ').trim()
        return text ? { kind: 'heading', text: `[heading]${text}[/heading]` } : null
      }
      case 'code': {
        const value = block.value.replace(/^\n+/, '').replace(/\n+$/, '')
        return value.trim() === '' ? null : { kind: 'code', text: `[code]${escapeCode(value)}[/code]` }
      }
      case 'quote': {
        const inner = this.renderBlocks(block.children, depth + 1, false)
        return inner ? { kind: 'quote', text: `[quote]${inner}[/quote]` } : null
      }
      case 'alert': {
        const label = block.label.charAt(0) + block.label.slice(1).toLowerCase()
        const inner = this.renderBlocks(block.children, depth + 1, false)
        const body = inner ? `[b]${label}[/b]\n${inner}` : `[b]${label}[/b]`
        return { kind: 'notice', text: `[notice]${body}[/notice]` }
      }
      case 'list': {
        if (block.ordered && block.start !== 1) this.losses.add('list-start', `${block.start}.`)
        const lines: string[] = []
        for (const item of block.items) {
          let body = this.renderBlocks(item.children, depth + 2, true)
          if (item.checked !== null) body = `${item.checked ? '☑' : '☐'} ${body}`
          lines.push(`[*]${body}`)
        }
        if (lines.length === 0) return null
        return { kind: 'list', text: `[list${block.ordered ? '=1' : ''}]\n${lines.join('\n')}\n[/list]` }
      }
      case 'table': {
        this.losses.add('table', block.header.join(' | '))
        return { kind: 'code', text: `[code]${escapeCode(this.renderTable(block))}[/code]` }
      }
      case 'hr':
        this.losses.add('thematic-break')
        return null
    }
  }

  private blockPlainText(block: Block): string {
    switch (block.t) {
      case 'para':
      case 'heading':
        return block.text
      case 'code':
        return block.value
      case 'quote':
      case 'alert':
        return block.children.map((c) => this.blockPlainText(c)).join('\n')
      case 'list':
        return block.items.map((it) => it.children.map((c) => this.blockPlainText(c)).join('\n')).join('\n')
      default:
        return ''
    }
  }

  private renderTable(table: Extract<Block, { t: 'table' }>): string {
    const cell = (src: string): string => plainText(this.inline(src)).replace(/\s+/g, ' ').trim()
    const header = table.header.map(cell)
    const rows = table.rows.map((r) => r.map(cell))
    const widths = header.map((h, c) => Math.max(3, displayWidth(h), ...rows.map((r) => displayWidth(r[c] ?? ''))))
    const pad = (text: string, c: number): string => {
      const gap = widths[c] - displayWidth(text)
      const align = table.align[c]
      if (align === 'right') return ' '.repeat(gap) + text
      if (align === 'center') {
        const left = Math.floor(gap / 2)
        return ' '.repeat(left) + text + ' '.repeat(gap - left)
      }
      return text + ' '.repeat(gap)
    }
    const line = (cells: string[]): string => `| ${cells.map((t, c) => pad(t, c)).join(' | ')} |`
    const rule = widths.map((w, c) => {
      const a = table.align[c]
      if (a === 'center') return `:${'-'.repeat(w - 2)}:`
      if (a === 'right') return `${'-'.repeat(w - 1)}:`
      if (a === 'left') return `:${'-'.repeat(w - 1)}`
      return '-'.repeat(w)
    })
    return [line(header), `| ${rule.join(' | ')} |`, ...rows.map(line)].join('\n')
  }

  // ----- inline parsing ----------------------------------------------------

  private inline(src: string): In[] {
    const toks: Tok[] = []
    const brackets: Array<{ idx: number; image: boolean; active: boolean; pos: number }> = []
    const n = src.length
    let buf = ''
    let i = 0

    // Backtick runs, indexed by length, consumed monotonically.
    let runs: Map<number, number[]> | null = null
    const cursor = new Map<number, number>()
    const buildRuns = (): Map<number, number[]> => {
      const map = new Map<number, number[]>()
      for (let p = 0; p < n; ) {
        if (src[p] !== '`') {
          p++
          continue
        }
        let q = p
        while (q < n && src[q] === '`') q++
        const list = map.get(q - p) ?? []
        list.push(p)
        map.set(q - p, list)
        p = q
      }
      return map
    }

    const flush = (): void => {
      if (buf) {
        toks.push({ t: 'text', v: buf })
        buf = ''
      }
    }
    const skipLeadingSpace = (): void => {
      while (i < n && (src[i] === ' ' || src[i] === '\t')) i++
    }

    while (i < n) {
      const ch = src[i]

      if (ch === '\\') {
        const next = src[i + 1]
        if (next === '\n') {
          flush()
          toks.push({ t: 'br' })
          i += 2
          skipLeadingSpace()
        } else if (next !== undefined && /[!-/:-@[-`{-~]/.test(next)) {
          buf += next
          i += 2
        } else {
          buf += '\\'
          i++
        }
        continue
      }

      if (ch === '\n') {
        // Every line break is kept, as GitHub comments and Discord render it:
        // that is where pasted Markdown comes from, and osu! shows newlines
        // literally. CommonMark would join soft-wrapped lines with a space.
        buf = buf.replace(/[ \t]+$/, '')
        flush()
        toks.push({ t: 'br' })
        i++
        skipLeadingSpace()
        continue
      }

      if (ch === '`') {
        let q = i
        while (q < n && src[q] === '`') q++
        const len = q - i
        runs ??= buildRuns()
        const list = runs.get(len) ?? []
        let c = cursor.get(len) ?? 0
        while (c < list.length && list[c] < q) c++
        cursor.set(len, c)
        if (c < list.length) {
          const close = list[c]
          let content = src.slice(q, close).replace(/\n/g, ' ')
          if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
            content = content.slice(1, -1)
          }
          flush()
          toks.push({ t: 'code', v: content })
          i = close + len
          cursor.set(len, c + 1)
        } else {
          buf += src.slice(i, q)
          i = q
        }
        continue
      }

      if (ch === '*' || ch === '_' || ch === '~') {
        let q = i
        while (q < n && src[q] === ch) q++
        const len = q - i
        if (ch === '~' && len > 2) {
          buf += src.slice(i, q)
          i = q
          continue
        }
        const before = i > 0 ? src[i - 1] : ' '
        const after = q < n ? src[q] : ' '
        const wsBefore = WS.test(before)
        const wsAfter = WS.test(after)
        const pBefore = PUNCT.test(before)
        const pAfter = PUNCT.test(after)
        const left = !wsAfter && (!pAfter || wsBefore || pBefore)
        const right = !wsBefore && (!pBefore || wsAfter || pAfter)
        const open = ch === '_' ? left && (!right || pBefore) : left
        const close = ch === '_' ? right && (!left || pAfter) : right
        flush()
        toks.push({ t: 'delim', ch, n: len, orig: len, open, close })
        i = q
        continue
      }

      if (ch === '!' && src[i + 1] === '[') {
        flush()
        brackets.push({ idx: toks.length, image: true, active: true, pos: i + 2 })
        toks.push({ t: 'text', v: '![' })
        i += 2
        continue
      }

      if (ch === '[') {
        FOOTNOTE_REF.lastIndex = i
        const fm = FOOTNOTE_REF.exec(src)
        if (fm) {
          flush()
          this.losses.add('footnote', fm[0])
          i += fm[0].length
          continue
        }
        flush()
        brackets.push({ idx: toks.length, image: false, active: true, pos: i + 1 })
        toks.push({ t: 'text', v: '[' })
        i++
        continue
      }

      if (ch === ']') {
        flush()
        const opener = brackets.pop()
        if (!opener || !opener.active) {
          buf += ']'
          i++
          continue
        }
        let href: string | null = null
        let end = i + 1
        if (src[i + 1] === '(') {
          const dest = parseDestination(src, i + 2)
          if (dest) {
            href = dest.href
            end = dest.end
          }
        } else {
          let label = src.slice(opener.pos, i)
          let consumed = i + 1
          if (src[i + 1] === '[') {
            const close = src.indexOf(']', i + 2)
            if (close >= 0) {
              const explicit = src.slice(i + 2, close)
              if (explicit !== '') label = explicit
              consumed = close + 1
            }
          }
          const found = this.refs.get(normLabel(label))
          if (found !== undefined) {
            href = found
            end = consumed
          }
        }
        if (href === null) {
          buf += ']'
          i++
          continue
        }
        const inner = toks.splice(opener.idx + 1)
        toks.pop()
        const children = this.emphasis(inner)
        if (opener.image) {
          toks.push({ t: 'img', src: href, alt: plainText(children) })
        } else {
          toks.push({ t: 'link', href, c: unlink(children) })
          for (const b of brackets) if (!b.image) b.active = false
        }
        i = end
        continue
      }

      if (ch === '<') {
        if (src.startsWith('<!--', i)) {
          const end = src.indexOf('-->', i + 4)
          if (end >= 0) {
            flush()
            this.losses.add('html-comment', src.slice(i, end + 3))
            i = end + 3
            continue
          }
        }
        URI_AUTOLINK.lastIndex = i
        const uri = URI_AUTOLINK.exec(src)
        if (uri) {
          flush()
          toks.push({ t: 'link', href: uri[1], c: [{ t: 'text', v: uri[1] }], bare: true })
          i += uri[0].length
          continue
        }
        EMAIL_AUTOLINK.lastIndex = i
        const mail = EMAIL_AUTOLINK.exec(src)
        if (mail) {
          flush()
          toks.push({ t: 'link', href: `mailto:${mail[1]}`, c: [{ t: 'text', v: mail[1] }], bare: true })
          i += mail[0].length
          continue
        }
        HTML_TAG.lastIndex = i
        const tag = HTML_TAG.exec(src)
        if (tag) {
          flush()
          this.htmlTag(toks, tag[0], !!tag[1], tag[2].toLowerCase(), tag[3] ?? '', !!tag[4])
          i += tag[0].length
          continue
        }
        buf += '<'
        i++
        continue
      }

      if (ch === '&') {
        ENTITY.lastIndex = i
        const em = ENTITY.exec(src)
        if (em) {
          const decoded = decodeEntity(em[3], em[1], em[2])
          if (decoded !== null) {
            buf += decoded
            i += em[0].length
            continue
          }
        }
        buf += '&'
        i++
        continue
      }

      if ((ch === 'h' || ch === 'H') && (i === 0 || !/[\w/]/.test(src[i - 1]))) {
        BARE_URL.lastIndex = i
        const um = BARE_URL.exec(src)
        if (um) {
          let url = um[0]
          for (;;) {
            const last = url[url.length - 1]
            if (/[?!.,:*_~'"]/.test(last)) url = url.slice(0, -1)
            else if (last === ')' && count(url, ')') > count(url, '(')) url = url.slice(0, -1)
            else if (last === ']' && count(url, ']') > count(url, '[')) url = url.slice(0, -1)
            else break
          }
          if (url.length > 8) {
            flush()
            toks.push({ t: 'link', href: url, c: [{ t: 'text', v: url }], bare: true })
            i += url.length
            continue
          }
        }
      }

      buf += ch
      i++
    }
    flush()
    return this.emphasis(toks)
  }

  private htmlTag(toks: Tok[], raw: string, closing: boolean, name: string, attrs: string, selfClosing: boolean): void {
    if (name === 'br') {
      toks.push({ t: 'br' })
      return
    }
    if (name === 'img' && !closing) {
      const src = htmlAttr(attrs, 'src')
      if (src) {
        toks.push({ t: 'img', src, alt: htmlAttr(attrs, 'alt') ?? '' })
        return
      }
    }
    const bb = HTML_FORMAT[name]
    if (bb && !selfClosing) {
      if (closing) toks.push({ t: 'hclose', name: bb, raw })
      else toks.push({ t: 'hopen', name: bb, href: name === 'a' ? htmlAttr(attrs, 'href') : undefined, raw })
      return
    }
    this.losses.add('html', raw)
  }

  /** CommonMark emphasis resolution, linear except for a bounded opener lookback. */
  private emphasis(toks: Tok[]): In[] {
    const out: Tok[] = []
    const openers: number[] = []
    const asText = (t: Tok): In => (t.t === 'delim' ? { t: 'text', v: t.ch.repeat(t.n) } : t)
    for (const tok of toks) {
      if (tok.t !== 'delim') {
        out.push(tok)
        continue
      }
      const c = tok
      while (c.n > 0 && c.close) {
        let found = -1
        for (let k = openers.length - 1, steps = 0; k >= 0 && steps < EMPHASIS_LOOKBACK; k--, steps++) {
          const o = out[openers[k]] as Delim
          if (o.ch !== c.ch || o.n === 0) continue
          if (c.ch === '~') {
            if (o.n !== c.n) continue
          } else if ((o.close || c.open) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) {
            continue
          }
          found = k
          break
        }
        if (found < 0) break
        const oi = openers[found]
        const o = out[oi] as Delim
        const use = c.ch === '~' ? c.n : o.n >= 2 && c.n >= 2 ? 2 : 1
        const inner = mergeText(out.splice(oi + 1).map(asText))
        openers.length = found + 1
        o.n -= use
        c.n -= use
        const kind = c.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em'
        if (o.n === 0) {
          out.pop()
          openers.pop()
        }
        out.push({ t: kind, c: inner })
      }
      if (c.n > 0) {
        out.push(c)
        if (c.open) openers.push(out.length - 1)
      }
    }
    return mergeText(out.map(asText))
  }

  // ----- inline rendering --------------------------------------------------

  private renderInline(nodes: In[], depth: number): string {
    // Pair raw HTML formatting tags (`<u>..</u>`); unmatched ones are dropped.
    const match = new Map<number, number>()
    const stack: number[] = []
    nodes.forEach((node, idx) => {
      if (node.t === 'hopen') stack.push(idx)
      else if (node.t === 'hclose') {
        for (let k = stack.length - 1; k >= 0; k--) {
          const open = nodes[stack[k]]
          if (open.t === 'hopen' && open.name === node.name) {
            match.set(stack[k], idx)
            stack.length = k
            break
          }
        }
      }
    })

    const room = depth < MAX_EMIT_DEPTH
    let out = ''
    for (let idx = 0; idx < nodes.length; idx++) {
      const node = nodes[idx]
      switch (node.t) {
        case 'text':
          out += escapeBB(node.v, this.losses)
          break
        case 'code': {
          const v = node.v.replace(/\n/g, ' ')
          if (v.trim() !== '') out += room ? `[c]${v.replace(/\[\/c\]/gi, `[${ZWSP}/c]`)}[/c]` : escapeBB(v, this.losses)
          break
        }
        case 'br':
          out += '\n'
          break
        case 'em':
          out += this.wrap('i', this.renderInline(node.c, depth + 1), room)
          break
        case 'strong':
          out += this.wrap('b', this.renderInline(node.c, depth + 1), room)
          break
        case 'del':
          out += this.wrap('s', this.renderInline(node.c, depth + 1), room)
          break
        case 'link': {
          const label = this.renderInline(node.c, depth + 1)
          out += this.renderLink(node.href, label, node.bare ? node.href : plainText(node.c), room)
          break
        }
        case 'img':
          out += this.renderImage(node)
          break
        case 'hopen': {
          const close = match.get(idx)
          if (close === undefined) {
            this.losses.add('html', node.raw)
            break
          }
          const inner = this.renderInline(nodes.slice(idx + 1, close), depth + 1)
          if (node.name === 'url') {
            out += node.href ? this.renderLink(node.href, inner, plainText(nodes.slice(idx + 1, close) as In[]), room) : inner
          } else if (node.name === 'c') {
            const v = inner.replace(/\n/g, ' ')
            out += room && v.trim() !== '' ? `[c]${v}[/c]` : v
          } else out += this.wrap(node.name, inner, room)
          idx = close
          break
        }
        case 'hclose':
          this.losses.add('html', node.raw)
          break
      }
    }
    return out
  }

  /** `[tag]..[/tag]` per line, so a hard break never sits inside a one-line pair. */
  private wrap(tag: string, inner: string, room: boolean, attr = ''): string {
    if (!room || inner.trim() === '') return inner
    return inner
      .split('\n')
      .map((seg) => (seg.trim() === '' ? seg : `[${tag}${attr}]${seg}[/${tag}]`))
      .join('\n')
  }

  private renderLink(rawHref: string, label: string, labelText: string, room: boolean): string {
    const href = rawHref.trim()
    if (/^(?:javascript|data|vbscript):/i.test(href)) {
      this.losses.add('unsafe-link', href)
      return label
    }
    const mail = /^mailto:(.+)$/i.exec(href)
    if (mail) {
      const addr = mail[1].split('?')[0]
      if (label.trim() === '' || labelText.trim() === addr) return `[email]${addr}[/email]`
      return this.wrap('email', label, room, `=${addr}`)
    }
    let url = href
    if (/^www\./i.test(url)) url = `https://${url}`
    else if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) && !/^\/\//.test(url)) {
      this.losses.add('relative-link', href)
      return label
    }
    if (url.startsWith('//')) url = `https:${url}`
    url = encodeUrl(url)
    if (label.trim() === '' || labelText.trim() === rawHref.trim() || label.trim() === escapeBB(url, null)) {
      return `[url]${url}[/url]`
    }
    return this.wrap('url', label, room, `=${url}`)
  }

  private renderImage(node: { src: string; alt: string }): string {
    let src = node.src.trim()
    if (src.startsWith('//')) src = `https:${src}`
    if (!/^https?:\/\//i.test(src)) {
      this.losses.add('relative-image', src)
      return node.alt ? escapeBB(node.alt, this.losses) : ''
    }
    return `[img]${encodeUrl(src)}[/img]`
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

function count(s: string, ch: string): number {
  let c = 0
  for (const x of s) if (x === ch) c++
  return c
}

function encodeUrl(url: string): string {
  return url.replace(/ /g, '%20').replace(/\[/g, '%5B').replace(/\]/g, '%5D')
}

function escapeBB(text: string, losses: LossBook | null): string {
  return text.replace(LITERAL_TAG, (m) => {
    losses?.add('bbcode-literal', m)
    return `[${ZWSP}`
  })
}

function escapeCode(value: string): string {
  return value.replace(/\[\/code\]/gi, `[${ZWSP}/code]`)
}

function parseDestination(src: string, start: number): { href: string; end: number } | null {
  const n = src.length
  let p = start
  const skipWs = (): void => {
    while (p < n && /\s/.test(src[p])) p++
  }
  skipWs()
  let href = ''
  if (src[p] === '<') {
    const close = src.indexOf('>', p + 1)
    if (close < 0) return null
    href = src.slice(p + 1, close)
    if (href.includes('\n')) return null
    p = close + 1
  } else {
    let depth = 0
    const from = p
    while (p < n) {
      const c = src[p]
      if (c === '\\' && p + 1 < n) {
        p += 2
        continue
      }
      if (/\s/.test(c) || c < ' ') break
      if (c === '(') depth++
      else if (c === ')') {
        if (depth === 0) break
        depth--
      }
      p++
    }
    if (depth !== 0) return null
    href = src.slice(from, p)
  }
  skipWs()
  const q = src[p]
  if (q === '"' || q === "'" || q === '(') {
    const closer = q === '(' ? ')' : q
    let k = p + 1
    while (k < n && src[k] !== closer) k += src[k] === '\\' ? 2 : 1
    if (k >= n) return null
    p = k + 1
    skipWs()
  }
  if (src[p] !== ')') return null
  return { href: href.replace(/\\([!-/:-@[-`{-~])/g, '$1'), end: p + 1 }
}

/**
 * Convert standard Markdown (CommonMark + GFM) into osu! BBCode.
 *
 * Never throws. Anything osu! has no form for is reported in `losses`
 * instead of disappearing.
 */
export function convertMarkdownToOsu(source: string): MarkdownToOsuResult {
  const converter = new Converter()
  try {
    const bbcode = converter.convert(String(source ?? ''))
    return { bbcode, losses: converter.losses.list() }
  } catch {
    const fallback = new LossBook()
    fallback.add('conversion-error')
    return { bbcode: escapeBB(String(source ?? ''), null).trim(), losses: fallback.list() }
  }
}
