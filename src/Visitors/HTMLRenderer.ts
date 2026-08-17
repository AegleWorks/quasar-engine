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

import type { BBCodeDialect } from '../BBCode/BBCodeToGreenNode'

export interface HTMLRendererOptions {
  /** 
   * Replicate osu! forum BBCode spacing quirks. 
   * Defaults to true for full compatibility with Miliastry. 
   * Set to false for a more logical, predictable rendering engine.
   */
  osuBehaviour?: boolean
  /** Registry for resolving custom tags */
  registry?: TagRegistry
  /** BBCode dialect to render for ('osu' | 'miliastry' | 'lyne') */
  dialect?: BBCodeDialect
  /** Visual theme for markup classes ('osu' | 'lyne' | 'miliastry') */
  theme?: 'osu' | 'lyne' | 'miliastry'
  /** Safe media proxy callback to rewrite image and media URLs */
  mediaProxy?: (url: string) => string
  /** Resolver for entity links like profile, guild, map */
  entityLinkResolver?: (kind: string, value: string) => { href: string; external?: boolean } | null
  /**
   * Forum-style `@mention` linkifier. Called with the bare name (no `@`);
   * return null to leave the mention as plain text. Used by forum hosts that
   * linkify `@username` to a profile route.
   */
  mentionResolver?: (name: string) => { href: string; external?: boolean } | null
  /**
   * Timestamp chip linkifier (`1:23`, `01:23.456`, `01:23:456`). Called with
   * the millisecond offset and the display label; return null to leave the
   * timestamp as plain text. Used by map hosts that deep-link into an editor.
   */
  timestampResolver?: (ms: number, label: string) => { href: string; external?: boolean } | null
}

export class HTMLRenderer extends Visitor<string> {
  private options: Required<Omit<HTMLRendererOptions, 'registry' | 'mediaProxy' | 'entityLinkResolver' | 'mentionResolver' | 'timestampResolver'>> & {
    registry?: TagRegistry
    mediaProxy?: (url: string) => string
    entityLinkResolver?: (kind: string, value: string) => { href: string; external?: boolean } | null
    mentionResolver?: (name: string) => { href: string; external?: boolean } | null
    timestampResolver?: (ms: number, label: string) => { href: string; external?: boolean } | null
  }

  constructor(options: HTMLRendererOptions = {}) {
    super()
    this.options = {
      osuBehaviour: options.osuBehaviour ?? true,
      registry: options.registry,
      dialect: options.dialect ?? (options.theme === 'lyne' ? 'lyne' : 'miliastry'),
      theme: options.theme ?? (options.dialect === 'lyne' ? 'lyne' : 'osu'),
      mediaProxy: options.mediaProxy,
      entityLinkResolver: options.entityLinkResolver,
      mentionResolver: options.mentionResolver,
      timestampResolver: options.timestampResolver,
    }
  }

  // ─── Tag → HTML Element Map ─────────────────────────────

  private readonly BLOCK_TAGS = new Set([
    'notice', 'wnotice', 'spoilerbox', 'box', 'boxw', 'list', 'quote', 'code', 'svg',
    'heading', 'center', 'right', 'left', 'align', 'imagemap', 'image', 'document',
    'tables', 'table_row', 'gallery', 'columns', 'separator', 'scroll',
    'container',
  ])

