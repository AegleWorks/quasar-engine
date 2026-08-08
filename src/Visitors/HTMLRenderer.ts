/**
 * DocumentEngine — HTMLRenderer
 *
 * Renders the Document Model to HTML for preview.
 * This is the main renderer for the visual BBCode preview.
 *
 * Uses the TagRegistry for custom rendering.
 * Plugins can register custom renderers for preview components.
 */

import { RedNode } from '../Syntax/RedNode'
import { Visitor } from './Visitor'
import type { TagRegistry } from '../Model/TagRegistry'
import { RenderTree } from '../RenderPipeline/RenderTree'

export interface HTMLRendererOptions {
  /** 
   * Replicate osu! forum BBCode spacing quirks. 
   * Defaults to true for full compatibility with Miliastry. 
   * Set to false for a more logical, predictable rendering engine.
   */
  osuBehaviour?: boolean
  /** Registry for resolving custom tags */
  registry?: TagRegistry
}

export class HTMLRenderer extends Visitor<string> {
  private options: Required<Omit<HTMLRendererOptions, 'registry'>> & { registry?: TagRegistry }

  constructor(options: HTMLRendererOptions = {}) {
    super()
    this.options = {
      osuBehaviour: options.osuBehaviour ?? true,
      registry: options.registry
    }
  }

  // ─── Tag → HTML Element Map ─────────────────────────────

  private readonly BLOCK_TAGS = new Set([
    'notice', 'spoilerbox', 'box', 'list', 'quote', 'code', 'svg',
    'heading', 'center', 'right', 'imagemap', 'image', 'document',
  ])

  private readonly INLINE_TAGS = new Set([
    'bold', 'italic', 'underline', 'strikethrough',
    'color', 'font_size', 'font', 'shadow',
    'inline_code', 'spoiler', 'url', 'email', 'profile',
    'zalgo', 'aesthetic', 'sparkle', 'bubble', 'flower',
  ])

  /**
   * The ` data-node-id="…"` attribute, or `''` for nodes nobody looks up.
   *
   * ─── Why this is not emitted on everything ──────────────────────────────
   *
   * It used to be, carrying `node.id` — a process-global counter minted per
   * RedNode, so a reparse renames every node in the document. Measured on a
   * one-character edit: zero ids survive.
   *
   * `DOMMorpher` already noted that this rules the ids out as morph KEYS. The
   * larger cost is that it also breaks the morpher's prefix/suffix trim, which
   * uses `isEqualNode` — a comparison that includes attributes. An attribute
   * that always differs makes every element compare unequal, so the trim never
   * fires and the morpher walks the whole document. Measured on one keystroke
   * in the reference document: **1665 `setAttribute` calls across 1725
   * elements**, to write new numbers meaning the same thing, when the actual
   * change was 10 insertions and 9 removals.
   *
   * ─── Why BLOCKS, and not stable ids ─────────────────────────────────────
   *
   * Making the id stable was the obvious repair and it does not work. Keying on
   * the node's SPAN was measured: an edit at the END drops the writes to 6, but
   * an insertion shifts every offset after it, so an edit near the START still
   * cost 1637 — and spans are longer strings than `nN`, so the emitted HTML grew
   * 10%. Stability under insertion is not something a position can have.
   *
   * The real observation is that no consumer ever wanted these on inline nodes.
   * Both readers in the app are block-level: `usePreviewClick` walks up with
   * `closest('[data-node-id]')` for *block selection*, and `useBlockHighlight`
   * highlights and scrolls to a *block*. Emitting ids on the per-character
   * spans of a gradient did not just cost — it made `closest()` stop at a
   * character instead of the block the click meant.
   *
   * So the attribute goes where it is read. Inline nodes carry no id, compare
   * equal, and let `isEqualNode` skip their subtrees natively; the handful of
   * block containers that do carry one are few enough that their churn is
   * noise.
   */
  /**
   * Text leaves emit their content directly, with no wrapper element.
   *
   * They used to come wrapped in `<span class="bb-text">` — one extra DOM
   * element per text leaf, which is HALF the preview's elements (measured:
   * 1726 → 851 on a 19.6 KB post, 17251 → 8510 on a 196 KB one). The class
   * earned none of it: it has no CSS rule anywhere in the repo, carries no
   * `data-node-id` (text is not an id-bearing kind, so click mapping and
   * highlighting never looked at it), and every style a text leaf can have
   * still emits its own `<span style="…">` below.
   *
   * A/B in a production build, steady state: flush 41.4 → 39.7 ms at 19.6 KB
   * and 55.4 → 46.4 ms at 196 KB, plus ~27% less HTML to serialize and parse.
   */
  private textWrap(node: RedNode, inner: string): string {
    return inner
  }

