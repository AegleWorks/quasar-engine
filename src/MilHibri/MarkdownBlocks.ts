/**
 * MilHibri — Markdown blocks inside a BBCode document.
 *
 * The inline layer (`MilHibriInline`) already lets a BBCode page use `**bold**`
 * and Markdown links without losing its block structure. This module adds the
 * other half: a heading, fence, `:::` container, quote, callout or arrow line
 * written inside `[box]`, `[notice]` or another BBCode block becomes the
 * equivalent BBCode block BEFORE the BBCode parser runs. Lists join once the
 * document already declares one of those unambiguous Markdown blocks.
 *
 * Why a rewrite and not a second block parser: osu!'s pairing rules are the
 * expensive, measured part (lazy closers, crossed tags, box-title openers,
 * div-count closing). Reimplementing them for a second grammar is exactly the
 * mistake that made one `**b**` destroy a 41 KB userpage. The BBCode engine
 * stays the only block owner; these tags are its own vocabulary, so a heading
 * inside a nested notice is just another `[heading]` for the same stack.
 *
 * The rewrite is an import: the tree describes the rewritten source, not the
 * original bytes. `MilHibriDocumentModel` marks `treeMirrorsSource` false when
 * this changes anything, just as it does for inline translation.
 */

export interface MarkdownBlocksResult {
  source: string
  changed: boolean
}

/** Tags whose body is a value, not prose; Markdown blocks must not run there. */
const LITERAL_TAGS = new Set([
  'code',
  'c',
  'raw',
  'noparse',
  'plain',
  'url',
  'email',
  'profile',
  'img',
  'imagemap',
])

const TAG_RE = /\[(\/?)([a-z][a-z0-9_-]*)(?:[= ][^\]]*)?\]/gi

/**
 * Mark lines that start inside a literal BBCode block.
 *
 * Only the start of a line can carry a block marker, so a `#` after `[code]`
 * on the same line is irrelevant. Once a literal opens, every following line
 * is protected until its closer; a fence inside it is just code.
 */
function markProtected(lines: readonly string[]): boolean[] {
  const protectedLines = new Array<boolean>(lines.length).fill(false)
  let literal: string | null = null

  for (let i = 0; i < lines.length; i++) {
    protectedLines[i] = literal !== null
    let pos = 0
    const line = lines[i]

    while (pos < line.length) {
      if (literal !== null) {
        const close = line.toLowerCase().indexOf(`[/${literal}]`, pos)
        if (close === -1) break
        pos = close + literal.length + 3
        literal = null
        continue
      }

      TAG_RE.lastIndex = pos
      const match = TAG_RE.exec(line)
      if (!match) break
      pos = TAG_RE.lastIndex

      const closing = match[1] === '/'
      const tag = match[2].toLowerCase()
      if (!closing && LITERAL_TAGS.has(tag)) literal = tag
    }
  }

  return protectedLines
}

/** A tilde fence needs an info string; bare `~~~~` is an osu! divider. */
function isFenceOpener(marker: string, info: string): boolean {
  return marker[0] === '`' || info.trim() !== ''
}