  private readonly INLINE_TAGS = new Set([
    'bold', 'italic', 'underline', 'strikethrough',
    'color', 'font_size', 'font',
    'inline_code', 'spoiler', 'url', 'email', 'profile', 'guild', 'map',
    'zalgo', 'aesthetic', 'sparkle', 'bubble', 'flower',
    'sup', 'sub', 'abbr', 'mark', 'kbd', 'tooltip', 'flip', 'raw', 'plain',
    'effect', 'anim', 'style_tag',
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
   * `'blocks'` queda disponible para quien priorice la latencia, y `'none'`
   * para los consumidores de solo lectura (foros, render estático): sin
   * `data-node-id` en absoluto, el HTML es más pequeño y no hay nada que
   * mantenga vivos los nodos del árbol.
   */
  static idMode: 'blocks' | 'all' | 'none' = 'all'

  /**
   * Nesting depth of `[tables]` while rendering. `[col]`/`[row]`/`[th]` are
   * table cells only INSIDE a `[tables]`; orphaned ones (e.g. `[col]` inside
   * `[columns]`, or stray cells) render as plain inline spans — the same rule
   * LYNE's forum renderer applies.
   */
  private tableDepth = 0

  private idAttr(node: RedNode): string {
    if (HTMLRenderer.idMode === 'none') return ''
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
    'notice', 'wnotice', 'spoilerbox', 'box', 'boxw', 'list', 'list_item', 'quote', 'code', 'svg',
    'heading', 'center', 'right', 'left', 'align', 'imagemap', 'image', 'video', 'audio',
    'tables', 'table_row', 'gallery', 'columns', 'separator', 'scroll', 'container',
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
  /**
   * Render the direct children of `node` to HTML (no wrapper element).
   *
   * Public so the incremental preview (`BlockPatcher`) can morph a block
   * element's inner content without re-rendering the whole document.
   */
  renderChildren(node: RedNode): string {
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
      let out = this.mentionResolver || this.options.timestampResolver
        ? this.linkifyText(node.text)
        : this.escapeHtml(node.text)
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
      case 'url': return this.renderLink(node, 'url')
      case 'email': return this.renderLink(node, 'email')
      case 'profile': return this.renderProfile(node)
      case 'image': return this.renderImage(node)
      case 'video': return this.renderVideo(node)
      case 'audio': return this.renderAudio(node)
      case 'center': return this.wrapBlock('div', node, 'style="text-align:center;"')
      case 'right': return this.wrapBlock('div', node, 'style="text-align:right;"')
      case 'left': return this.wrapBlock('div', node, 'style="text-align:left;"')
      case 'heading': return this.wrapBlock('h2', node)
      case 'notice': return this.renderNotice(node, false)
      case 'wnotice': return this.renderNotice(node, true)
      case 'quote': return this.renderQuote(node)
      case 'spoilerbox': return this.renderSpoilerbox(node)
      case 'box':
      case 'boxw': return this.renderBox(node)
      case 'list': return this.renderList(node)
      case 'list_item': return this.renderListItem(node)
      case 'code': return this.renderCode(node)
      case 'svg': return this.renderSVG(node)
      case 'imagemap': return this.renderImagemap(node)
      case 'align': return this.renderAlign(node)
      case 'tables': return this.renderTables(node)
      case 'table_row': return this.tableDepth > 0 ? this.wrapBlock('tr', node) : this.wrapInline('span', node)
      case 'table_col': {
        if (this.tableDepth <= 0) return this.wrapInline('span', node)
        const { cellCount, maxCols, isDirect } = this.getTableContext(node)
        let colspanAttr = ''
        if (node.metadata?.colspan) {
          colspanAttr = ` colspan="${node.metadata.colspan}"`
        } else if (cellCount === 1 && maxCols > 1) {
          colspanAttr = ` colspan="${maxCols}"`
        } else if (cellCount < maxCols && maxCols % cellCount === 0) {
          colspanAttr = ` colspan="${maxCols / cellCount}"`
        }
        const align = node.metadata?.align ? ` style="text-align:${node.metadata.align};"` : ''
        const td = `<td${this.idAttr(node)}${colspanAttr}${align}>${this.renderChildren(node)}</td>`
        return isDirect ? `<tr>${td}</tr>` : td
      }
      case 'table_th': {
        const content = this.renderChildren(node)
        if (this.tableDepth <= 0) return this.wrapInline('span', node)
        const { cellCount, maxCols, isDirect } = this.getTableContext(node)
        let colspanAttr = ''
        let fullCls = ''
        if (node.metadata?.colspan) {
          colspanAttr = ` colspan="${node.metadata.colspan}"`
        } else if (cellCount === 1) {
          colspanAttr = maxCols > 1 ? ` colspan="${maxCols}"` : ' colspan="100"'
          fullCls = ' bb-th-full'
        } else if (cellCount < maxCols && maxCols % cellCount === 0) {
          colspanAttr = ` colspan="${maxCols / cellCount}"`
        }
        const alignCls = node.metadata?.align ? ` bb-th-${node.metadata.align}` : ''
        const alignStyle = node.metadata?.align ? ` style="text-align:${node.metadata.align};"` : ''
        const th = `<th${this.idAttr(node)}${colspanAttr} class="bb-th${fullCls}${alignCls}"${alignStyle}><span class="bb-table-badge">${content}</span></th>`
        return isDirect ? `<tr>${th}</tr>` : th
      }
      case 'gallery': return this.renderGallery(node)
      case 'columns': return this.renderColumns(node)
      case 'separator': return this.renderSeparator(node)
      case 'scroll': return this.renderScroll(node)
      case 'sup': return this.wrapInline('sup', node)
      case 'sub': return this.wrapInline('sub', node)
      case 'abbr': return this.renderAbbr(node)
      case 'mark': return this.wrapInline('mark', node, 'class="bb-mark"')
      case 'kbd': return this.wrapInline('kbd', node, 'class="bb-kbd"')
      case 'tooltip': return this.renderTooltip(node)
      case 'flip': return this.wrapInline('span', node, 'style="display:inline-block;transform:scaleX(-1);"')
      case 'raw': return this.renderRaw(node)
      case 'plain': return this.renderPlain(node)
      case 'guild': return this.renderEntity(node, 'guild')
      case 'map': return this.renderEntity(node, 'map')
      case 'effect': return this.renderEffect(node)
      case 'anim': return this.renderAnim(node)
      case 'container': return this.renderContainer(node)
      case 'style_tag': return this.renderStyleTag(node)
      case 'zalgo': return this.wrapInline('span', node, 'class="zalgo"')
      case 'aesthetic': return this.wrapInline('span', node, 'class="aesthetic"')
      case 'sparkle': return this.wrapInline('span', node, 'class="sparkle"')
      case 'bubble': return this.wrapInline('span', node, 'class="bubble"')
      case 'flower': return this.wrapInline('span', node, 'class="flower"')
      case 'gradient': return this.renderGradient(node)
      case 'spacing':
        if (this.options.osuBehaviour && this.isNextCodeBlock(node)) return '\n'
        if (this.isTrailingBlockBoundary(node)) return '\n'
        return this.isPrevBlockBoundary(node) ? '\n' : '<br>'
      case 'empty_line':
        if (this.options.osuBehaviour && this.isImmediateEmptyLineBeforeCode(node)) return '\n'
        if (this.isTrailingBlockBoundary(node)) return '\n'
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

  private isTrailingBlockBoundary(node: RedNode): boolean {
    let next = node.nextSibling
    while (next) {
      if (next.kind === 'spacing' || next.kind === 'empty_line') {
        next = next.nextSibling
        continue
      }
      if (next.kind === 'text' && next.text.trim() === '') {
        next = next.nextSibling
        continue
      }
      break
    }
    if (!next && node.parent && this.BLOCK_TAGS.has(node.parent.kind) && node.parent.kind !== 'document') {
      return true
    }
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

  private static readonly BARE_HEX_RE = /^[0-9a-f]{3,8}$/i

  private static readonly NAMED_COLORS: Record<string, string> = {
    black: '#000000',
    white: '#FFFFFF',
    red: '#FF4C4C',
    green: '#2ECC71',
    blue: '#3498DB',
    yellow: '#F1C40F',
    cyan: '#2EE6E2',
    magenta: '#E056FD',
    pink: '#FF94C4',
    purple: '#A972FF',
    orange: '#FF9F43',
    amber: '#FFC34D',
    gray: '#8395A7',
    grey: '#8395A7',
    lime: '#10AC84',
    teal: '#01CBC6',
    violet: '#5F27CD',
    gold: '#FFD700',
  }

  private sanitizeColor(raw: string): string | null {
    let v = raw.trim()
    if (!v) return null
    if (HTMLRenderer.BARE_HEX_RE.test(v) && (v.length === 3 || v.length === 4 || v.length === 6 || v.length === 8)) {
      v = '#' + v
    }
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
    return this.renderEntity(node, 'profile')
  }

  private renderEntity(node: RedNode, type: 'profile' | 'guild' | 'map'): string {
    const key = type === 'profile' ? 'username' : type === 'guild' ? 'tag' : 'id'
    const val = String(node.metadata?.[key] ?? '') || this.extractValue(node)
    const content = this.renderChildren(node) || val
    if (this.options.entityLinkResolver) {
      const link = this.options.entityLinkResolver(type, val || content)
      if (link) {
        const ext = link.external ? ' target="_blank" rel="noopener noreferrer"' : ''
        return `<strong><a${this.idAttr(node)} href="${this.escapeHtml(link.href)}"${ext}>${content}</a></strong>`
      }
    }
    if (type === 'profile') {
      const url = this.options.theme === 'lyne' || this.options.dialect === 'lyne'
        ? `/u/${encodeURIComponent(val || content)}`
        : `https://osu.ppy.sh/users/${this.escapeHtml(val || content)}`
      return `<strong><a${this.idAttr(node)} href="${url}" target="_blank" rel="noopener">${content}</a></strong>`
    }
    if (type === 'guild') {
      return `<strong><a${this.idAttr(node)} href="/guilds/${encodeURIComponent(val || content)}">${content}</a></strong>`
    }
    if (type === 'map') {
      return `<strong><a${this.idAttr(node)} href="/maps/${encodeURIComponent(val || content)}">${content}</a></strong>`
    }
    return `<strong><a${this.idAttr(node)} href="#">${content}</a></strong>`
  }

  private parseImgAttr(v: string | null): { w?: number; h?: number; round?: boolean; shadow?: boolean; float?: boolean } {
    if (!v) return {}
    const t = v.trim().toLowerCase()
    if (t === 'round') return { round: true }
    if (t === 'shadow') return { shadow: true }
    if (t === 'float') return { float: true }
    const m = /^(\d{1,4})x(\d{1,4})$/i.exec(t)
    if (m) return { w: Math.min(2000, parseInt(m[1], 10)), h: Math.min(2000, parseInt(m[2], 10)) }
    return {}
  }

  private renderImage(node: RedNode): string {
    let src = String(node.metadata?.src ?? '') || this.extractValue(node) || ''
    if (!src) return '<div class="media-error">[img] missing source URL</div>'
    if (this.options.mediaProxy) {
      src = this.options.mediaProxy(src)
    }
    const imgAttr = this.parseImgAttr(this.extractValue(node))
    const styles: string[] = []
    if (imgAttr.w) styles.push(`width:${imgAttr.w}px`)
    if (imgAttr.h) styles.push(`height:${imgAttr.h}px`)
    if (imgAttr.round) {
      styles.push('border-radius:50%', 'object-fit:cover')
      if (!imgAttr.w) styles.push('width:120px')
      if (!imgAttr.h) styles.push('height:120px')
    }
    if (imgAttr.shadow) styles.push('box-shadow:0 0 15px rgba(0,0,0,0.5)')
    if (imgAttr.float) styles.push('float:left', 'margin:0 8px 8px 0')
    if (styles.length === 0) {
      styles.push('max-width:100%', 'height:auto', 'display:inline-block')
    }
    const cls = imgAttr.round ? '' : ' class="bb-img"'
    return `<img${this.idAttr(node)}${cls} src="${this.escapeHtml(src)}" alt="" style="${styles.join(';')};">`
  }

  private renderVideo(node: RedNode): string {
    let id = String(node.metadata?.videoId ?? '') || this.extractValue(node) || ''
    if (!id) return '<div class="media-error">[youtube] missing video ID</div>'
    const ytMatch = /(?:youtu\.be\/|v=|\/embed\/|\/shorts\/)([\w-]{11})/.exec(id)
    if (ytMatch) id = ytMatch[1]
    return `<iframe${this.idAttr(node)} src="https://www.youtube.com/embed/${this.escapeHtml(id)}" frameborder="0" allowfullscreen></iframe>`
  }

  private renderAudio(node: RedNode): string {
    let src = String(node.metadata?.src ?? '') || node.text || ''
    if (this.options.mediaProxy && src) {
      src = this.options.mediaProxy(src)
    }
    return `<audio${this.idAttr(node)} controls src="${this.escapeHtml(src)}" class="bb-audio"></audio>`
  }

  private hexToRgba(hex: string, alpha: number): string {
    let clean = hex.trim().toLowerCase()
    if (HTMLRenderer.NAMED_COLORS[clean]) {
      clean = HTMLRenderer.NAMED_COLORS[clean]
    }
    if (!clean.startsWith('#')) return clean
    const t = clean.replace('#', '')
    const full = t.length <= 4 ? t.split('').map(c => c + c).join('') : t
    const r = parseInt(full.slice(0, 2), 16) || 0
    const g = parseInt(full.slice(2, 4), 16) || 0
    const b = parseInt(full.slice(4, 6), 16) || 0
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  private renderNotice(node: RedNode, warning: boolean): string {
    const isLyne = this.options.theme === 'lyne' || this.options.dialect === 'lyne' || warning
    if (isLyne) {
      const color = this.sanitizeColor(this.metaOrAttr(node, 'color'))
      const styleAttr = color
        ? ` style="background:${this.hexToRgba(color, 0.08)};border-color:${this.hexToRgba(color, 0.4)};border-left-color:${color};color:${this.hexToRgba(color, 0.85)};"`
        : ''
      const markStyle = color ? ` style="color:${color};"` : ''
      const content = this.renderChildren(node)
      const warningIcon = warning ? `<span aria-hidden class="bb-notice-mark"${markStyle}>⚠</span>` : ''
      return `<div${this.idAttr(node)} class="notice bb-cut-panel bb-notice${warning ? ' bb-wnotice' : ''}" role="note"${styleAttr}>${warningIcon}<div class="bb-notice-body">${content}</div></div>`
    }

    return this.wrapBlock('div', node, 'class="notice"')
  }

  private renderTables(node: RedNode): string {
    const variant = (String(node.metadata?.variant ?? '') || this.extractValue(node) || '').trim().toLowerCase()
    const variants = new Set(variant.split(/[\s,]+/).filter(Boolean))
    const tableClasses = [
      'bb-table',
      variants.has('striped') ? 'bb-table-striped' : '',
      variants.has('borders') ? 'bb-table-borders' : '',
    ].filter(Boolean).join(' ')
    this.tableDepth++
    const content = this.renderChildren(node)
    this.tableDepth--
    // `[tables=striped:#hex]`: de `--table-accent` se deriva toda la paleta
    // de la tabla (gradiente del frame, hover de filas, encabezado, bordes).
    const accent = this.boxAccentStyle(node, 'table')
    return `<div${this.idAttr(node)} class="bb-table-frame"${accent}><table class="${tableClasses}"><tbody>${content}</tbody></table></div>`
  }

  private getTableContext(node: RedNode): { cellCount: number; maxCols: number; isDirect: boolean } {
    const parent = node.parent
    const isDirect = parent?.kind === 'tables'
    const tableNode = isDirect ? parent : (parent?.parent?.kind === 'tables' ? parent.parent : undefined)
    const cellCount = parent?.children
      ? parent.children.filter(c => c.kind === 'table_th' || c.kind === 'table_col').length
      : 1

    let maxCols = cellCount
    if (tableNode) {
      for (const row of tableNode.children) {
        if (row.kind === 'table_row') {
          const count = row.children.filter(c => c.kind === 'table_th' || c.kind === 'table_col').length
          if (count > maxCols) maxCols = count
        }
      }
    }
    return { cellCount, maxCols, isDirect }
  }

  private renderGallery(node: RedNode): string {
    const content = this.renderChildren(node)
    return `<div${this.idAttr(node)} class="bb-gallery">${content}</div>`
  }

  private renderColumns(node: RedNode): string {
    const cols = parseInt(String(node.metadata?.columns ?? '') || this.extractValue(node) || '2', 10)
    const numCols = Math.max(2, Math.min(4, isNaN(cols) ? 2 : cols))
    const content = this.renderChildren(node)
    // `[columns=2:#hex]`: con color se añade la superficie (borde + fondo
    // derivados del acento) para que el color se vea; sin color, grid limpio.
    const accent = this.boxAccentStyle(node, 'columns')
    const surfaceCls = accent ? ' bb-columns-surface' : ''
    const styleBase = `column-count:${numCols};`
    return `<div${this.idAttr(node)} class="bb-columns${surfaceCls}" style="${styleBase}">${content}</div>`
  }

  private renderSeparator(node: RedNode): string {
    const variant = (String(node.metadata?.variant ?? '') || this.extractValue(node) || 'line').trim().toLowerCase()
    if (variant === 'dots') return `<div${this.idAttr(node)} class="bb-separator">· · ·</div>`
    if (variant === 'stars') return `<div${this.idAttr(node)} class="bb-separator">✦ ✦ ✦</div>`
    return `<hr${this.idAttr(node)} class="bb-separator" />`
  }

  private renderScroll(node: RedNode): string {
    const h = parseInt(String(node.metadata?.height ?? '') || this.extractValue(node) || '200', 10)
    const maxH = Math.max(50, Math.min(2000, isNaN(h) ? 200 : h))
    const content = this.renderChildren(node)
    return `<div${this.idAttr(node)} class="bb-scroll" style="max-height:${maxH}px;">${content}</div>`
  }

  private renderAbbr(node: RedNode): string {
    const title = String(node.metadata?.title ?? '') || this.extractValue(node)
    const attr = title ? ` title="${this.escapeHtml(title)}"` : ''
    return this.wrapInline('abbr', node, attr)
  }

  private renderTooltip(node: RedNode): string {
    const tip = String(node.metadata?.tip ?? '') || this.extractValue(node)
    const attr = tip ? ` title="${this.escapeHtml(tip)}"` : ''
    return this.wrapInline('span', node, `class="bb-tooltip"${attr}`)
  }

  private renderRaw(node: RedNode): string {
    const text = this.collectNodeText(node) || node.text || ''
    return `<span${this.idAttr(node)} class="bb-raw">${this.escapeHtml(text)}</span>`
  }

  private renderPlain(node: RedNode): string {
    return `<span${this.idAttr(node)}>${this.escapeHtml(this.collectNodeText(node))}</span>`
  }

  private renderAlign(node: RedNode): string {
    const alignVal = (String(node.metadata?.align ?? '') || this.extractValue(node) || 'center').trim().toLowerCase()
    const validAlign = alignVal === 'left' || alignVal === 'right' ? alignVal : 'center'
    return this.wrapBlock('div', node, `style="text-align:${validAlign};"`)
  }

  private renderEffect(node: RedNode): string {
    const raw = (String(node.metadata?.effectType ?? '') || this.extractValue(node) || 'glow').toLowerCase().trim()
    const effectType = raw.includes(':') ? raw.split(':')[0] : (raw.startsWith('#') ? 'glow' : raw)
    const rawColor = String(node.metadata?.color ?? '') || (raw.includes(':') ? raw.split(':')[1] : (raw.startsWith('#') ? raw : this.extractValue(node)))
    const color = this.sanitizeColor(rawColor)
    const content = this.renderChildren(node)
    const idAttr = this.idAttr(node)

    switch (effectType) {
      case 'glow': {
        const c = color || 'var(--color-accent, #2EE6E2)'
        return `<span${idAttr} class="bb-glow" style="--glow-color:${c};text-shadow:0 0 4px ${c}, 0 0 8px ${c};">${content}</span>`
      }
      case 'neon': {
        // Fallback blanco como el renderer original de Lyne (c || '#fff').
        const c = color || '#fff'
        return `<span${idAttr} class="bb-neon" style="--neon-color:${c};">${content}</span>`
      }
      case 'outline': {
        const c = color || '#000'
        return `<span${idAttr} style="-webkit-text-stroke:1px ${c};paint-order:stroke fill;">${content}</span>`
      }
      case 'emboss': return `<span${idAttr} class="bb-emboss">${content}</span>`
      case 'engrave': return `<span${idAttr} class="bb-engrave">${content}</span>`
      // NOTA: el tipo 'shadow' se eliminó de Lyne — ignoraba el color y
      // chocaba con el kind `shadow` de osu. El `[shadow]` de osu sigue vivo
      // vía su propio kind (shadowStyle, con color).
      case 'shimmer': return `<span${idAttr} class="bb-shimmer">${content}</span>`
      case 'ghost': return `<span${idAttr} class="bb-ghost">${content}</span>`
      case 'rainbow': return `<span${idAttr} class="bb-rainbow">${content}</span>`
      case 'fire': return `<span${idAttr} class="bb-fire">${content}</span>`
      case 'ice': return `<span${idAttr} class="bb-ice">${content}</span>`
      default: return `<span${idAttr}>${content}</span>`
    }
  }

  private renderAnim(node: RedNode): string {
    const raw = (String(node.metadata?.animType ?? '') || this.extractValue(node) || 'pulse').toLowerCase().trim()
    const animType = raw.includes(':') ? raw.split(':')[0] : raw
    const content = this.renderChildren(node)
    const idAttr = this.idAttr(node)

    switch (animType) {
      case 'bounce': return `<span${idAttr} class="bb-bounce">${content}</span>`
      case 'shake': return `<span${idAttr} class="bb-shake">${content}</span>`
      case 'pulse': return `<span${idAttr} class="bb-pulse">${content}</span>`
      // NOTA: el tipo 'fade' se eliminó de Lyne (era duplicado de fade-in).
      case 'fade-in': return `<span${idAttr} class="bb-fade-in">${content}</span>`
      case 'fade-out': return `<span${idAttr} class="bb-fade-out">${content}</span>`
      case 'typewriter': {
        const charCount = this.collectNodeText(node).length || 20
        return `<span${idAttr} class="bb-typewriter-wrap" style="--bb-ch:${charCount};"><span class="bb-typewriter">${content}</span></span>`
      }
      case 'wave': return `<span${idAttr} class="bb-wave" style="display:inline-block;">${content}</span>`
      case 'sparkle': return `<span${idAttr} class="bb-sparkle">${content}</span>`
      case 'glitch': {
        const rawText = this.collectNodeText(node)
        return `<span${idAttr} class="bb-glitch" data-text="${this.escapeHtml(rawText)}">${content}</span>`
      }
      case 'levitate': return `<span${idAttr} class="bb-levitate" style="display:inline-block;">${content}</span>`
      default: return `<span${idAttr} class="bb-pulse">${content}</span>`
    }
  }

  private renderContainer(node: RedNode): string {
    const raw = (String(node.metadata?.containerType ?? '') || this.extractValue(node) || 'stack').trim()
    const [type, ...params] = raw.split(':')
    const containerType = type.toLowerCase()
    const param = params.join(':')
    const content = this.renderChildren(node)
    const idAttr = this.idAttr(node)

    switch (containerType) {
      case 'stack':
        return `<div${idAttr} class="bb-stack">${content}</div>`
      case 'flex': {
        const gap = parseInt(param || '8', 10)
        const safeG = Math.max(0, Math.min(100, isNaN(gap) ? 8 : gap))
        return `<div${idAttr} class="bb-flex" style="gap:${safeG}px;">${content}</div>`
      }
      case 'grid': {
        const n = parseInt(param || '2', 10)
        const cols = Math.max(1, Math.min(6, isNaN(n) ? 2 : n))
        return `<div${idAttr} class="bb-grid" style="grid-template-columns:repeat(${cols}, 1fr);">${content}</div>`
      }
      case 'middle':
        return `<div${idAttr} class="bb-middle">${content}</div>`
      case 'square':
      case 'circle': {
        const accent = this.sanitizeColor(param)
        const border = accent ? this.hexToRgba(accent, 0.35) : ''
        const bg = accent ? this.hexToRgba(accent, 0.08) : ''
        const style = accent ? ` style="--square-accent:${accent};--square-border:${border};--square-bg:${bg};"` : ''
        return `<div${idAttr} class="bb-square bb-cut-panel"${style}>${content}</div>`
      }
      case 'card':
      case 'glass': {
        // `[card=#hex]` / `[container=glass:#hex]`: el color se pasa como
        // `type:param` (igual que neon-box) y se emite como `--<tipo>-accent`
        // del que el CSS deriva borde, tinte de fondo y —vía la clase
        // `bb-accented`— la paleta del contenido sin color propio. Sin color,
        // defaults y sin clase.
        const accent = this.sanitizeColor(param)
        const cls = accent ? ' bb-accented' : ''
        const style = accent ? ` style="--${containerType}-accent:${accent};"` : ''
        return `<div${idAttr} class="bb-cut-panel bb-${containerType}${cls}"${style}>${content}</div>`
      }
      case 'neon-box':
      case 'neonbox': {
        const c = this.sanitizeColor(param || this.extractValue(node)) || 'var(--color-accent, #2EE6E2)'
        return `<div${idAttr} class="bb-cut-panel bb-neon-box" style="--neon-color:${c};border-color:${c};">${content}</div>`
      }
      default:
        return `<div${idAttr} class="bb-stack">${content}</div>`
    }
  }

  private static readonly STYLE_PROP_WHITELIST = new Set([
    'width', 'height', 'padding', 'margin', 'display',
    'background', 'border', 'opacity', 'filter', 'transform',
    'float', 'clear', 'white-space', 'font-variant', 'text-transform',
    'text-align', 'gap', 'color', 'font-size', 'font-weight',
    'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
    'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
    'line-height', 'letter-spacing', 'word-spacing',
  ])

  private renderStyleTag(node: RedNode): string {
    const raw = (String(node.metadata?.style ?? '') || this.extractValue(node) || '').trim()
    const content = this.renderChildren(node)
    const idAttr = this.idAttr(node)
    if (!raw) return `<span${idAttr}>${content}</span>`

    const safeStyles: string[] = []
    const decls = raw.split(';')
    for (const decl of decls) {
      const colon = decl.indexOf(':')
      if (colon < 0) continue
      const prop = decl.slice(0, colon).trim().toLowerCase()
      const val = decl.slice(colon + 1).trim()
      if (!prop || !val) continue
      if (!HTMLRenderer.STYLE_PROP_WHITELIST.has(prop)) continue
      // Los paréntesis son válidos en CSS (rgba(), blur(), rotate(), scale(),
      // color-mix()…) — antes se eliminaban y rompían esos valores. Lo que sí
      // se bloquea son las funciones/fuentes peligrosas (url(), expression(),
      // javascript:), que no tienen uso legítimo en el whitelist de props.
      const safeVal = val.replace(/["'{}<>]/g, '').slice(0, 100)
      if (/url\s*\(|expression\s*\(|javascript\s*:/i.test(safeVal)) continue
      safeStyles.push(`${prop}:${safeVal}`)
    }

    if (safeStyles.length === 0) return `<span${idAttr}>${content}</span>`
    return `<span${idAttr} style="${safeStyles.join(';')}">${content}</span>`
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
    const title = this.renderTitle(node, 'Spoiler')
    const content = this.renderChildren(node)
    const isLyne = this.options.theme === 'lyne' || this.options.dialect === 'lyne'
    const bodyCls = isLyne ? 'bb-box-body' : 'bbcode-box-body'
    // El wrapper agrupa el título en un solo flex item (ver renderBox) y usa
    // `bb-box-heading` (no `bb-box-title`) para no colisionar con la regla
    // legacy `.bbcode-preview .bb-box-title` de la app, que pinta un fondo.
    // `--box-accent` colorea el acento del box (título + chevron, y el borde
    // en boxw) cuando el autor puso `[box=Title:#hex]`.
    const accent = this.boxAccentStyle(node)
    return `<details${this.idAttr(node)}${accent}><summary><span class="bb-box-heading">${title}</span></summary><div class="${bodyCls}">${content}</div></details>`
  }

  private renderBox(node: RedNode): string {
    const title = this.renderTitle(node, 'Box')
    const content = this.renderChildren(node)
    const isLyne = this.options.theme === 'lyne' || this.options.dialect === 'lyne'
    const bodyCls = isLyne ? 'bb-box-body' : 'bbcode-box-body'
    // boxw = box con líneas y fondo (estilo Lyne). [box] normal queda limpio
    // por defecto; la clase `boxw` es la que dispara ese look en lyne.css.
    const cls = node.kind === 'boxw' ? 'box boxw' : 'box'
    // El wrapper agrupa el título en un solo flex item: sin él, el summary
    // flex de Lyne separa cada span de [color] con su gap. `bb-box-heading`
    // (no `bb-box-title`) evita la regla legacy `.bbcode-preview .bb-box-title`
    // de la app, que pinta un fondo sobre el título.
    const accent = this.boxAccentStyle(node)
    return `<details${this.idAttr(node)} class="${cls}"${accent}><summary><span class="bb-box-heading">${title}</span></summary><div class="${bodyCls}">${content}</div></details>`
  }

  private renderTitle(node: RedNode, fallback: string): string {
    const titleNodes = node.metadata?.titleNodes as RedNode[] | undefined
    if (titleNodes && titleNodes.length > 0) {
      return titleNodes.map(c => this.renderNode(c)).join('')
    }
    const title = node.metadata?.title ?? this.extractValue(node) ?? fallback
    return this.escapeHtml(String(title))
  }

  /**
   * `[box=Title:#hex]`, `[tables=striped:#hex]`, `[columns=2:#hex]` → un
   * ` style="--<suffix>-accent:#hex;"` del que el CSS deriva la paleta
   * (título + chevron y borde en boxw; gradientes/header/hover en tables;
   * borde + fondo en columns). Devuelve '' si no hay color válido.
   */
  private boxAccentStyle(node: RedNode, suffix: 'box' | 'table' | 'columns' = 'box'): string {
    const color = this.sanitizeColor(String(node.metadata?.color ?? ''))
    if (!color) return ''
    const border = this.hexToRgba(color, 0.35)
    const bg = this.hexToRgba(color, 0.08)
    return ` style="--${suffix}-accent:${color};--${suffix}-border:${border};--${suffix}-bg:${bg};"`
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
  /** Resolver configured at construction (read through a getter for brevity). */
  private get mentionResolver(): ((name: string) => { href: string; external?: boolean } | null) | undefined {
    return this.options.mentionResolver
  }

  /**
   * `@mention` shape used by forum hosts: 3-15 word chars, boundaries that
   * exclude longer usernames (same rule LYNE's forum uses). Non-global so
   * `lastIndex` never leaks between calls.
   */
  private static readonly MENTION_RE = /(?<![A-Za-z0-9_-])@([A-Za-z0-9_-]{3,15})(?![A-Za-z0-9_-])/g

  /**
   * Linkify a plain-text leaf: `@mention` runs and (optionally) timestamp
   * chips. Both run through their resolver; null leaves the run as text.
   * Every interpolated string is HTML-escaped, and hrefs with dangerous
   * protocols (javascript:, data:, vbscript:) are rejected (defence in depth;
   * the resolvers themselves should never produce one).
   */
  private linkifyText(text: string): string {
    const mentionResolver = this.options.mentionResolver
    const timestampResolver = this.options.timestampResolver
    if (!mentionResolver && !timestampResolver) return this.escapeHtml(text)

    let out = ''
    let last = 0
    HTMLRenderer.MENTION_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HTMLRenderer.MENTION_RE.exec(text)) !== null) {
      if (m.index > last) {
        out += this.linkifyTimestamps(text.slice(last, m.index), timestampResolver)
      }
      const name = m[1]
      const link = mentionResolver?.(name)
      if (link && this.isSafeHref(link.href)) {
        const ext = link.external ? ' target="_blank" rel="noopener"' : ''
        out += `<a class="bb-mention" href="${this.escapeHtml(link.href)}"${ext}>@${this.escapeHtml(name)}</a>`
      } else {
        out += this.escapeHtml(m[0])
      }
      last = m.index + m[0].length
    }
    if (last < text.length) {
      out += this.linkifyTimestamps(text.slice(last), timestampResolver)
    }
    return out
  }

  /** `1:23`, `01:23.456`, `01:23:456` — the editor deep-link shape. */
  private static readonly TS_RE = /\b(\d{1,2}):([0-5]\d)(?:\.(\d{1,3})\b|:(\d{1,3})\b)?/g

  private linkifyTimestamps(text: string, resolver: ((ms: number, label: string) => { href: string; external?: boolean } | null) | undefined): string {
    if (!resolver) return this.escapeHtml(text)

    let out = ''
    let last = 0
    HTMLRenderer.TS_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HTMLRenderer.TS_RE.exec(text)) !== null) {
      if (m.index > last) out += this.escapeHtml(text.slice(last, m.index))
      const minutes = parseInt(m[1], 10)
      const seconds = parseInt(m[2], 10)
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : m[4] ? parseInt(m[4], 10) : 0
      const ms = (minutes * 60 + seconds) * 1000 + frac
      const label = m[4]
        ? `${m[1].padStart(2, '0')}:${m[2]}:${m[4].padStart(3, '0')}`
        : m[3]
          ? `${m[1]}:${m[2]}.${m[3]}`
          : `${m[1]}:${m[2]}`
      const link = resolver(ms, label)
      if (link && this.isSafeHref(link.href)) {
        const ext = link.external ? ' target="_blank" rel="noopener"' : ''
        out += `<a class="bb-timeref" href="${this.escapeHtml(link.href)}"${ext}>${this.escapeHtml(label)}</a>`
      } else {
        out += this.escapeHtml(m[0])
      }
      last = m.index + m[0].length
    }
    if (last < text.length) out += this.escapeHtml(text.slice(last))
    return out
  }

  /** Root-relative, http(s), mailto and line:// hrefs are the only safe shapes. */
  private isSafeHref(href: string): boolean {
    const h = href.trim()
    if (h.startsWith('/') && !h.startsWith('//')) return true
    return /^(https?:|mailto:|line:)/i.test(h)
  }

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