  /**
   * A qué elementos se les pone `data-node-id`.
   *
   * `'all'` (por defecto) — a todos. Es lo que permite que un clic en
   * CUALQUIER punto del preview señale ese nodo exacto en el editor: en un
   * degradado cada carácter es su propio nodo, y sin id no hay nada a lo que
   * `closest()` pueda agarrarse.
   *
   * Esto estuvo desactivado por una buena razón que ya no aplica. Los ids se
   * regeneraban en cada parseo, así que el atributo cambiaba en TODOS los
   * elementos por pulsación: `isEqualNode` no casaba nunca, el morpher no
   * podía saltarse ningún subárbol y se medían 1665 `setAttribute` sobre 1725
   * elementos para escribir números nuevos que significaban lo mismo. Con la
   * identidad estable entre reparseos eso desapareció: un nodo que no cambia
   * conserva su id, su HTML es idéntico y el camino rápido del morpher sigue
   * funcionando.
   *
   * El coste que queda es el tamaño: ~10 bytes por elemento, que hay que
   * serializar y parsear. Medido con A/B en la misma sesión sobre el post con
   * degradados (19,6 KB, 852 elementos):
   *
   *   solo bloques (9 con id):   latencia 48 ms · p95  72 ms
   *   todos      (808 con id):   latencia 56 ms · p95 104 ms
   *
   * Se paga a propósito: la precisión del clic es una función que se pidió, y
   * 56 ms sigue holgadamente dentro de lo que se percibe como inmediato.
   * `'blocks'` queda disponible para quien priorice la latencia.
   */
  static idMode: 'blocks' | 'all' = 'all'

  private idAttr(node: RedNode): string {
    if (HTMLRenderer.idMode === 'all') return ` data-node-id="${node.id}"`
    return HTMLRenderer.ID_BEARING_KINDS.has(node.kind)
      ? ` data-node-id="${node.id}"`
      : ''
  }

  /**
   * Kinds that carry `data-node-id`.
   *
   * The block containers a user can select or be scrolled to, plus the media
   * nodes, which are atomic and clickable in their own right. Deliberately NOT
   * `text` or any inline formatting kind — see {@link idAttr}.
   */
  private static readonly ID_BEARING_KINDS = new Set([
    'notice', 'spoilerbox', 'box', 'list', 'list_item', 'quote', 'code', 'svg',
    'heading', 'center', 'right', 'imagemap', 'image', 'video', 'audio',
  ])

  // ─── Main Entry ─────────────────────────────────────────

  visit(node: RedNode): string {
    return this.renderNode(node)
  }

  render(root: RedNode): string {
    return this.renderNode(root)
  }

  /**
   * Render every child and concatenate.
   *
   * Replaces the `children.map(c => this.renderNode(c)).join('')` idiom, which
   * was repeated at 16 call sites and allocated a closure plus an intermediate
   * array of N strings at every level of the tree. Appending to one string lets
   * the engine use its rope representation instead.
   */
  private renderChildren(node: RedNode): string {
    const children = node.children
    let out = ''
    for (let i = 0; i < children.length; i++) {
      out += this.renderNode(children[i])
    }
    return out
  }

  // ─── Node Rendering ─────────────────────────────────────

