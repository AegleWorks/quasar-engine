/**
 * osu! BBCode tree -> portable GFM.
 *
 * The target is Markdown that reads well on GitHub and Discord, not
 * Miliastry's hybrid dialect (`MarkdownExporter` keeps that job). Whatever
 * Markdown has no form for is flattened to its text and reported in `losses`.
 */

import { RedNode } from '../Syntax/RedNode'
import { MAX_NESTING_DEPTH } from '../BBCode/Parser'
import { LossBook, type MarkdownLoss } from '../Markdown/MarkdownLoss'

export interface PortableMarkdownResult {
  markdown: string
  losses: MarkdownLoss[]
}

const ZWSP = /​/g
const MAX_DEPTH = MAX_NESTING_DEPTH - 8

const BLOCK_KINDS = new Set([
  'heading', 'list', 'quote', 'code', 'box', 'boxw', 'spoilerbox', 'notice', 'wnotice',
  'center', 'left', 'right', 'imagemap',
])
const NEWLINE_KINDS = new Set(['spacing', 'empty_line'])

function isNewline(node: RedNode): boolean {
  return NEWLINE_KINDS.has(node.kind)
}

/** All literal text under a node, newlines included. */
function rawText(node: RedNode): string {
  if (isNewline(node)) return '\n'
  if (node.children.length === 0) return node.kind === 'text' ? node.text : ''
  let s = ''
  for (const c of node.children) s += rawText(c)
  return s
}

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim()

function attrOf(node: RedNode): string {
  const t = node.text || ''
  return t.startsWith('=') ? t.slice(1).trim().replace(/^"([\s\S]*)"$/, '$1') : ''
}

class Exporter {
  readonly losses = new LossBook()

  document(root: RedNode): string {
    return this.flow(root.children, 0).trim()
  }

  // ----- flow: blocks separated by blank lines ------------------------------

  private flow(children: readonly RedNode[], depth: number): string {
    const flat: RedNode[] = []
    const expand = (list: readonly RedNode[]): void => {
      for (const c of list) {
        if (c.kind === 'paragraph') expand(c.children)
        else flat.push(c)
      }
    }
    expand(children)

    const blocks: string[] = []
    let run = ''
    let pendingNl = 0
    const flushRun = (): void => {
      const text = this.lineStartEscape(run.trim())
      if (text !== '') blocks.push(text)
      run = ''
      pendingNl = 0
    }
    for (const child of flat) {
      if (isNewline(child)) {
        pendingNl++
        continue
      }
      if (BLOCK_KINDS.has(child.kind) && depth < MAX_DEPTH) {
        flushRun()
        const block = this.block(child, depth + 1)
        if (block.trim() !== '') blocks.push(block)
        continue
      }
      const piece = this.inline(child, depth + 1)
      if (piece === '') continue
      if (run.trim() !== '' && pendingNl > 0) run += pendingNl === 1 ? '  \n' : '\n\n'
      else if (run.trim() === '') run = ''
      pendingNl = 0
      run += piece
    }
    flushRun()
    return blocks.join('\n\n')
  }

  /** Escape line-start syntax of plain text (`# `, `- `, `1. `, `>`) in paragraph runs. */
  private lineStartEscape(text: string): string {
    return text
      .split('\n')
      .map((line) => {
        const m = /^(\s*)([\s\S]*)$/.exec(line)!
        const body = m[2]
        if (/^#{1,6}(\s|$)/.test(body) || body.startsWith('>')) return `${m[1]}\\${body}`
        if (/^[-+](\s|$)/.test(body) || /^={3,}\s*$/.test(body) || /^-{3,}\s*$/.test(body)) return `${m[1]}\\${body}`
        const ord = /^(\d{1,9})([.)])(\s|$)/.exec(body)
        if (ord) return `${m[1]}${ord[1]}\\${body.slice(ord[1].length)}`
        return line
      })
      .join('\n')
  }

  // ----- blocks ---------------------------------------------------------------