function fenceClose(line: string, char: string, minimumLength: number): boolean {
  const match = /^\s*(`{3,}|~{3,})\s*$/.exec(line)
  return match !== null && match[1][0] === char && match[1].length >= minimumLength
}

/**
 * `::: details Title` -> a BBCode block with the same shape.
 *
 * Order matters: `::: box` and `::: details` are titled boxes, `::: quote` is
 * a quote, and `::: warning` is a notice. The default keeps the info string as
 * a title instead of throwing the author's text away.
 */
function containerTags(info: string): { open: string; close: string } {
  const firstSpace = info.indexOf(' ')
  const tag = (firstSpace === -1 ? info : info.slice(0, firstSpace)).toLowerCase()
  const rest = firstSpace === -1 ? '' : info.slice(firstSpace + 1).trim()

  switch (tag) {
    case 'details':
    case 'spoilerbox':
    case 'box':
    case 'boxw':
      // osu! only recognises a bare `[spoilerbox]`; its titled form is
      // forbidden by the measured pairing. A titled Markdown details block is
      // therefore a `[box=Title]`, exactly what the Markdown importer emits.
      return { open: `[box=${rest || 'Details'}]`, close: '[/box]' }
    case 'center':
    case 'centre':
      return { open: '[centre]', close: '[/centre]' }
    case 'right':
      return { open: '[right]', close: '[/right]' }
    case 'left':
      return { open: '[left]', close: '[/left]' }
    case 'quote':
      // osu! only seals a bare quote or a double-quoted author.
      return { open: rest ? `[quote="${rest}"]` : '[quote]', close: '[/quote]' }
    case 'info':
    case 'note':
    case 'warning':
    case 'tip':
    case 'caution':
    case 'notice':
    case 'wnotice':
      return { open: '[notice]', close: '[/notice]' }
    default:
      return { open: `[box=${info}]`, close: '[/box]' }
  }
}

/** Find the `:::` that closes the container opened before `start`. */
function findContainerEnd(
  lines: readonly string[],
  protectedLines: readonly boolean[],
  start: number,
): number {
  let depth = 1
  let fenceChar: string | null = null
  let fenceLength = 0

  for (let i = start + 1; i < lines.length; i++) {
    if (protectedLines[i]) continue
    const line = lines[i]

    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      const char = fence[1][0]
      if (fenceChar === null) {
        if (isFenceOpener(fence[1], fence[2])) {
          fenceChar = char
          fenceLength = fence[1].length
        }
      } else if (char === fenceChar && fenceClose(line, char, fenceLength)) {
        fenceChar = null
      }
      continue
    }
    if (fenceChar !== null) continue

    if (/^\s*:::\s*$/.test(line)) {
      depth--
      if (depth === 0) return i
    } else if (/^\s*:::\s+\S/.test(line)) {
      depth++
    }
  }

  return lines.length
}

interface ListLine {
  indent: number
  ordered: boolean
  content: string
}

/** Width of the leading whitespace, counting a tab as four columns. */
function leadingIndent(line: string): number {
  return /^\s*/.exec(line)![0].replace(/\t/g, '    ').length
}

function listLine(line: string): ListLine | null {
  const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
  if (!match) return null
  return {
    indent: match[1].replace(/\t/g, '    ').length,
    ordered: /^\d/.test(match[2]),
    content: match[3],
  }
}

/**
 * Convert one Markdown list level into `[list]` / `[*]`.
 *
 * Nested bullets are separate `[list]` blocks inside the previous `[*]`; the
 * BBCode parser already knows that shape, so a list inside a box or notice
 * keeps the same stack as the rest of the document. Continuation lines stay
 * with their item, and a blank line only continues the list when another item
 * follows — otherwise it ends the list like a paragraph would.
 */
function convertList(
  lines: readonly string[],
  start: number,
  baseIndent: number,
  ordered: boolean,
): { lines: string[]; end: number } {
  const out: string[] = [ordered ? '[list=1]' : '[list]']
  let i = start

  while (i < lines.length) {
    const item = listLine(lines[i])
    if (!item || item.indent < baseIndent) break
    if (item.indent > baseIndent) {
      break
    }
    if (item.ordered !== ordered) break

    out.push(`[*]${item.content}`)
    i++

    // Continuation content belongs to the item, and it may contain another
    // Markdown block (a fence, heading or nested quote). Translate that run as
    // a nested document so `- item` followed by a fence works like it does in
    // the Markdown importer.
    let run: string[] = []
    const flush = (): void => {
      if (run.length === 0) return
      out.push(...convertLines(run, true))
      run = []
    }

    while (i < lines.length) {
      const next = listLine(lines[i])
      if (next && next.indent > baseIndent) {
        flush()
        const nested = convertList(lines, i, next.indent, next.ordered)
        out.push(...nested.lines)
        i = nested.end
        continue
      }
      if (next) break

      if (lines[i].trim() === '') {
        let lookahead = i + 1
        while (lookahead < lines.length && lines[lookahead].trim() === '') lookahead++
        const after = lookahead < lines.length ? listLine(lines[lookahead]) : null
        if (after && after.indent >= baseIndent) {
          run.push('')
          i++
          continue
        }
        break
      }

      if (leadingIndent(lines[i]) > baseIndent) {
        run.push(lines[i])
        i++
        continue
      }
      break
    }
    flush()
  }

  out.push('[/list]')
  return { lines: out, end: i }
}

/**
 * Whether the document has a Markdown block whose marker cannot be mistaken
 * for osu! prose. A bare `- item` is deliberately not enough: osu! userpages
 * are full of decorative dashes and osu! publishes them literally. Once a
 * heading, fence, quote or `:::` is present, the author is writing Markdown,
 * so lists in the same document join the hybrid too.
 */
function hasUnambiguousMarkdownBlock(
  lines: readonly string[],
  protectedLines: readonly boolean[],
): boolean {
  for (let i = 0; i < lines.length; i++) {
    if (protectedLines[i]) continue
    const line = lines[i]
    if (/^ {0,3}#{1,6} /.test(line)
      || /^ {0,3}`{3,}/.test(line)
      || /^ {0,3}~{3,}\s*\S/.test(line)
      || /^ {0,3}:::\s+\S/.test(line)
      || /^ {0,3}>/.test(line)
      || /^ {0,3}->.*<-[ \t]*$/.test(line)) {
      return true
    }
  }
  return false
}

