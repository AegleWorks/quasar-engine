/**
 * Reduces HTML to what a reader sees, so two renderers with different markup can be compared.
 *
 * Both sides become lines of text, each character carrying its inline style, under the
 * alignment/container it sits in. Line breaks follow CSS: `<br>` always ends a line, a block
 * boundary ends one only if it has content, collapsible whitespace never opens one. Needs a DOM
 * (`DOMParser`, `Node`): vitest's jsdom, or the jsdom the scripts install.
 */

import { normalizeCssColor } from './cssColor'
import { BBCodeDocumentModel } from '../../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../../Visitors/HTMLRenderer'

// ── What a reader sees ─────────────────────────────────────────────

const BLOCK = new Set(['DIV', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'P', 'PRE', 'TABLE', 'TR', 'CENTER'])

interface Cell { ch: string; key: string }

function inlineKey(el: Element, parent: Record<string, string>): Record<string, string> {
  const next = { ...parent }
  const tag = el.tagName
  // osu! titles a quote with <h4>; the preview with <strong>. Both read as bold.
  if (tag === 'STRONG' || tag === 'B' || tag === 'H4') next.b = '1'
  else if (tag === 'EM' || tag === 'I') next.i = '1'
  else if (tag === 'U' || tag === 'INS') next.u = '1'
  else if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') next.s = '1'
  else if (tag === 'A') next.href = el.getAttribute('href') ?? ''
  const style = el.getAttribute('style') ?? ''
  for (const prop of ['color', 'font-size'] as const) {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(style)
    if (m) next[prop] = prop === 'color' ? normalizeCssColor(m[1]) : m[1].trim().toLowerCase()
  }
  if (el.className.includes('bbcode-underline') || /text-decoration:\s*underline/i.test(style)) next.u = '1'
  if (/text-decoration:\s*line-through/i.test(style)) next.s = '1'
  return next
}

/** Container classes that change how the lines look; editor scaffolding (`bb-*`) is not one. */
function containerLabel(el: Element): string {
  const classes = [...el.classList].filter(c => !c.startsWith('bb-') && c !== 'bbcode' && c !== 'unordered')
  const tag = el.tagName
  // osu! writes a bullet list as <ol class="unordered">; the preview writes <ul>. Same page.
  if (tag === 'UL' || (tag === 'OL' && el.classList.contains('unordered'))) classes.unshift('list')
  else if (tag === 'OL') classes.unshift('list.ordered')
  else if (tag === 'LI') classes.unshift('item')
  else if (tag === 'BLOCKQUOTE') classes.unshift('quote')
  else if (tag === 'H2' || tag === 'H3') classes.unshift(tag.toLowerCase())
  return classes.sort().join('.')
}

export function visibleLines(html: string): string[] {
  const root = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body
  const lines: string[] = []
  let cur: Cell[] | null = null
  let ctx: string[] = []

  const close = () => {
    if (!cur) return
    while (cur.length && cur[0].ch === ' ') cur.shift()
    while (cur.length && cur[cur.length - 1].ch === ' ') cur.pop()
    let out = ''
    let key: string | null = null
    for (const c of cur) {
      if (c.key !== key) { out += `{${c.key}}`; key = c.key }
      out += c.ch
    }
    lines.push(`${ctx.join('>')}|${out}`)
    cur = null
  }

  const walk = (node: Node, style: Record<string, string>) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/[ \t\r\n]+/g, ' ')
      const key = JSON.stringify(Object.entries(style).sort())
      for (const ch of text) {
        // Collapsible whitespace never opens a line (it would be the gap between two <li>);
        // only a <br> or real text does.
        if (ch === ' ' && (!cur || !cur.length || cur[cur.length - 1].ch === ' ')) continue
        cur ??= []
        cur.push({ ch, key })
      }
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as Element
    if (el.hasAttribute('hidden') || /display:\s*none/i.test(el.getAttribute('style') ?? '')) return
    if (el.tagName === 'BR') { cur ??= []; close(); return }
    const block = BLOCK.has(el.tagName)
    const label = block ? containerLabel(el) : ''
    if (block) { close(); if (label) ctx = [...ctx, label] }
    const next = inlineKey(el, style)
    for (const child of el.childNodes) walk(child, next)
    if (block) { close(); if (label) ctx = ctx.slice(0, -1) }
  }

  for (const child of root.childNodes) walk(child, {})
  close()
  return lines
}

/**
 * `trim()` as PHP does it — osu! runs the page through `PHP trim()`, which
 * strips only space, `\t`, `\n`, `\r`, NUL and `\v`. JavaScript's own
 * `trim()` also eats U+3000, U+00A0, U+2028 and friends, so a page ending in an
 * ideographic space was being compared after losing it on one side only
 * (measured on `osu/15069567`: `…が好き　` publishes the space, the preview was
 * handed a source without it).
 */
export function phpTrim(text: string): string {
  return text.replace(/^[ \t\n\r\0\x0B]+/, '').replace(/[ \t\n\r\0\x0B]+$/, '')
}

/** osu-web's output wraps the page in `<div class='bbcode'>`. */
export const unwrapOsuHtml = (html: string): string => html.trim().replace(/^<div class='bbcode'>/, '').replace(/<\/div>$/, '')

/** The tree the app's osu! preview renders: `pairing: 'osu'`, dialect `osu`. */
export function previewDoc(source: string): BBCodeDocumentModel {
  return new BBCodeDocumentModel({ source, dialect: 'osu', pairing: 'osu', incremental: false })
}

/** The preview's HTML for a tree: osu theme. */
export function renderPreview(doc: BBCodeDocumentModel): string {
  return new HTMLRenderer({ dialect: 'osu', theme: 'osu' }).render(doc.redRoot!)
}

/** What the app's osu! preview renders for a source. */
export function previewHTML(source: string): string {
  return renderPreview(previewDoc(source))
}

export function firstDifference(a: string[], b: string[]): string {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return `line ${i + 1}\n  preview: ${a[i] ?? '(none)'}\n  osu!:    ${b[i] ?? '(none)'}`
  }
  return 'identical'
}