  private block(node: RedNode, depth: number): string {
    switch (node.kind) {
      case 'heading': {
        const text = oneLine(this.inlineChildren(node.children, depth))
        return text ? `## ${text}` : ''
      }
      case 'code': {
        const value = rawText(node).replace(/^\n+/, '').replace(/\n+$/, '')
        if (value.trim() === '') return ''
        const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((r) => r.length))
        const fence = '`'.repeat(Math.max(3, longest + 1))
        return `${fence}\n${value}\n${fence}`
      }
      case 'quote': {
        const source = (node.metadata?.source as string | undefined) || attrOf(node)
        const body = this.flow(node.children, depth)
        const lines: string[] = []
        if (source) {
          lines.push(`**${this.escape(source)} wrote:**`)
          if (body) lines.push('')
        }
        if (body) lines.push(...body.split('\n'))
        return lines.map((l) => (l === '' ? '>' : `> ${l}`)).join('\n')
      }
      case 'notice':
      case 'wnotice': {
        const body = this.flow(node.children, depth)
        return body ? body.split('\n').map((l) => (l === '' ? '>' : `> ${l}`)).join('\n') : ''
      }
      case 'box':
      case 'boxw':
      case 'spoilerbox': {
        this.losses.add('collapsible', rawText(node))
        const title = String(node.metadata?.title ?? '').trim()
        const body = this.flow(node.children, depth)
        const head = title ? `**${this.escape(title)}**` : ''
        return [head, body].filter(Boolean).join('\n\n')
      }
      case 'center':
      case 'left':
      case 'right':
        this.losses.add('alignment', rawText(node))
        return this.flow(node.children, depth)
      case 'imagemap':
        return this.imagemap(node)
      case 'list':
        return this.list(node, depth)
    }
    return this.inline(node, depth)
  }

  private imagemap(node: RedNode): string {
    this.losses.add('imagemap', rawText(node))
    const lines = rawText(node).split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) return ''
    const out: string[] = [`![](${this.url(lines[0])})`]
    const links: string[] = []
    for (const line of lines.slice(1)) {
      const m = /^(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(\S+)(?:\s+(.*))?$/.exec(line)
      if (!m) continue
      const href = m[5]
      const title = (m[6] ?? '').trim()
      if (href === '#') continue
      links.push(title ? `- [${this.escape(title)}](${this.url(href)})` : `- ${this.url(href)}`)
    }
    if (links.length > 0) out.push('', ...links)
    return out.join('\n')
  }

  private list(node: RedNode, depth: number): string {
    const ordered = !!node.metadata?.ordered
    const parts: string[] = []
    const title: RedNode[] = []
    let n = 0
    for (const child of node.children) {
      if (child.kind !== 'list_item') {
        if (n === 0) title.push(child)
        continue
      }
      n++
      const prefix = ordered ? `${n}. ` : '- '
      const body = this.item(child, depth)
      const pad = ' '.repeat(prefix.length)
      const lines = body.split('\n')
      parts.push(prefix + lines[0] + lines.slice(1).map((l) => (l === '' ? '' : pad + l)).map((l) => `\n${l}`).join(''))
    }
    const head = this.flow(title, depth)
    const list = parts.join('\n')
    return head ? (list ? `${head}\n\n${list}` : head) : list
  }

  /** An item is a tight run of inline text plus nested blocks, one per line. */
  private item(node: RedNode, depth: number): string {
    const out: string[] = []
    let run: RedNode[] = []
    const flush = (): void => {
      const text = this.flow(run, depth).replace(/\n\n/g, '\n').trim()
      if (text) out.push(text)
      run = []
    }
    for (const c of node.children) {
      if (BLOCK_KINDS.has(c.kind) && depth < MAX_DEPTH) {
        flush()
        const b = this.block(c, depth + 1).trim()
        if (b) out.push(b)
      } else run.push(c)
    }
    flush()
    return out.join('\n')
  }

  // ----- inline ---------------------------------------------------------------

  private inlineChildren(children: readonly RedNode[], depth: number): string {
    let s = ''
    for (const c of children) s += this.inline(c, depth + 1)
    return s
  }

  private inline(node: RedNode, depth: number): string {
    if (isNewline(node)) return '\n'
    if (depth > MAX_DEPTH) return this.escape(rawText(node))
    switch (node.kind) {
      case 'text':
        return this.escape(node.text)
      case 'paragraph':
        return this.inlineChildren(node.children, depth)
      case 'bold':
        return this.mark('**', this.inlineChildren(node.children, depth))
      case 'italic':
        return this.mark('*', this.inlineChildren(node.children, depth))
      case 'strikethrough':
        return this.mark('~~', this.inlineChildren(node.children, depth))
      case 'underline':
        this.losses.add('underline', rawText(node))
        return this.inlineChildren(node.children, depth)
      case 'spoiler':
        this.losses.add('spoiler', rawText(node))
        return this.inlineChildren(node.children, depth)
      case 'color':
        this.losses.add('color', rawText(node))
        return this.inlineChildren(node.children, depth)
      case 'font_size':
        this.losses.add('size', rawText(node))
        return this.inlineChildren(node.children, depth)
      case 'inline_code':
        return this.inlineCode(rawText(node))
      case 'url': {
        const label = this.inlineChildren(node.children, depth)
        const plain = rawText(node).trim()
        const href = ((node.metadata?.href as string | undefined) || attrOf(node) || plain).trim()
        if (!href) return label
        if (label.trim() === '' || plain === href) return this.bareUrl(href)
        return `[${label.trim()}](${this.url(href)})`
      }
      case 'email': {
        const label = this.inlineChildren(node.children, depth).trim()
        const addr = (attrOf(node) || rawText(node)).trim()
        if (!addr) return label
        return `[${label || this.escape(addr)}](mailto:${this.url(addr)})`
      }
      case 'profile': {
        const label = this.inlineChildren(node.children, depth).trim()
        const attr = attrOf(node)
        const who = attr || rawText(node).trim()
        if (!who) return label
        const target = /^\d+$/.test(who) ? who : encodeURIComponent(who)
        return `[${label || this.escape(who)}](https://osu.ppy.sh/users/${target})`
      }
      case 'image': {
        const src = ((node.metadata?.src as string | undefined) || rawText(node)).trim()
        return src ? `![](${this.url(src)})` : ''
      }
      case 'video': {
        const id = ((node.metadata?.videoId as string | undefined) || rawText(node)).trim()
        return id ? this.bareUrl(`https://youtu.be/${id}`) : ''
      }
      case 'audio': {
        const src = ((node.metadata?.src as string | undefined) || rawText(node)).trim()
        return src ? `[audio](${this.url(src)})` : ''
      }
      case 'list_item':
        return this.inlineChildren(node.children, depth)
    }
    if (BLOCK_KINDS.has(node.kind)) return this.block(node, depth)
    if (node.children.length > 0) {
      this.losses.add('unsupported-tag', node.kind)
      return this.inlineChildren(node.children, depth)
    }
    return ''
  }

  // ----- text helpers ---------------------------------------------------------

  /** Delimit per line and keep the spaces outside, or the markers stop flanking. */
  private mark(delim: string, inner: string): string {
    return inner
      .split('\n')
      .map((seg) => {
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(seg)!
        return m[2] === '' ? seg : `${m[1]}${delim}${m[2]}${delim}${m[3]}`
      })
      .join('\n')
  }

  private inlineCode(value: string): string {
    const text = value.replace(/\n/g, ' ')
    if (text.trim() === '') return ''
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length))
    const fence = '`'.repeat(longest + 1)
    const pad = text.startsWith('`') || text.endsWith('`') || (/^ .* $/.test(text) && text.trim() !== '') ? ' ' : ''
    return `${fence}${pad}${text}${pad}${fence}`
  }

  private bareUrl(href: string): string {
    const clean = this.url(href)
    return /[\s<>]/.test(clean) ? `<${clean.replace(/\s/g, '%20')}>` : clean
  }

  private url(href: string): string {
    return href.replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')
  }

  /** Escape Markdown-significant characters in plain text, leaving URLs alone. */
  private escape(text: string): string {
    const clean = text.replace(ZWSP, '')
    let out = ''
    let last = 0
    const urlRe = /https?:\/\/[^\s<>[\]]+/gi
    for (let m = urlRe.exec(clean); m; m = urlRe.exec(clean)) {
      let url = m[0]
      while (/[.,;:!?'")*_~]$/.test(url) && !(url.endsWith(')') && url.includes('('))) url = url.slice(0, -1)
      out += this.escapeText(clean.slice(last, m.index), clean[m.index - 1]) + url
      last = m.index + url.length
      urlRe.lastIndex = last
    }
    return out + this.escapeText(clean.slice(last), clean[last - 1])
  }

  private escapeText(s: string, _prev?: string): string {
    return s
      .replace(/[\\`*[\]~]/g, '\\$&')
      .replace(/<(?=[A-Za-z/!?])/g, '\\<')
      .replace(/&(?=#?\w+;)/g, '&amp;')
      .replace(/_/g, (m, off: number) => {
        const before = s[off - 1]
        const after = s[off + 1]
        return before && after && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after) ? m : '\\_'
      })
  }
}

/**
 * Export an osu! BBCode tree as portable GFM, reporting what had no form.
 * Never throws; on an unexpected tree it falls back to the plain text.
 */
export function exportPortableMarkdown(root: RedNode): PortableMarkdownResult {
  const exporter = new Exporter()
  if (!root) return { markdown: '', losses: [] }
  try {
    const markdown = exporter.document(root).replace(/\n{3,}/g, '\n\n')
    return { markdown, losses: exporter.losses.list() }
  } catch {
    const losses = new LossBook()
    losses.add('conversion-error')
    return { markdown: rawText(root).trim(), losses: losses.list() }
  }
}
