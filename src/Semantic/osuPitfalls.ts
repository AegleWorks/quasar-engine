/**
 * Quasar — markup that looks right and is not.
 *
 * Every finding here is something the preview can show as fine while osu!
 * (or any reader of the published text) gets something else. Each one was
 * found in a real profile and checked against osu-web's own pipeline
 * (`BBCodeForDB` → `BBCodeFromDB`, run in PHP):
 *
 *  - `url-markdown-link` — a Markdown link pasted into `[url=…]` (an AI
 *    answer's `[https://x](https://x?utm_source=…)`). osu! ends the address at
 *    the first `]`: the link goes nowhere and `(https://…)]` is printed before
 *    the link text.
 *  - `unicode-url` — an address written in styled letters (`𝐡𝐭𝐭𝐩𝐬://…`, what a
 *    "bold Unicode" converter makes of it). osu! only knows `https://` in
 *    plain letters: the link is dead, and an `[imagemap]` whose image is
 *    styled is printed as raw text.
 *  - `osu-titled-spoilerbox` (info) — `[spoilerbox=Title]` does not exist in osu!.
 *    Quasar's export writes it as `[box=Title]`, but text copied as it is
 *    prints the opener literally and its `[/spoilerbox]` closes two boxes
 *    that were not its own.
 *  - `osu-nested-alignment` (info) — `[centre]` inside `[centre]`. osu! pairs each
 *    opener with the FIRST closer after it, so the inner opener is printed and
 *    the outer closer is left over. Again the export flattens it; copied as
 *    it is, it breaks.
 *  - `gradient-outlier` — one colour in a smooth run of `[color]`s that
 *    breaks it: a slip of the colour picker, usually dark enough to hide the
 *    letter it paints.
 *
 * Each carries the `data` its fix needs (see `Fixes/validatorFixes.ts`).
 */

import type { RedNode } from '../Syntax/RedNode'
import type { BBCodeDialect } from '../BBCode/BBCodeToGreenNode'
import { createDiagnostic } from '../Types/diagnostics'
import type { Validator } from './SemanticAnalyzer'

interface Span { start: number; end: number }

/** `[tag…]`: from the node's start to its first `]`. */
function openerRange(node: RedNode, source: string): Span | null {
  if (source.charCodeAt(node.range.start) !== 0x5b /* [ */) return null
  const close = source.indexOf(']', node.range.start)
  if (close < 0 || close >= node.range.end) return null
  return { start: node.range.start, end: close + 1 }
}

/** `[/name]` at the node's very end, when the author wrote it. */
function closerRange(node: RedNode, source: string, name: string): Span | null {
  const closer = `[/${name}]`
  const start = node.range.end - closer.length
  if (start < node.range.start) return null
  return source.slice(start, node.range.end).toLowerCase() === closer ? { start, end: node.range.end } : null
}

function tagName(node: RedNode, source: string): string | null {
  const m = /^\[([a-zA-Z][a-zA-Z0-9]*)/.exec(source.slice(node.range.start, node.range.start + 24))
  return m ? m[1].toLowerCase() : null
}

// ── url-markdown-link ────────────────────────────────────────────────────

const MD_LINK = /\[(https?:\/\/[^\]\s]+)\]\((https?:\/\/[^)\s]+)\)/i
const PAREN_URL = /\((https?:\/\/[^)\s]+)\)/i

/** Tracking parameters an AI answer or a share button appends; never part of the destination. */
function withoutTracking(url: string): string {
  const q = url.indexOf('?')
  if (q < 0) return url
  const kept = url.slice(q + 1).split('&').filter((p) => p && !/^utm_/i.test(p))
  return kept.length ? `${url.slice(0, q)}?${kept.join('&')}` : url.slice(0, q)
}

/** The address a Markdown-damaged `[url=…]` meant, or null when there is no telling. */
export function intendedUrl(href: string): string | null {
  const md = MD_LINK.exec(href)
  if (md) return withoutTracking(md[1])
  const paren = PAREN_URL.exec(href)
  if (paren) return withoutTracking(paren[1])
  return null
}