  private renderNode(node: RedNode): string {
    // Leaf nodes
    if (node.children.length === 0 && node.kind === 'text') {
      let out = this.escapeHtml(node.text)
      const style = node.metadata?.style as Record<string, string> | undefined
      if (style) {
        const inlineStyles = []
        const color = style.color && this.sanitizeColor(style.color)
        const fontSize = style.fontSize && this.sanitizeFontSize(style.fontSize)
        if (color) inlineStyles.push(`color: ${color}`)
        if (fontSize) inlineStyles.push(`font-size: ${fontSize}%`)
        if (this.isCssKeyword(style.fontWeight)) inlineStyles.push(`font-weight: ${style.fontWeight}`)
        if (this.isCssKeyword(style.fontStyle)) inlineStyles.push(`font-style: ${style.fontStyle}`)
        if (this.isCssKeyword(style.textDecoration)) inlineStyles.push(`text-decoration: ${style.textDecoration}`)

        if (inlineStyles.length > 0) {
          out = `<span style="${inlineStyles.join('; ')}">${out}</span>`
        }
      }
      return this.textWrap(node, out)
    }

    // Document root
    if (node.kind === 'document') {
      return this.renderChildren(node)
    }

    // Dispatch by kind
    switch (node.kind) {
      case 'bold': return this.wrapInline('strong', node)
      case 'italic': return this.wrapInline('em', node)
      case 'underline': return this.wrapInline('u', node)
      case 'strikethrough': return this.wrapInline('s', node)
      case 'inline_code': return this.wrapInline('code', node, 'class="inline"')
      case 'spoiler': return this.wrapInline('span', node, 'class="spoiler"')
      case 'color': return this.wrapInline('span', node, this.colorStyle(node))
      case 'font_size': return this.wrapInline('span', node, this.fontSizeStyle(node))
      case 'font': return this.wrapInline('span', node, this.fontStyle(node))
      case 'shadow': return this.wrapInline('span', node, this.shadowStyle(node))
      case 'url': return this.renderLink(node, 'url')
      case 'email': return this.renderLink(node, 'email')
      case 'profile': return this.renderProfile(node)
      case 'image': return this.renderImage(node)
      case 'video': return this.renderVideo(node)
      case 'audio': return this.renderAudio(node)
      case 'center': return this.wrapBlock('div', node, 'style="text-align:center;"')
      case 'right': return this.wrapBlock('div', node, 'style="text-align:right;"')
      case 'heading': return this.wrapBlock('h2', node)
      case 'notice': return this.wrapBlock('div', node, 'class="notice"')
      case 'quote': return this.renderQuote(node)
      case 'spoilerbox': return this.renderSpoilerbox(node)
      case 'box': return this.renderBox(node)
      case 'list': return this.renderList(node)
      case 'list_item': return this.renderListItem(node)
      case 'code': return this.renderCode(node)
      case 'svg': return this.renderSVG(node)
      case 'imagemap': return this.renderImagemap(node)
      case 'zalgo': return this.wrapInline('span', node, 'class="zalgo"')
      case 'aesthetic': return this.wrapInline('span', node, 'class="aesthetic"')
      case 'sparkle': return this.wrapInline('span', node, 'class="sparkle"')
      case 'bubble': return this.wrapInline('span', node, 'class="bubble"')
      case 'flower': return this.wrapInline('span', node, 'class="flower"')
      case 'gradient': return this.renderGradient(node)
      case 'spacing':
        if (this.options.osuBehaviour && this.isNextCodeBlock(node)) return '\n'
        return this.isPrevBlockBoundary(node) ? '\n' : '<br>'
      case 'empty_line':
        if (this.options.osuBehaviour && this.isImmediateEmptyLineBeforeCode(node)) return '\n'
        return '<br>'
      case 'group': return this.wrapInline('span', node, 'class="group"')
      // Un párrafo no tiene etiqueta propia en BBCode, pero sí necesita un
      // elemento: sin él, la prosa suelta entre bloques no es clicable —
      // `closest('[data-node-id]')` no encuentra nada y el clic se pierde.
      // Un `span` es inline, así que no altera el flujo del texto.
      case 'paragraph': return this.wrapInline('span', node, 'class="bb-paragraph"')
      case 'error': return this.renderError(node)
      case 'text':
        return this.textWrap(node, this.escapeHtml(node.text || ''))
      default:
        if (this.options.registry) {
          const tagDef = this.options.registry.getByKind(node.kind)
          if (tagDef?.toRenderNode) {
            const renderNode = tagDef.toRenderNode({
              node,
              source: '', // We don't have the original source string here, but it's rarely needed for effect tags
              visitChildren: (n) => this.renderChildren(n),
              renderChild: (n) => RenderTree.text('unsupported'),
            })
            return RenderTree.toHTML(renderNode)
          }
        }
        // A container of unknown kind (a plugin tag rendered without its
        // registry, or with no toRenderNode) must not swallow its children —
        // render them and skip only the unknown wrapper.
        if (node.children.length > 0) return this.renderChildren(node)
        return this.escapeHtml(node.text || '')
    }
  }