/**
 * Markdown's quote author forms: `**peppy**`, `**peppy wrote:**`,
 * `peppy wrote:` and a leading `[quote=peppy]` line. The Markdown importer
 * removes that line and sets `source`; the BBCode engine needs the same, or
 * the author becomes visible body text and the quote grows a second header.
 */
function quoteAuthor(inner: readonly string[]): { source?: string; rest: string[] } {
  if (inner.length === 0) return { rest: [] }
  const first = inner[0].trim()
  let source: string | undefined

  const bold = /^\*\*(.+?)\*\*(?:\s*(?:wrote:?|:))?\s*$/i.exec(first)
  if (bold) source = bold[1]
  else {
    const wrote = /^([^*\n]+?)\s+wrote:\s*$/i.exec(first)
    if (wrote) source = wrote[1]
    else {
      const tag = /^\[quote=["']?([^\]"']+)["']?\]$/i.exec(first)
      if (tag) source = tag[1]
    }
  }

  if (!source) return { rest: [...inner] }
  source = source.replace(/\s*wrote:\s*$/i, '').replace(/:\s*$/, '').trim()
  if (!source) return { rest: [...inner] }
  return { source, rest: inner.slice(1) }
}

/** `> [!NOTE]`, `> [!WARNING]`, and Obsidian's collapsible `[!NOTE]- Title`. */
function callout(inner: readonly string[]): { open: string; close: string; rest: string[] } | null {
  if (inner.length === 0) return null
  const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|DANGER|INFO)\]([+-])?\s*(.*)$/i.exec(inner[0].trim())
  if (!match) return null

  const kind = match[1].toUpperCase()
  const collapsible = match[2] !== undefined
  const title = match[3].trim()
  if (collapsible) {
    return {
      open: `[box=${title || 'Details'}]`,
      close: '[/box]',
      rest: inner.slice(1),
    }
  }
  const tag = kind === 'WARNING' || kind === 'CAUTION' || kind === 'DANGER' ? 'wnotice' : 'notice'
  return { open: `[${tag}]`, close: `[/${tag}]`, rest: inner.slice(1) }
}