// ── unicode-url ──────────────────────────────────────────────────────────

/** Tokens of `text` that are addresses written in look-alike letters, and their plain spelling. */
export function styledUrls(text: string, offset: number): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = []
  const token = /[^\s[\]=]+/g
  let m: RegExpExecArray | null
  while ((m = token.exec(text)) !== null) {
    const raw = m[0]
    // Plain ASCII is what it looks like; only compatibility forms can hide an address.
    if (/^[\x00-\x7f]*$/.test(raw)) continue
    const plain = raw.normalize('NFKC')
    if (plain === raw || !/^(https?:\/\/|mailto:)/i.test(plain)) continue
    out.push({ start: offset + m.index, end: offset + m.index + raw.length, text: plain })
  }
  return out
}

// ── gradient-outlier ─────────────────────────────────────────────────────

function hexOf(node: RedNode): string | null {
  const raw = String(node.metadata?.color ?? node.text ?? '').replace(/^=/, '').trim()
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : null
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** The `[color]` siblings around `node` that form one run: only short spacing between them. */
function colorRun(node: RedNode): RedNode[] {
  const siblings = node.parent?.children ?? []
  let current: RedNode[] = []
  for (const s of siblings) {
    if (s.kind === 'color') current.push(s)
    else if (s.kind === 'text' && s.text.length <= 3 && !s.text.includes('\n')) continue
    else {
      if (current.includes(node)) return current
      current = []
    }
  }
  return current.includes(node) ? current : []
}

function toHex(c: [number, number, number], like: string): string {
  const hex = '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  return like === like.toLowerCase() ? hex : hex.toUpperCase()
}

// ── the validators ───────────────────────────────────────────────────────

export function osuPitfallValidators(analyzer: { dialect: BBCodeDialect }): Validator[] {
  return [
    {
      code: 'url-markdown-link',
      severity: 'error',
      kinds: ['url'],
      validate: (node, ctx) => {
        const href = String(node.metadata?.href ?? '')
        if (!href.includes('[') && !href.includes('](')) return null
        const idx = ctx.source.indexOf(href, node.range.start)
        const range = idx >= 0 && idx + href.length <= node.range.end ? { start: idx, end: idx + href.length } : node.range
        const url = intendedUrl(href)
        return createDiagnostic(
          'url-markdown-link',
          'This link carries Markdown ([text](address)): osu! cuts the address at the first "]", so the link breaks and part of the address is printed',
          'error',
          {
            nodeId: node.id,
            nodeKind: node.kind,
            range,
            // Taking the address the Markdown wrapped is the one reading of
            // it; an address that cannot be recovered gets no fix.
            ...(url && range !== node.range ? { data: { range, url }, equivalenceKey: 'url-markdown-link' } : {}),
          },
        )
      },
    },
    {
      code: 'unicode-url',
      severity: 'error',
      kinds: ['url', 'image', 'imagemap'],
      validate: (node, ctx) => {
        const edits = styledUrls(ctx.source.slice(node.range.start, node.range.end), node.range.start)
        if (edits.length === 0) return null
        return createDiagnostic(
          'unicode-url',
          'An address written in styled letters (𝐡𝐭𝐭𝐩𝐬://…): osu! only recognises plain https://, so it does not load',
          'error',
          {
            nodeId: node.id,
            nodeKind: node.kind,
            range: { start: edits[0].start, end: edits[edits.length - 1].end },
            // Plain letters are what the styled ones stand for (NFKC):
            // the address it always meant, nothing else touched.
            data: { edits },
            equivalenceKey: 'unicode-url',
          },
        )
      },
    },
    {
      code: 'osu-titled-spoilerbox',
      // Information, not a warning: through the export it is fine, and the
      // app's own templates write it. It only breaks copied as it is.
      severity: 'info',
      kinds: ['spoilerbox'],
      validate: (node, ctx) => {
        if (analyzer.dialect !== 'osu') return null
        const open = openerRange(node, ctx.source)
        if (!open || !/^\[spoilerbox=/i.test(ctx.source.slice(open.start, open.end))) return null
        const close = closerRange(node, ctx.source, 'spoilerbox')
        return createDiagnostic(
          'osu-titled-spoilerbox',
          '[spoilerbox=…] does not exist in osu!: the export writes it as [box=…], but copied as it is the tag is printed as text and its [/spoilerbox] closes the wrong box',
          'info',
          {
            nodeId: node.id,
            nodeKind: node.kind,
            range: open,
            // [box=Title] is what the export writes: the same box, spelled
            // the way osu! reads it.
            ...(close ? { data: { open: { start: open.start, end: open.start + '[spoilerbox'.length }, close }, equivalenceKey: 'osu-titled-spoilerbox' } : {}),
          },
        )
      },
    },
    {
      code: 'osu-nested-alignment',
      severity: 'info',
      kinds: ['center', 'left', 'right'],
      validate: (node, ctx) => {
        if (analyzer.dialect !== 'osu') return null
        let outer: RedNode | null = null
        for (let p = node.parent; p; p = p.parent) if (p.kind === node.kind) { outer = p; break }
        if (!outer) return null
        const name = tagName(node, ctx.source)
        const open = openerRange(node, ctx.source)
        const close = name ? closerRange(node, ctx.source, name) : null
        return createDiagnostic(
          'osu-nested-alignment',
          `[${name ?? node.kind}] inside another [${name ?? node.kind}]: the export flattens it, but copied as it is osu! pairs each opener with the first closer and prints this one as text`,
          'info',
          {
            nodeId: node.id,
            nodeKind: node.kind,
            range: open ?? node.range,
            // Unwrapping the inner one is what the export does: the outer
            // already aligns everything inside it.
            ...(open && close ? { data: { openRange: open, closeRange: close } } : {}),
          },
        )
      },
    },
    {
      code: 'gradient-outlier',
      severity: 'warning',
      kinds: ['color'],
      validate: (node, ctx) => {
        const run = colorRun(node)
        if (run.length < 4) return null
        const i = run.indexOf(node)
        const hex = run.map(hexOf)
        if (i < 1 || i > run.length - 2 || !hex[i] || !hex[i - 1] || !hex[i + 1]) return null
        const prev = rgb(hex[i - 1]!)
        const next = rgb(hex[i + 1]!)
        const self = rgb(hex[i]!)
        const expected: [number, number, number] = [(prev[0] + next[0]) / 2, (prev[1] + next[1]) / 2, (prev[2] + next[2]) / 2]
        const span = dist(prev, next)
        // Equal neighbours are an accent between two of the same colour
        // (`♡` in pink between two magentas), not a gradient to break.
        if (span === 0) return null
        // The run around it must itself be smooth — alternating colours
        // (A B A B) are a pattern, not a slip.
        const steps: number[] = []
        if (i >= 2 && hex[i - 2]) steps.push(dist(rgb(hex[i - 2]!), prev))
        if (i + 2 < run.length && hex[i + 2]) steps.push(dist(next, rgb(hex[i + 2]!)))
        if (steps.length === 0 || Math.max(...steps) > Math.max(span, 12) * 1.5 + 6) return null
        const off = dist(self, expected)
        if (off < 60 || off < 4 * Math.max(span, 8)) return null
        const open = openerRange(node, ctx.source)
        const valueAt = open ? ctx.source.indexOf(hex[i]!, open.start) : -1
        const suggested = toHex(expected, hex[i - 1]!)
        return createDiagnostic(
          'gradient-outlier',
          `${hex[i]} breaks the colour run between ${hex[i - 1]} and ${hex[i + 1]} — probably meant ${suggested}`,
          'warning',
          {
            nodeId: node.id,
            nodeKind: node.kind,
            range: node.range,
            // Manual: it changes what the reader sees — to what the run says
            // was meant, but still the author's call.
            ...(valueAt >= 0 && open && valueAt < open.end ? { data: { range: { start: valueAt, end: valueAt + 7 }, color: suggested } } : {}),
          },
        )
      },
    },
  ]
}