  // ─── Render Helpers ─────────────────────────────────────

  /** osu! quirk: newlines immediately preceding a [code] block are completely ignored */
  private isNextCodeBlock(node: RedNode): boolean {
    let next = node.nextSibling
    while (next && (next.kind === 'spacing' || next.kind === 'empty_line')) {
      next = next.nextSibling
    }
    return next?.kind === 'code'
  }

  /** Checks if this is the LAST empty_line right before a code block (skipping only spacing) */
  private isImmediateEmptyLineBeforeCode(node: RedNode): boolean {
    let next = node.nextSibling
    while (next && next.kind === 'spacing') {
      next = next.nextSibling
    }
    return next?.kind === 'code'
  }

  private isPrevBlockBoundary(node: RedNode): boolean {
    let prev = node.previousSibling
    while (prev) {
      if (prev.kind === 'spacing' || prev.kind === 'empty_line') {
        prev = prev.previousSibling
        continue
      }
      if (prev.kind === 'text' && prev.text.trim() === '') {
        prev = prev.previousSibling
        continue
      }
      break
    }
    
    if (prev && this.BLOCK_TAGS.has(prev.kind) && prev.kind !== 'image' && prev.kind !== 'imagemap') return true
    if (!prev && node.parent && this.BLOCK_TAGS.has(node.parent.kind) && node.parent.kind !== 'image' && node.parent.kind !== 'imagemap') return true

    return false
  }

  private renderError(node: RedNode): string {
    const errorMsg = this.escapeHtml((node.metadata?.message as string) || node.text || 'Syntax Error')
    // The content is the raw offending tag, mapped as child text.
    const content = this.renderChildren(node) || this.escapeHtml(node.text || '')
    return `<span class="syntax-error" style="color: #ff4d4f; border-bottom: 2px wavy #ff4d4f; cursor: help;" title="${errorMsg}">⚠️ ${content}</span>`
  }

  private wrapInline(tag: string, node: RedNode, extra: string = ''): string {
    const content = this.renderChildren(node)
    const extraSpace = extra ? ` ${extra}` : ''
    return `<${tag}${this.idAttr(node)}${extraSpace}>${content}</${tag}>`
  }

  private wrapBlock(tag: string, node: RedNode, extra: string = ''): string {
    const content = this.renderChildren(node)
    const extraSpace = extra ? ` ${extra}` : ''
    return `<${tag}${this.idAttr(node)}${extraSpace}>${content}</${tag}>`
  }

  // ─── CSS Value Allowlists ───────────────────────────────
  //
  // Tag attributes are attacker-controlled: any BBCode pasted from a forum
  // post reaches these functions verbatim. Interpolating them into a
  // `style="..."` attribute without validation lets a payload such as
  // `[color=red;" onmouseover="alert(1)]` close the attribute and inject a
  // live event handler. Escaping alone would neuter the injection, but a
  // half-escaped value still emits broken CSS, so we validate the shape and
  // drop anything that isn't a value we intended to support.