function convertLines(lines: readonly string[], allowLists = false): string[] {
  const protectedLines = markProtected(lines)
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (protectedLines[i]) {
      out.push(line)
      i++
      continue
    }

    // Fenced code. Its body is copied verbatim; the inline layer skips
    // `[code]`, so `**in a fence**` stays literal.
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence && isFenceOpener(fence[2], fence[3])) {
      const indent = fence[1]
      const char = fence[2][0]
      const minimumLength = fence[2].length
      let end = i + 1
      while (end < lines.length && !fenceClose(lines[end], char, minimumLength)) end++

      out.push(`${indent}[code]`)
      for (let k = i + 1; k < end; k++) out.push(lines[k])
      out.push(`${indent}[/code]`)
      i = end < lines.length ? end + 1 : lines.length
      continue
    }

    // ATX heading. Level is deliberately not encoded: the BBCode heading is
    // the same `h2` the Markdown importer renders, and `[heading=9]` would
    // invent a level osu! does not have.
    const heading = /^(\s*)#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      out.push(`${heading[1]}[heading]${heading[2]}[/heading]`)
      i++
      continue
    }

    // `::: details Title` … `:::`
    const container = /^(\s*):::\s+(\S.*)$/.exec(line)
    if (container) {
      const indent = container[1]
      const end = findContainerEnd(lines, protectedLines, i)
      const tags = containerTags(container[2].trim())
      const inner = convertLines(lines.slice(i + 1, end), true)

      out.push(`${indent}${tags.open}`)
      out.push(...inner)
      out.push(`${indent}${tags.close}`)
      i = end < lines.length ? end + 1 : lines.length
      continue
    }

    // `> quote`. Recurse on the stripped lines so a heading, fence or nested
    // quote inside the quote is converted too.
    const quote = /^(\s*)>\s?(.*)$/.exec(line)
    if (quote) {
      const indent = quote[1]
      const inner: string[] = []
      let end = i
      while (end < lines.length) {
        const match = /^(\s*)>\s?(.*)$/.exec(lines[end])
        if (!match) break
        inner.push(match[2])
        end++
      }

      const note = callout(inner)
      if (note) {
        out.push(`${indent}${note.open}`)
        out.push(...convertLines(note.rest, true))
        out.push(`${indent}${note.close}`)
        i = end
        continue
      }

      const author = quoteAuthor(inner)
      // osu!'s countLimited quote family only matches a bare `[quote]` or a
      // double-quoted source. `[quote=peppy]` is published as literal text.
      const open = author.source ? `[quote="${author.source}"]` : '[quote]'
      out.push(`${indent}${open}`)
      out.push(...convertLines(author.rest, true))
      out.push(`${indent}[/quote]`)
      i = end
      continue
    }

    // Markdown list. Only converted when the document already declares a
    // Markdown block (or the list is inside a Markdown quote/container), so a
    // pasted osu! page keeps its decorative dash lines literal.
    if (allowLists) {
      const first = listLine(line)
      if (first) {
        const list = convertList(lines, i, first.indent, first.ordered)
        out.push(...list.lines)
        i = list.end
        continue
      }
    }

    // `-> text <-` / `-> text ->`. A block alignment, not inline emphasis.
    const arrow = /^(\s*)->\s*(.*?)\s*(<-|->)\s*$/.exec(line)
    if (arrow) {
      const tag = arrow[3] === '<-' ? 'centre' : 'right'
      out.push(`${arrow[1]}[${tag}]${arrow[2]}[/${tag}]`)
      i++
      continue
    }

    out.push(line)
    i++
  }

  return out
}

/**
 * Rewrite Markdown blocks as the BBCode blocks that mean the same thing.
 *
 * The returned source is what the BBCode engine parses. If the document has no
 * Markdown block, the original string is returned by reference and `changed`
 * is false, so a pure BBCode page keeps its byte-for-byte tree.
 */
export function rewriteMarkdownBlocks(source: string): MarkdownBlocksResult {
  if (source === '') return { source, changed: false }

  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const normalized = eol === '\n' ? source : source.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const allowLists = hasUnambiguousMarkdownBlock(lines, markProtected(lines))
  const rewritten = convertLines(lines, allowLists).join('\n')

  if (rewritten === normalized) return { source, changed: false }
  return {
    source: normalized === source ? rewritten : rewritten.replace(/\n/g, eol),
    changed: true,
  }
}