  /** #rgb / #rgba / #rrggbb / #rrggbbaa, a bare CSS color keyword, or rgb()/hsl(). */
  private static readonly CSS_COLOR_RE =
    /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|[a-z]{3,20}|(?:rgb|hsl)a?\([0-9a-z.,%\s/+-]{1,64}\))$/i

  /** Bare number — interpolated as a percentage. */
  private static readonly CSS_SIZE_RE = /^\d{1,4}(?:\.\d{1,2})?$/

  /** Font family list. Quotes are rejected outright; unquoted names are valid CSS. */
  private static readonly CSS_FONT_RE = /^[A-Za-z0-9 ,_-]{1,120}$/

  /** Characters `escapeHtml` has to rewrite. Non-global on purpose: `test` must not carry `lastIndex`. */
  private static readonly HTML_ESCAPE_RE = /[&<>"']/

  private sanitizeColor(raw: string): string | null {
    const v = raw.trim()
    return HTMLRenderer.CSS_COLOR_RE.test(v) ? v : null
  }

  private sanitizeFontSize(raw: string): string | null {
    const v = raw.trim()
    return HTMLRenderer.CSS_SIZE_RE.test(v) ? v : null
  }

  private sanitizeFontFamily(raw: string): string | null {
    const v = raw.trim()
    return HTMLRenderer.CSS_FONT_RE.test(v) ? v : null
  }

  /** Keyword-or-number CSS values (font-weight, font-style, text-decoration). */
  private isCssKeyword(raw: string | undefined): boolean {
    return !!raw && /^[a-z]{2,20}(?: [a-z]{2,20})?$|^[1-9]00$/i.test(raw.trim())
  }

  /** Read a metadata field, falling back to the raw tag attribute. */
  private metaOrAttr(node: RedNode, key: string): string {
    const meta = node.metadata?.[key]
    return (typeof meta === 'string' && meta) || this.extractValue(node)
  }

  private colorStyle(node: RedNode): string {
    const color = this.sanitizeColor(this.metaOrAttr(node, 'color'))
    return color ? `style="color:${color};"` : ''
  }

  private fontSizeStyle(node: RedNode): string {
    const size = this.sanitizeFontSize(this.metaOrAttr(node, 'size'))
    return size ? `style="font-size:${size}%;"` : ''
  }

  private fontStyle(node: RedNode): string {
    const font = this.sanitizeFontFamily(this.metaOrAttr(node, 'font'))
    return font ? `style="font-family:${font};"` : ''
  }

  private shadowStyle(node: RedNode): string {
    const color = this.sanitizeColor(this.metaOrAttr(node, 'color'))
    return color ? `style="text-shadow:0 0 3px ${color};"` : ''
  }

  /**
   * Extract the attribute value from a BBCode tag node.
   *
   * BBCode attributes come in the format `=VALUE` (e.g. `=#61afef`, `="Author"`,
   * `=https://osu.ppy.sh`). This strips the leading `=` and any surrounding quotes.
   *
   * For tags without attrs (like text nodes, img content), returns the node text as-is.
   */
  private extractValue(node: RedNode): string {
    const text = node.text || ''
    if (!text) return ''

    const eqIdx = text.indexOf('=')
    if (eqIdx >= 0) {
      // Strip `=` prefix and surrounding quotes
      let value = text.slice(eqIdx + 1)
      // Remove surrounding quotes: "value" or 'value'
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      return value
    }

    // No `=` prefix — return as-is (used for media content like img URLs)
    return text
  }

  private renderLink(node: RedNode, kind: string): string {
    let href = String(node.metadata?.href ?? '') || this.extractValue(node)
    // Ensure the URL has a protocol for external links
    if (href && !href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('mailto:')) {
      href = 'https://' + href
    }
    const content = this.renderChildren(node) || href
    const h = href ? ` href="${this.escapeHtml(href)}"` : ''    
    return `<a${this.idAttr(node)}${h} target="_blank" rel="noopener">${content}</a>`
  }

  private renderProfile(node: RedNode): string {
    const username = String(node.metadata?.username ?? '') || this.extractValue(node)
    const content = this.renderChildren(node) || username
    return `<strong><a${this.idAttr(node)} href="https://osu.ppy.sh/users/${this.escapeHtml(username || content)}" target="_blank">${content}</a></strong>`
  }

  private renderImage(node: RedNode): string {
    const src = String(node.metadata?.src ?? '') || this.extractValue(node) || ''
    if (!src) return '<div class="media-error">[img] missing source URL</div>'
    return `<img${this.idAttr(node)} src="${this.escapeHtml(src)}" alt="" style="max-width:100%;height:auto;display:inline-block;">`
  }

  private renderVideo(node: RedNode): string {
    const id = String(node.metadata?.videoId ?? '') || this.extractValue(node) || ''
    if (!id) return '<div class="media-error">[youtube] missing video ID</div>'
    return `<iframe${this.idAttr(node)} src="https://www.youtube.com/embed/${this.escapeHtml(id)}" frameborder="0" allowfullscreen></iframe>`
  }

  private renderAudio(node: RedNode): string {
    const src = String(node.metadata?.src ?? '') || node.text || ''
    return `<audio${this.idAttr(node)} controls src="${this.escapeHtml(src)}"></audio>`
  }

  private renderQuote(node: RedNode): string {
    const source = node.metadata?.source || this.extractValue(node)
    const content = this.renderChildren(node)
    if (source) {
      return `<blockquote${this.idAttr(node)}><div style="margin-bottom:8px"><strong>${this.escapeHtml(String(source))} wrote:</strong></div>${content}</blockquote>`
    }
    return `<blockquote${this.idAttr(node)}>${content}</blockquote>`
  }

  private renderSpoilerbox(node: RedNode): string {
    const title = node.metadata?.title || this.extractValue(node) || 'Spoiler'
    const content = this.renderChildren(node)
    return `<details${this.idAttr(node)}><summary>${this.escapeHtml(String(title))}</summary>${content}</details>`
  }

  private renderBox(node: RedNode): string {
    const title = node.metadata?.title || this.extractValue(node) || 'Box'
    const content = this.renderChildren(node)
    return `<details${this.idAttr(node)} class="box"><summary>${this.escapeHtml(String(title))}</summary>${content}</details>`
  }

  private renderList(node: RedNode): string {
    // Check for ordered list: [list=1], [list=a], or metadata
    const attrs = this.extractValue(node)
    const isOrdered = node.metadata?.ordered === true || attrs === '1' || attrs === 'a'
    const tag = isOrdered ? 'ol' : 'ul'
    const content = node.children.map(c => this.renderNode(c)).join('\n')
    return `<${tag}${this.idAttr(node)}>${content}</${tag}>`
  }

  private renderListItem(node: RedNode): string {
    const content = this.renderChildren(node)
    return `<li${this.idAttr(node)}>${content}</li>`
  }

  private renderCode(node: RedNode): string {
    let content = node.children.map(c => c.text || '').join('')
    // osu! quirk: strip leading and trailing empty lines inside [code]
    const leadingMatch = content.match(/^(?:[\t ]*[\r\n])+/)
    if (leadingMatch) content = content.slice(leadingMatch[0].length)
    
    const trailingMatch = content.match(/(?:[\r\n][\t ]*)+$/)
    if (trailingMatch) content = content.slice(0, -trailingMatch[0].length)

    return `<pre${this.idAttr(node)}><code>${this.escapeHtml(content)}</code></pre>`
  }

  private renderSVG(node: RedNode): string {
    const innerHtml = node.children ? node.children.map(c => this.visit(c)).join('') : ''
    
    return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"${this.idAttr(node)}>
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" class="bbcode-preview miliastry-svg-container" style="width: 100%; height: 100%; overflow: auto;">
          ${innerHtml}
        </div>
      </foreignObject>
    </svg>`
  }

  /**
   * Render an osu! BBCode imagemap.
   *
   * Structure:
   *   [imagemap]
   *   https://example.com/image.png    ← first line = image URL
   *   10 20 50 60 https://... Label    ← subsequent lines = clickable areas
   *   [/imagemap]
   *
   * Each area line format: x y width height url [label]
   * All values are PERCENTAGES (0–100) relative to the image dimensions.
   * Uses CSS absolute positioning with percentage coordinates.
   */
  private renderImagemap(node: RedNode): string {
    const rawText = this.collectNodeText(node)
    const textLines = rawText
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)

    if (textLines.length === 0) {
      return '<div class="media-error">[imagemap] missing image URL</div>'
    }

    const imageUrl = textLines[0]
    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      return `<div class="media-error">[imagemap] invalid image URL: ${this.escapeHtml(imageUrl)}</div>`
    }

    let areas = ''
    for (let i = 1; i < textLines.length; i++) {
      const line = textLines[i]
      const parts = line.split(/\s+/)
      if (parts.length < 5) continue

      const x = parseFloat(parts[0])
      const y = parseFloat(parts[1])
      const w = parseFloat(parts[2])
      const h = parseFloat(parts[3])
      const url = parts[4]
      const label = parts.slice(5).join(' ')

      if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) continue

      let areaUrl = url
      if (areaUrl && !areaUrl.startsWith('http://') && !areaUrl.startsWith('https://') && !areaUrl.startsWith('mailto:')) {
        areaUrl = 'https://' + areaUrl
      }

      areas += `<a${this.idAttr(node)} href="${this.escapeHtml(areaUrl)}" target="_blank" rel="noopener" class="imagemap-area bbcode-imap-area" style="position:absolute;left:${x}%;top:${y}%;width:${w}%;height:${h}%;" title="${this.escapeHtml(label || 'Link')}"></a>`
    }

    return `<div${this.idAttr(node)} class="imagemap-container bbcode-imagemap" style="position:relative;display:inline-block;"><img src="${this.escapeHtml(imageUrl)}" alt="imagemap" style="max-width:100%;height:auto;display:block;">${areas}</div>`
  }

  private collectNodeText(node: RedNode): string {
    if (node.kind === 'spacing' || node.kind === 'empty_line') return '\n'
    if (node.children && node.children.length > 0) {
      return node.children.map(c => this.collectNodeText(c)).join('')
    }
    return node.text || ''
  }

  private renderGradient(node: RedNode): string {
    // `startsWith('#')` was NOT a filter: `#a" onmouseover="alert(1)` passes it.
    // Every stop must survive the full color allowlist or it is dropped.
    const raw = (node.metadata?.colors as string[]) || []
    const valid = raw
      .map(c => (typeof c === 'string' ? this.sanitizeColor(c) : null))
      .filter((c): c is string => c !== null)
    const colors =
      valid.length === 0 ? ['#FF0000', '#00FF00']
      : valid.length === 1 ? [valid[0], valid[0]]
      : valid
    // Skip spacing/empty_line children so source formatting (newlines inside the tag)
    // doesn't produce extra <br> in the preview. Both:
    //   [gradient]Hello[/gradient]  and  [gradient]\nHello\n[/gradient]
    // render identically.
    const content = node.children
      .filter(c => c.kind !== 'spacing' && c.kind !== 'empty_line')
      .map(c => this.renderNode(c)).join('')
    const gradientCss = `linear-gradient(to right, ${colors.join(', ')})`
    return `<span${this.idAttr(node)} style="background: ${gradientCss}; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">${content}</span>`
  }

  /**
   * Escape for both text content and double-quoted attribute values.
   *
   * `'` is included because attribute values elsewhere in the codebase (and in
   * consumer-supplied tag handlers) may be single-quoted; leaving it raw makes
   * the escaping context-dependent, which is how injections get reintroduced.
   */
  /**
   * Escape the five HTML-significant characters.
   *
   * Was five chained `.replace(/x/g, …)` calls: five full scans of the string
   * and up to five intermediate allocations for *every* text node, even though
   * ordinary prose contains none of these characters. This tests once and
   * returns the input untouched in that common case, then does a single pass
   * when there is actually something to escape.
   */
  private escapeHtml(text: string): string {
    if (!HTMLRenderer.HTML_ESCAPE_RE.test(text)) return text

    let out = ''
    let last = 0
    for (let i = 0; i < text.length; i++) {
      let replacement: string
      switch (text.charCodeAt(i)) {
        case 38: replacement = '&amp;'; break   // &
        case 60: replacement = '&lt;'; break    // <
        case 62: replacement = '&gt;'; break    // >
        case 34: replacement = '&quot;'; break  // "
        case 39: replacement = '&#39;'; break   // '
        default: continue
      }
      out += text.slice(last, i) + replacement
      last = i + 1
    }
    return out + text.slice(last)
  }
}
