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
import {
  nodeAttrValue,
  osuCssColor,
  parseImgAttr,
  sanitizeColor,
  sanitizeFontFamily,
  sanitizeFontSize,
  maxFontSizeScale,
} from '../Syntax/nodeAttr'
import { Visitor } from './Visitor'
import type { TagRegistry } from '../Model/TagRegistry'
import { RenderTree, engineHTML } from '../RenderPipeline/RenderTree'
import { STYLE_PROP_WHITELIST, stripStyleValue, isDangerousStyleValue } from '../Utils/safeStyle'

import { isBlockKind, type BBCodeDialect } from '../BBCode/BBCodeToGreenNode'
import { OsuSemanticModel } from '../Semantic/osu/OsuSemanticModel'
import { SWALLOWED_NEWLINE_ATTR, TERMINAL_LINE_ATTR } from './domMarkers'
import { isTerminalNewline } from './terminalLine'
import { bearsLines, breaksLine, LINE_ID_PREFIX } from '../Semantic/lines'
import { clampFontSizeForRender, maxFontSizeFor } from '../Utils/FontSizeLimits'
import { osuPurifiedHref } from '../Osu/osuUrl'
import { evaluateEffect, type EffectKind, type EffectParams } from '../Utils/EffectMath'
import {
  toTokenResolver,
  resolveTokenValue,
  type TokenResolverFn,
  type TokenSource,
} from '../Tokens'

export interface HTMLRendererOptions {
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
  /** Design tokens or resolver function */
  tokens?: TokenSource
  /**
   * Render newlines inside a box/spoilerbox title as line breaks.
   *
   * The parser always keeps them in the title; without this they reach the
   * HTML as a raw `\n` and collapse into a space, so a multi-line title reads
   * as one line. osu! breaks the line (its final `nl2br` pass runs over the
   * title too), but this is not tied to the osu dialect: every dialect honours
   * it. On by default.
   */
  boxTitleLineBreaks?: boolean
  /**
   * Which nodes carry `data-node-id` (see `HTMLRenderer.idMode` for what each
   * mode costs and buys). Per renderer, so a read-only render (`'none'`) and
   * the editor's preview (`'all'`) can coexist without touching shared state.
   * Unset: the process-wide default, `HTMLRenderer.idMode`.
   */
  idMode?: 'blocks' | 'all' | 'none'
  /**
   * Wrap each line of a container (`Semantic/lines.ts`) in
   * `<span class="bb-line" data-node-id="line:…">`, so a caret or a click in
   * loose text inside a box resolves to that line instead of the whole box.
   *
   * Off unless asked for: it is a handle for a surface that highlights and
   * selects — the editor's preview — and nothing else wants it. An editable
   * surface (the WYSIWYG canvas, whose DOM is reconciled back into BBCode)
   * and a published render stay exactly as they were. Ignored under
   * `idMode: 'none'`, where there are no ids to carry.
   */
  lineHandles?: boolean
  /**
   * Paint the line after a flow's last newline.
   *
   * HTML draws nothing after a last `<br>`, so a text ending in `\n` shows one
   * line fewer than it has, and that last line is where the caret is after
   * Enter. Lexical keeps a managed `<br>` there for the same reason. With this
   * the newline paints with a second `<br>` that holds that line, so every line
   * of the source is on screen whether or not the caret is on it. Inline, so it
   * opens no line of its own inside a padded inline parent (a gradient).
   *
   * Only for an editable surface: a published page ends where its text ends,
   * and a preview stays what the reader gets. Off unless asked for.
   */
  terminalLines?: boolean
  /**
   * Collapse a run of visible newlines into one `<br>` plus a single spacer of
   * `n - 1` line-heights, instead of one element per blank line.
   *
   * Only for READ-ONLY renders (`idMode: 'none'` and no `lineHandles`): the
   * editor needs one element per line so a caret, a click or a highlight can
   * target it, and this deliberately throws that away. Off by default.
   *
   * The height is written as `(n - 1) lh` (the `lh` unit, resolved against the
   * spacer's inherited line-height), which is exactly what those `n - 1` line
   * boxes occupy in a normal flow — measured against the uncollapsed HTML
   * on the corpus' pathological page (51.909 newlines): same `scrollHeight`,
   * 1,9 MB → 15 KB of HTML and 285 ms → 0,8 ms of layout. A host whose CSS
   * gives `.bb-empty-line` a `min-height` or margins larger than its line box
   * would need to style `.bb-blank-run` to match.
   */
  collapseBlankRuns?: boolean
}

/**
 * Block containers where collapsing a run of blank lines is safe.
 *
 * The first newline of the run stays a `<br>` and the rest become one block
 * spacer. That is only valid where a block element is allowed and where the
 * run is laid out in normal flow: not inside an inline wrapper (`<span>`,
 * `<em>`, an `<a>`), and not inside a list or a table, whose children have
 * their own permitted content models. `heading` is excluded for the same
 * reason (an `<h2>` only takes phrasing content). `container` is out too:
 * its children are items of a flex/grid layout, not blocks in normal flow, so
 * a run there is not the vertical stack this spacer reproduces.
 */
const BLANK_RUN_PARENTS: ReadonlySet<string> = new Set([
  'document', 'box', 'boxw', 'spoilerbox', 'notice', 'wnotice', 'quote',
  'center', 'left', 'right', 'align', 'box_tail', 'scroll',
])

/** Saltos de línea a convertir en `<br>` al pintar un efecto. */
const NEWLINE_RE = /\n/g

/** Saltos de línea de un título de box (ver `boxTitleLineBreaks`). */
const TITLE_NEWLINE_RE = /\r?\n/g

/**
 * A newline osu! swallows. osu! DELETES it; the preview still has to carry it,
 * because the WYSIWYG → BBCode path (`HTMLToGreenNode`, `SurgicalReconciler`)
 * reads it back as the source newline. It used to be a bare `'\n'`: harmless
 * after a block, but a real space after an inline-block (`.imagemap`, a
 * YouTube embed), which moved a word to the next line (measured with osu!'s
 * own app.css on `originals/tesla.bbcode`). An empty hidden element carries
 * the newline with no layout at all. See docs/10-Semantic-Model-Plan.md.
 *
 * `<span data-bb-nl hidden>` carries its node's id like every other break
 * (`<br>`, an empty line): the WYSIWYG canvas puts the caret on a line that
 * has no layout yet — Enter at the end of a box — by finding that line's
 * node, which it can only do by id. So the pattern allows one.
 */
const SWALLOWED_NEWLINE_RE = new RegExp(`<span ${SWALLOWED_NEWLINE_ATTR} hidden(?: data-node-id="[^"]*")?></span>`, 'g')

/**
 * The edge newline `trimOsuEdges` removes. It is a swallowed one, so it
 * arrives as the marker; a bare `\n` is still trimmed for any other source.
 */
/**
 * Un marcador de salto empieza siempre así: lo que sigue es `>`, o su
 * `data-node-id` y luego `>`, y en los dos casos cierra con `</span>`.
 */
const SWALLOWED_NEWLINE_HEAD = `<span ${SWALLOWED_NEWLINE_ATTR} hidden`
const NODE_ID_PREFIX = ' data-node-id="'
/**
 * `String.prototype.startsWith`, without flattening the rope.
 *
 * A rendered body is a cons string (`out += …` at every level). `startsWith`
 * makes V8 flatten the WHOLE rope just to look at its first bytes, and
 * `trimOsuEdges` runs that check on every box body that begins with `<` —
 * which is most of them — then throws the flattened copy away. Reading the
 * same characters with `charCodeAt` needs no flatten and allocates nothing.
 */
function startsWithAt(html: string, needle: string, at: number): boolean {
  const end = at + needle.length
  if (at < 0 || end > html.length) return false
  for (let i = 0; i < needle.length; i++) {
    if (html.charCodeAt(at + i) !== needle.charCodeAt(i)) return false
  }
  return true
}
/**
 * Lo más largo que puede llegar a medir un marcador de salto, contando un
 * `data-node-id` holgado. Un borde final no puede empezar más atrás que esto.
 */
const MAX_MARKER_LENGTH = 96
/**
 * Los cierres de las etiquetas que un bloque puede partir, ya escritos.
 *
 * Un objeto por envoltorio costaba el 20 % de un render del corpus entero
 * (uno por `[b]`, uno por `[size]`…): las mismas tres listas paralelas, con
 * el cierre repetido en vez de construido, no reservan nada.
 */
const CUT_CLOSE: Readonly<Record<string, string>> = {
  span: '</span>',
  h2: '</h2>',
  strong: '</strong>',
  em: '</em>',
  u: '</u>',
  s: '</s>',
  code: '</code>',
}

/** A rendered line with nothing to show: empty, or spaces and tabs only. */
const BLANK_LINE_RE = /^[\t ]*$/

/**
 * The lines of `text`, trimmed and without the blank ones.
 *
 * `.split().map(trim).filter(Boolean)` allocated three arrays for what a
 * single pass builds: this runs on every `[imagemap]` line and every box body.
 */
function trimmedLines(text: string): string[] {
  const parts = text.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i].trim()
    if (line !== '') out.push(line)
  }
  return out
}

/** Referencia a un token de diseño dentro de un texto: `$nombre`. */
const TOKEN_REF_RE = /\$([\p{L}_][\p{L}\p{M}\p{N}_-]*)/gu

/**
 * Un enlace automático que empieza en una hoja de texto y no acaba en ella:
 * su target se traga los hermanos siguientes hasta el final de la línea.
 *
 * `BBCodeForDB::parseLinks` corre sobre el texto con sus tags dentro, así que
 * el target puede contener etiquetas (`https://x[b]B[/b]TAIL`). Al publicarse,
 * `BBCodeFromDB` convierte esas etiquetas en HTML DENTRO del `href`, y
 * HTMLPurifier corta el atributo en el primer `<`: el `href` es el texto hasta
 * el primer elemento, y el ancla se queda abierta con todo lo demás hasta el
 * final del target.
 */
interface OsuSpanLink {
  /** Desplazamiento dentro de la hoja donde empieza la URL. */
  offset: number
  /** El `href` publicado (el texto hasta el primer tag), o `null` si el purificador lo quita. */
  href: string | null
  /** Índice del último hijo de la línea que queda DENTRO del ancla. */
  endsAt: number
  /**
   * Si el target acaba en MEDIO de esa hoja: desplazamiento donde se cierra el
   * ancla. Sin esto, el cierre cae al final de la hoja entera.
   */
  endOffset?: number
}

export class HTMLRenderer extends Visitor<string> {
  private tokenResolver?: TokenResolverFn
  private options: Required<Omit<HTMLRendererOptions, 'registry' | 'mediaProxy' | 'entityLinkResolver' | 'mentionResolver' | 'timestampResolver' | 'tokens' | 'idMode' | 'lineHandles' | 'terminalLines'>> & {
    idMode?: 'blocks' | 'all' | 'none'
    lineHandles?: boolean
    terminalLines?: boolean
    registry?: TagRegistry
    mediaProxy?: (url: string) => string
    entityLinkResolver?: (kind: string, value: string) => { href: string; external?: boolean } | null
    mentionResolver?: (name: string) => { href: string; external?: boolean } | null
    timestampResolver?: (ms: number, label: string) => { href: string; external?: boolean } | null
    tokens?: TokenSource
  }

  /** Explicit `idMode: 'none'`: skip the static-default lookup per node. */
  private readonly noIds: boolean

  constructor(options: HTMLRendererOptions = {}) {
    super()
    this.noIds = options.idMode === 'none'
    // Los ids de línea y los handles son justo lo que el colapso se lleva por
    // delante: sin `idMode: 'none'` explícito no se activa aunque lo pidan.
    this.collapseBlankRuns = options.collapseBlankRuns === true &&
      options.idMode === 'none' && options.lineHandles !== true
    this.tokenResolver = toTokenResolver(options.tokens)
    this.options = {
      registry: options.registry,
      dialect: options.dialect ?? (options.theme === 'lyne' ? 'lyne' : 'miliastry'),
      theme: options.theme ?? (options.dialect === 'lyne' ? 'lyne' : 'osu'),
      mediaProxy: options.mediaProxy,
      entityLinkResolver: options.entityLinkResolver,
      mentionResolver: options.mentionResolver,
      timestampResolver: options.timestampResolver,
      tokens: options.tokens,
      boxTitleLineBreaks: options.boxTitleLineBreaks ?? true,
      idMode: options.idMode,
      lineHandles: options.lineHandles,
      terminalLines: options.terminalLines,
      collapseBlankRuns: this.collapseBlankRuns,
    }
    this.semantic = new OsuSemanticModel(this.options.dialect)
  }

  /**
   * What the document means under osu!'s rules; see `Semantic/osu/OsuSemanticModel`.
   * Its answers are memoized per node, so it is valid for ONE tree snapshot.
   * `render` picks the model of the document's root green — green nodes are
   * immutable, so the same root green is the same structure — and makes one
   * for a green it has not seen: the red tree it is handed next time may be
   * the same objects with spliced children.
   */
  private semantic: OsuSemanticModel
  /** One model per document snapshot, by root green; dropped with the snapshot. */
  private readonly semanticBySnapshot = new WeakMap<object, OsuSemanticModel>()

  setTokens(tokens?: TokenSource): void {
    this.tokenResolver = toTokenResolver(tokens)
    this.options.tokens = tokens
  }

  getTokenResolver(): TokenResolverFn | undefined {
    return this.tokenResolver
  }

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
   *
   * Es el valor POR DEFECTO del proceso. Un renderer concreto lo fija con la
   * opción `idMode`, que es lo que hay que usar para un render puntual: cambiar
   * este estático afecta a todo renderer que exista, incluido cualquiera que
   * pinte mientras tanto.
   */
  static idMode: 'blocks' | 'all' | 'none' = 'all'

  /**
   * Nesting depth of `[tables]` while rendering. `[col]`/`[row]`/`[th]` are
   * table cells only INSIDE a `[tables]`; orphaned ones (e.g. `[col]` inside
   * `[columns]`, or stray cells) render as plain inline spans — the same rule
   * LYNE's forum renderer applies.
   */
  private tableDepth = 0

  /**
   * Un `[url]`/`[email]` está pintando a sus hijos ahora mismo: la URL que
   * llevan como texto ya es el enlace, y linkificarla otra vez la dejaría
   * dentro de dos `<a>` (osu! publica uno solo).
   */
  private linkifySuppressed = false

  /**
   * Los envoltorios inline abiertos ahora mismo, de fuera hacia dentro.
   *
   * Un bloque los corta a todos (ver `renderCutBlock`): los `<span>`/`<h2>`
   * para siempre, los de formato cerrándose y reabriéndose dentro. Se vacía
   * al empezar cada render, porque una pila que sobreviva a un corte por
   * dentro dejaría el siguiente bloque con envoltorios de otro árbol.
   *
   * Tres listas paralelas y un contador en vez de un objeto por envoltorio: la
   * pila se toca una vez por etiqueta inline del documento, y en el corpus eso
   * era un objeto (y su basura) por cada `[b]`.
   */
  private cutOpens: string[] = []
  private cutCloses: string[] = []
  /** `1` en los envoltorios que HTMLPurifier reabre dentro del bloque. */
  private cutReopens: number[] = []
  /** Los primeros N envoltorios ya emitieron su cierre (ver `renderCutBlock`). */
  private cutClosed = 0

  /** Cuántos `[youtube]` van incrustados en este render (ver `renderVideo`). */
  private youtubeEmbeds = 0

  /**
   * `youtube_embed_max` de osu-web: hasta este número de embeds, y a partir
   * de ahí un enlace (ver `renderVideo`).
   */
  private static readonly OSU_YOUTUBE_EMBED_MAX = 10

  /**
   * ¿Estamos emitiendo el vocabulario de clases de osu!?
   *
   * osu estiliza box, spoilerbox, notice, imagemap, youtube, los alineados y
   * los perfiles POR NOMBRE DE CLASE, no por estilo inline. Sobre una userpage
   * real el HTML de Quasar salía sin estilo porque emitía su propio
   * vocabulario (`<details>`, `.notice`, `.imagemap-container`…). Bajo
   * `dialect: 'osu'` se emiten las clases y la estructura de osu; el resto de
   * dialectos conserva la suya, que es la que sus hojas de estilo esperan.
   */
  private isOsu(): boolean {
    return this.options.dialect === 'osu'
  }

  /**
   * Los `[*]` que una lista está sacando de su bloque mientras pinta: su lugar
   * en el árbol ya no es donde se ven. Ver `renderOsuListBody`.
   */
  private readonly osuPruned = new Set<RedNode>()

  /** Ver `HTMLRendererOptions.collapseBlankRuns`. */
  private readonly collapseBlankRuns: boolean

  /**
   * Cuántas listas aplanadas se están pintando (ver `renderOsuFlatList`):
   * mientras haya una, un `[*]` de dentro no abre `<li>`.
   */
  private osuFlatListDepth = 0

  /** osu recorta los saltos pegados a la apertura y al cierre de box/notice. */
  private static trimOsuEdges(html: string): string {
    const n = html.length
    if (n === 0) return html
    const first = html.charCodeAt(0)
    if (first === 10 || first === 13 || first === 9 || first === 32) {
      // El borde de entrada se buscaba con una expresión regular anclada; se
      // comprueba a mano. Son los mismos tres casos — espacios, un salto, o
      // el marcador de salto — sin recorrer el cuerpo entero del box para
      // descubrir, casi siempre, que no había nada que recortar.
      let at = 0
      while (at < n) {
        const c = html.charCodeAt(at)
        if (c === 9 || c === 32) at += 1
        else break
      }
      if (at < n && html.charCodeAt(at) === 13 && html.charCodeAt(at + 1) === 10) at += 2
      else if (at < n && html.charCodeAt(at) === 10) at += 1
      else {
        const marker = HTMLRenderer.swallowedNewlineEnd(html, at)
        if (marker === -1) at = 0
        else at = marker
      }
      if (at > 0) html = html.slice(at)
    } else if (first === 60 /* < */ && startsWithAt(html, SWALLOWED_NEWLINE_HEAD, 0)) {
      // Un `<` normal abre cualquier elemento; sólo el marcador de salto se
      // recorta. Comprobarlo antes de `swallowedNewlineEnd` evita pagar el
      // análisis del prefijo en cada box que empieza por HTML.
      const marker = HTMLRenderer.swallowedNewlineEnd(html, 0)
      if (marker !== -1) html = html.slice(marker)
    }
    return HTMLRenderer.trimTrailingOsuEdge(html)
  }

  /**
   * El final del marcador de salto que empieza en `at`, o -1 si ahí no hay uno.
   *
   * `swallowedNewline` lo escribe siempre igual — `<span data-bb-nl hidden>`
   * con su `data-node-id` opcional — así que reconocerlo es comparar dos
   * prefijos y encontrar el `>` que lo cierra, sin expresión regular ni la
   * rebanada que ésta necesitaba.
   */
  private static swallowedNewlineEnd(html: string, at: number): number {
    if (!startsWithAt(html, SWALLOWED_NEWLINE_HEAD, at)) return -1
    let p = at + SWALLOWED_NEWLINE_HEAD.length
    if (html.charCodeAt(p) !== 62 /* > */) {
      if (!startsWithAt(html, NODE_ID_PREFIX, p)) return -1
      const quote = html.indexOf('"', p + NODE_ID_PREFIX.length)
      if (quote === -1 || html.charCodeAt(quote + 1) !== 62) return -1
      p = quote + 2
    } else {
      p += 1
    }
    return startsWithAt(html, '</span>', p) ? p + 7 : -1
  }

  /** El borde final: `[\t ]*` opcional tras un salto o su marcador, al final. */
  private static trimTrailingOsuEdge(html: string): string {
    const n = html.length
    if (n === 0) return html
    const last = html.charCodeAt(n - 1)
    // Nada más puede terminar en un borde: letra, `)`, `"`… salen sin tocar.
    if (last !== 10 && last !== 13 && last !== 9 && last !== 32 && last !== 62 /* > */) return html
    let end = n
    while (end > 0) {
      const c = html.charCodeAt(end - 1)
      if (c === 32 || c === 9) end -= 1
      else break
    }
    if (end > 0 && html.charCodeAt(end - 1) === 10) {
      end -= 1
      if (end > 0 && html.charCodeAt(end - 1) === 13) end -= 1
    } else if (end > 0 && html.charCodeAt(end - 1) === 62 /* > */) {
      // Un marcador cierra con `</span>`, así que un cuerpo que no acaba en
      // eso no puede terminar en un borde — y la mayoría de los cuerpos acaba
      // en un `>` (`<br>`, `</a>`, `</strong>`). Buscar el `<span ` anterior
      // recorría el cuerpo entero en cada llamada, para casi siempre
      // encontrar un span que no era el marcador.
      if (!startsWithAt(html, '</span>', end - 7)) return html
      // El marcador mide siempre lo mismo (`<span data-bb-nl hidden…></span>`,
      // el `data-node-id` aparte), así que sólo puede empezar en los últimos
      // `MAX_MARKER` caracteres: buscarlo con `lastIndexOf` sobre el cuerpo
      // entero recorría todo el texto de un `<span>` final — el caso normal —
      // para encontrar la etiqueta que ya estaba al lado.
      const from = end > MAX_MARKER_LENGTH ? end - MAX_MARKER_LENGTH : 0
      let open = -1
      for (let i = end - 8; i >= from; i--) if (html.charCodeAt(i) === 60 /* < */) { open = i; break }
      if (open === -1 || HTMLRenderer.swallowedNewlineEnd(html, open) !== end) return html
      end = open
    } else {
      return html
    }
    return html.slice(0, end)
  }

  /** A swallowed newline's marker, with its node's id (see `SWALLOWED_NEWLINE_RE`). */
  private swallowedNewline(node: RedNode): string {
    return `<span ${SWALLOWED_NEWLINE_ATTR} hidden${this.idAttr(node)}></span>`
  }

  private paintsTerminalLine(node: RedNode): boolean {
    return this.options.terminalLines === true && isTerminalNewline(node, n => this.semantic.isNewlineSwallowed(n))
  }

  /** A flow's last newline with the line after it (see `terminalLines`): one element, as every newline is. */
  private terminalLine(node: RedNode): string {
    return `<span ${TERMINAL_LINE_ATTR}${this.idAttr(node)}><br><br></span>`
  }

  private idAttr(node: RedNode): string {
    if (this.noIds) return ''
    const mode = this.options.idMode ?? HTMLRenderer.idMode
    if (mode === 'none') return ''
    if (mode === 'all') return ` data-node-id="${node.id}"`
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
    'spacing', 'empty_line',
  ])

  // ─── Main Entry ─────────────────────────────────────────

  visit(node: RedNode): string {
    return this.renderNode(node)
  }

  /**
   * Ancho de cada tabla abierta, apilado igual que `tableDepth`.
   *
   * `getTableContext` corre una vez POR CELDA y recorría todas las filas de
   * la tabla en cada llamada, con un `.filter()` —y su array— por fila: una
   * tabla de 20×20 hacía 8.000 arrays intermedios por renderizado para
   * llegar 400 veces al mismo número. Ahora se calcula una vez al entrar en
   * la tabla. Va en una pila y no en un caché por nodo porque los hijos de un
   * `RedNode` SON mutables (`appendChild`/`removeChild`), así que la
   * identidad del nodo no garantiza que su estructura siga siendo la misma
   * entre renderizados.
   */
  private maxColsStack: number[] = []

  render(root: RedNode): string {
    this.maxColsStack.length = 0
    this.youtubeEmbeds = 0
    this.cutOpens.length = 0
    this.cutCloses.length = 0
    this.cutReopens.length = 0
    this.cutClosed = 0
    this.osuLinkContext = ''
    this.osuLinkForward = ''
    this.osuLinkSwallow = ''
    const snapshot = root.root.green
    let semantic = this.semanticBySnapshot.get(snapshot)
    if (semantic === undefined) {
      semantic = new OsuSemanticModel(this.options.dialect)
      this.semanticBySnapshot.set(snapshot, semantic)
    }
    this.semantic = semantic
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
    if (this.options.lineHandles === true && bearsLines(node) && (this.options.idMode ?? HTMLRenderer.idMode) !== 'none') {
      return this.renderLines(node)
    }
    return this.renderChildSequence(node, children, 0, children.length)
  }

  /**
   * Pinta `children[from, to)` con la vecindad de los autolinks de osu!.
   *
   * Un enlace automático puede tragarse los hermanos que vienen detrás (su
   * `parseLinks` corre sobre el texto con tags dentro). Esos enlaces se
   * planifican una vez por lista de hijos (`osuSpanningLinks`): el ancla se
   * abre en la hoja de la URL y se cierra al final de su target, también si el
   * target acaba en medio de otra hoja.
   */
  private renderChildSequence(
    parent: RedNode,
    children: readonly RedNode[],
    from: number,
    to: number,
    plan?: Map<number, OsuSpanLink> | null,
  ): string {
    const spans = plan === undefined
      ? (this.linkifiesOsuUrls ? HTMLRenderer.osuSpanningLinks(parent, children) : null)
      : plan
    let open: OsuSpanLink | null = null
    let out = ''
    let forwards: string[] | null = null
    const collapseRuns = this.collapseBlankRuns && spans === null && BLANK_RUN_PARENTS.has(parent.kind)
    for (let i = from; i < to; i++) {
      const child = children[i]
      if (collapseRuns && (child.kind === 'spacing' || child.kind === 'empty_line')) {
        // Una racha de saltos: el primero se pinta normal (cierra la línea
        // actual o abre la primera vacía) y los demás son un solo espaciador.
        // Los saltos que osu! se come no miden nada y se omiten: en un render
        // de sólo lectura nadie los necesita (en el editor son el marcador que
        // devuelve el salto al exportar).
        let end = i
        let firstVisible = -1
        let visible = 0
        while (end < to && (children[end].kind === 'spacing' || children[end].kind === 'empty_line')) {
          if (!this.semantic.isNewlineSwallowed(children[end])) {
            visible++
            if (firstVisible < 0) firstVisible = end
          }
          end++
        }
        if (visible > 1) {
          this.osuLinkForward = ''
          if (firstVisible >= 0) out += this.renderNode(children[firstVisible])
          out += `<div class="bb-blank-run" style="height:${visible - 1}lh"></div>`
          i = end - 1
          continue
        }
      }
      const span = spans?.get(i)
      if (open !== null && i === open.endsAt && open.endOffset !== undefined && span === undefined) {
        // El target acaba en medio de una hoja (una segunda URL detrás): el
        // cierre del ancla cae dentro de su texto, y lo de después se pinta
        // como una hoja normal.
        forwards ??= HTMLRenderer.osuForwardContexts(children)
        out += this.renderSpanEnd(child, open.endOffset, forwards[i])
        this.osuLinkForward = ''
        this.osuLinkContext = String(child.text ?? '').slice(-HTMLRenderer.OSU_LINK_CONTEXT_MAX)
        open = null
        continue
      }
      if (span !== undefined && !this.semantic.isClaimedByBoxTitle(child) && !this.semantic.isOrphanBoxCloseText(child)) {
        // Dos targets de la misma línea no pueden solaparse, pero uno puede
        // cerrarse y otro abrirse en el mismo hijo: se cierra el que hubiera.
        if (open !== null) {
          out += '</a>'
          open = null
        }
        this.osuLinkForward = ''
        out += this.renderSpanStart(child, span.offset, span.href)
        // El ancla cubre el resto del target: lo de fuera ya no es vecindad
        // de ningún texto que venga detrás.
        this.osuLinkContext = ''
        open = span
      } else {
        // La otra mitad de la vecindad (ver `osuLinkForward`): la cola que el
        // texto de osu! ve DETRÁS de esta hoja. Se calcula una vez por padre.
        if (child.kind === 'text' && child.children.length === 0 && this.linkifiesOsuUrls) {
          forwards ??= HTMLRenderer.osuForwardContexts(children)
          this.osuLinkForward = forwards[i]
        } else {
          this.osuLinkForward = ''
        }
        out += this.renderNode(child)
      }
      if (open !== null && i === open.endsAt) {
        out += '</a>'
        open = null
      }
    }
    // Red de seguridad: un plan que no cerró no debe dejar markup suelto.
    if (open !== null) out += '</a>'
    return out
  }

  /**
   * The children of a container that has lines (`Semantic/lines.ts`), each
   * line wrapped in `<span class="bb-line" data-node-id="line:…">`.
   *
   * The wrapper is what a caret or a click inside a box resolves to. Text
   * leaves have no element of their own, so without it the nearest element
   * with an id was the whole box: selecting a line of text selected the box.
   * It is a handle for the preview, so it is only emitted when asked for
   * (`lineHandles`) and where ids are: every other render is unchanged.
   *
   * A line whose HTML is only spaces is left bare. There is nothing in it to
   * highlight, and osu!'s edge trimming (`trimOsuEdges`) matches spaces and a
   * newline as one run at a box's edge — wrapping the spaces would split it.
   */
  private renderLines(node: RedNode): string {
    const children = node.children
    this.osuLinkContext = ''
    // El plan se calcula una vez para toda la lista: sus índices son globales a
    // los hijos, no a la línea, y un target nunca cruza un bloque.
    const spans = this.linkifiesOsuUrls ? HTMLRenderer.osuSpanningLinks(node, children) : null
    let out = ''
    let i = 0
    while (i < children.length) {
      if (breaksLine(children[i].kind)) {
        this.osuLinkForward = ''
        out += this.renderNode(children[i])
        i++
        continue
      }
      const first = children[i]
      let j = i
      while (j < children.length && !breaksLine(children[j].kind)) j++
      const line = this.renderChildSequence(node, children, i, j, spans)
      out += BLANK_LINE_RE.test(line) ? line : `<span class="bb-line" data-node-id="${LINE_ID_PREFIX}${first.id}">${line}</span>`
      i = j
    }
    return out
  }

  // ─── Node Rendering ─────────────────────────────────────

  /**
   * Un bloque bajo osu! parte el HTML que lo envuelve (ver `renderCutBlock`),
   * así que pasa por ahí antes de pintarse.
   */
  private renderNode(node: RedNode): string {
    // La vecindad de un enlace es la del TEXTO PLANO: `BBCodeForDB::parseLinks`
    // corre al guardar sobre el texto entero con sus tags y sus saltos dentro,
    // así que cada nodo deja tras de sí lo que su parte aporta a esa cadena —
    // la cola de una hoja de texto, o el salto de un `spacing`. El contexto se
    // le pasa a la hoja siguiente para que su URL vea lo mismo que vio osu!.
    const leaf = node.children.length === 0 && node.kind === 'text'
    const context = leaf ? this.osuLinkContext : ''
    // La vecindad también mira hacia delante: el target de una URL corre por el
    // texto de osu! hasta un espacio, y ese texto puede continuar en las hojas
    // hermanas (`…[/url` sin cerrar acaba dentro del href). El padre la deja
    // calculada en `osuLinkForward`; aquí se consume, para que no la herede
    // nadie más.
    const forward = leaf ? this.osuLinkForward : ''
    this.osuLinkForward = ''
    // Un elemento corta la vecindad en los dos sentidos: lo que venga dentro no
    // ve lo de fuera (su tag la separa) y lo de después no ve lo de dentro. Un
    // `paragraph` no es un elemento —es una línea que el parser agrupa, sin tag
    // en el texto— así que la vecindad lo atraviesa (`Semantic/lines.ts`).
    const transparent = HTMLRenderer.OSU_LINK_TRANSPARENT_KINDS.has(node.kind)
    if (!transparent) this.osuLinkContext = ''
    const html = this.cutOpens.length > 0 && this.cutsOsuBlock(node)
      ? this.renderCutBlock(node)
      : this.renderNodeInner(node, context, forward)
    if (leaf) {
      this.osuLinkContext = this.linkifiesOsuUrls && !this.semantic.isClaimedByBoxTitle(node)
        ? String(node.text ?? '').slice(-HTMLRenderer.OSU_LINK_CONTEXT_MAX)
        : ''
    } else if (HTMLRenderer.OSU_LINK_NEWLINE_KINDS.has(node.kind)) {
      this.osuLinkContext = '\n'
    } else if (!transparent) {
      this.osuLinkContext = ''
    }
    return html
  }

  /**
   * ¿Este nodo parte el inline que lo envuelve, como un bloque de osu!?
   *
   * Un `list_item` sólo si pertenece a una lista. `parseList` escribe `<li>`
   * para TODO `[*]`, pero HTMLPurifier desenvuelve el que no tiene
   * `<ul>`/`<ol>` alrededor: un `[*]` suelto no es un bloque y no corta el
   * `<span>` que lo envuelve. Medido con el harness: `[size=150]\n[*]x[/size]`
   * publica `x` al 150% y `[size=150]a\n[*]b[/size]` deja `ab` en el MISMO
   * span; el preview cortaba en el `list_item` y, como `[size]`/`[color]` no se
   * reabren, perdía el formato (osu/4991464, osu/19778889). `renderListItem`
   * ya pinta ese ítem como texto corrido (`nearestListAncestor`); el corte era
   * la única parte que lo seguía tratando como bloque.
   */
  private cutsOsuBlock(node: RedNode): boolean {
    if (!HTMLRenderer.OSU_BLOCK_KINDS.has(node.kind)) return false
    if (node.kind !== 'list_item') return true
    return this.hasListAncestor(node)
  }

  private renderNodeInner(node: RedNode, context = '', forward = ''): string {
    // An element whose closer a box title claimed (see `isClaimedByBoxTitle`):
    // osu! swallowed its opener as plain text, so it shows as written, its
    // content unwrapped, its closer gone.
    if (node.green.trailingWidth > 0 && node.green.leadingWidth > 0 && this.semantic.isClaimedElement(node)) {
      const tag = this.semantic.claimedTagOf(node) ?? node.kind
      return this.escapeHtml(`[${tag}${node.text}]`) + this.renderChildren(node)
    }
    // Leaf nodes
    if (node.children.length === 0 && node.kind === 'text') {
      if (this.semantic.isClaimedByBoxTitle(node) || this.semantic.isOrphanBoxCloseText(node)) return ''
      let rawText = node.text
      // La URL de la hoja anterior puede haberse tragado el principio de esta
      // (`https://…[/url` sin cerrar): esos caracteres ya salieron dentro del
      // ancla, así que aquí se descuentan.
      if (this.osuLinkSwallow !== '') {
        const swallowed = this.osuLinkSwallow
        const taken = HTMLRenderer.swallowedPrefixLength(rawText, swallowed)
        // `taken === rawText.length < swallowed.length`: el prefijo continúa en
        // la hoja siguiente. Si sobra texto, se agotó aquí (o no coincidía, que
        // no debería pasar): no se arrastra más.
        this.osuLinkSwallow = taken === rawText.length && taken < swallowed.length ? swallowed.slice(taken) : ''
        rawText = rawText.slice(taken)
        if (rawText === '') return ''
      }
      // El `indexOf` va delante: casi ningún texto lleva un `$`, y así ni se
      // arranca el motor de expresiones regulares. El patrón es de módulo
      // porque este es el nodo más frecuente del documento y un literal aquí
      // dentro construía un `RegExp` por hoja, en cada renderizado.
      if (this.tokenResolver !== undefined && rawText.indexOf('$') !== -1) {
        const resolve = this.tokenResolver
        rawText = rawText.replace(TOKEN_REF_RE, (match, name: string) => {
          const resolved = resolve(name) ?? resolve(match)
          return resolved !== undefined ? resolved : match
        })
      }
      return this.wrapTextLeaf(node, this.renderTextLeafInner(rawText, context, forward, true))
    }

    // Document root
    if (node.kind === 'document') {
      return this.renderChildren(node)
    }

    // Dispatch by kind
    switch (node.kind) {
      // Los cuatro salen por `wrapOsuFormatting`: osu! los reabre dentro de un
      // bloque, así que no son un envoltorio inline cualquiera (ver ahí).
      case 'bold': return this.wrapOsuFormatting('strong', node)
      case 'italic': return this.wrapOsuFormatting('em', node)
      case 'underline': return this.wrapOsuFormatting('u', node)
      case 'strikethrough': return this.wrapOsuFormatting('s', node)
      // `[c]` is `<code>` in osu!, an inline FORMAT under HTMLPurifier: it is
      // closed before a block and re-opened inside and after it (measured:
      // `[c][imagemap]⏎…⏎[/imagemap][/c]` publishes `<code></code><div
      // class="imagemap">…<code>…</code></div><code></code>`). No `class`:
      // osu! writes none.
      case 'inline_code': return this.isOsu()
        ? this.wrapOsuFormatting('code', node)
        : this.wrapInline('code', node, 'class="inline"')
      case 'spoiler': return this.isOsu()
        ? this.wrapOsuInlineSpan(node, 'class="spoiler"')
        : this.wrapInline('span', node, 'class="spoiler"')
      case 'color': return this.renderColor(node)
      case 'font_size': return this.isOsu()
        ? this.wrapOsuInlineSpan(node, this.fontSizeStyle(node))
        : this.wrapInline('span', node, this.fontSizeStyle(node))
      case 'font': return this.isOsu()
        ? this.wrapOsuInlineSpan(node, this.fontStyle(node))
        : this.wrapInline('span', node, this.fontStyle(node))
      case 'url': return this.renderLink(node, 'url')
      case 'email': return this.renderLink(node, 'email')
      case 'profile': return this.renderProfile(node)
      case 'image': return this.renderImage(node)
      case 'video': return this.renderVideo(node)
      case 'audio': return this.renderAudio(node)
      case 'center': return this.renderAlignAs(node, 'center')
      case 'right': return this.renderAlignAs(node, 'right')
      case 'left': return this.renderAlignAs(node, 'left')
      // Sigue siendo siempre `h2`, como antes: el nivel de BBCode no mapea al
      // de HTML y un `[heading=9]` daría un `<h9>` inválido. `data-bare-level`
      // sólo anota que el 2 lo puso el renderer, para que el camino de vuelta
      // no escriba `[heading=2]` donde el autor había puesto `[heading]`.
      // Bajo osu! el `<h2>` no puede llevar un bloque dentro (HTMLPurifier lo
      // cierra al llegar al `<div>`), así que se corta igual que un `<span>`.
      case 'heading': return this.isOsu()
        ? this.wrapOsuSplittingBlocks(
          'h2',
          node,
          node.metadata?.level === undefined ? 'data-bare-level="1"' : '',
        )
        : this.wrapBlock(
          'h2',
          node,
          node.metadata?.level === undefined ? 'data-bare-level="1"' : '',
        )
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
      // These three had no case at all, so `[rainbow]Hi[/rainbow]` previewed
      // as bare text while its export was a full colour sweep.
      case 'rainbow': return this.renderEffectSegments(node, 'rainbow')
      case 'grow': return this.renderEffectSegments(node, 'grow')
      case 'sinewave': return this.renderEffectSegments(node, 'sinewave')
      case 'paint': return this.renderEffectSegments(node, 'paint')
      case 'spacing':
        if (this.semantic.isNewlineSwallowed(node)) return this.swallowedNewline(node)
        if (this.paintsTerminalLine(node)) return this.terminalLine(node)
        return `<br${this.idAttr(node)}>`
      case 'empty_line':
        if (this.semantic.isNewlineSwallowed(node)) return this.swallowedNewline(node)
        if (this.paintsTerminalLine(node)) return this.terminalLine(node)
        // A run of newlines whose HEAD was eaten starts its visible part on a
        // line nothing closed yet: osu! leaves a bare `<br />` there, not the
        // empty line the div draws (`a[/box]\n\nb` → `a<br />b`). The div stays
        // for the ordinary case, where the newline before this one survived
        // and already ended the line.
        if (this.semantic.isBareLineBreak(node)) return `<br${this.idAttr(node)}>`
        return `<div class="bb-empty-line"${this.idAttr(node)}><br></div>`
      case 'group': return this.wrapInline('span', node, 'class="group"')
      // Un párrafo no tiene etiqueta propia en BBCode, pero sí necesita un
      // elemento: sin él, la prosa suelta entre bloques no es clicable —
      // `closest('[data-node-id]')` no encuentra nada y el clic se pierde.
      // Un `span` es inline, así que no altera el flujo del texto.
      case 'paragraph': return this.wrapInline('span', node, 'class="bb-paragraph"')
      case 'error': return this.renderError(node)
      // osu! no muestra un cierre que no cerró nada; el nodo existe solo para
      // que su rango siga perteneciendo a alguien.
      case 'discarded_tag': return ''
      // Un `[/box]`/`[/spoilerbox]` huérfano bajo `pairing: 'osu'` — osu!
      // sella todo cierre de esta familia incondicionalmente y su renderer
      // no muestra nada por él (ver `NEWLINE_RULES` para el presupuesto de
      // saltos que se come alrededor, igual que un cierre emparejado).
      case 'discarded_box_close': return ''
      // Contenido de un `box`/`spoilerbox` cruzado bajo `pairing: 'osu'` que
      // cayó DESPUÉS de que un cierre ajeno le cerrara el div del cuerpo
      // (`Types/core.ts`). `renderOsuSpoilerbox`/`renderBox`/`renderSpoilerbox`
      // ya lo extraen y lo colocan a mano en su sitio; este caso es solo la
      // red de seguridad para cualquier otro visitante genérico del árbol —
      // transparente, sin envoltorio propio.
      case 'box_tail': return this.renderChildren(node)
      // El `<div>` que un tag de bloque escrito en el TÍTULO de una caja abrió
      // ahí dentro (`Types/core.ts`). En osu! el cuerpo de la caja cae DENTRO
      // de él, así que `renderOsuSpoilerbox` pinta la cadena entera a mano;
      // este caso es el que cubre cualquier otro dialecto (y a este mismo si
      // se renderiza suelto).
      case 'title_div': return this.renderTitleDiv(node)
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
              // The child rendered by the engine, as a node `RenderTree`
              // passes through unescaped — it used to answer 'unsupported'.
              renderChild: (n) => engineHTML(this.renderNode(n)),
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

  /**
   * El HTML del texto de una hoja: tokens, menciones, escape y —si toca— el
   * autolink de osu!.
   *
   * Se separa del nodo para poder pintar una hoja en dos tramos cuando un
   * enlace automático empieza en medio de ella (ver `osuSpanningLinks`): el
   * tramo de delante se pinta normal y el de detrás entra ya dentro del ancla,
   * sin volver a linkificarse.
   */
  private renderTextLeafInner(rawText: string, context: string, forward: string, autolink: boolean): string {
    // El `indexOf` va delante: casi ningún texto lleva un `$`, y así ni se
    // arranca el motor de expresiones regulares. El patrón es de módulo
    // porque este es el nodo más frecuente del documento y un literal aquí
    // dentro construía un `RegExp` por hoja, en cada renderizado.
    if (this.tokenResolver !== undefined && rawText.indexOf('$') !== -1) {
      const resolve = this.tokenResolver
      rawText = rawText.replace(TOKEN_REF_RE, (match, name: string) => {
        const resolved = resolve(name) ?? resolve(match)
        return resolved !== undefined ? resolved : match
      })
    }
    let out = this.mentionResolver || this.options.timestampResolver
      ? this.linkifyText(rawText)
      : this.escapeHtml(rawText)
    // osu! linkifica las URLs sueltas del texto (`BBCodeForDB::parseLinks`),
    // así que una página con `https://…` escrito a mano se ve allí como
    // enlace y aquí como texto plano. El render de otros dialectos no lo
    // hace: su contenido no pasó nunca por esa pasada.
    if (autolink && this.linkifiesOsuUrls) {
      const linked = HTMLRenderer.linkifyOsuUrls(out, this.escapeHtml(context), this.escapeHtml(forward))
      out = linked.html
      if (linked.swallow > 0) this.osuLinkSwallow = HTMLRenderer.rawEscapePrefix(forward, linked.swallow)
    }
    // `BBCodeFromDB::toHTML()` termina en `str_replace("\n", '<br />')`, justo
    // antes de HTMLPurifier: un salto que sobreviva dentro de texto literal
    // —la etiqueta desconocida `[a⏎b]`, que el parser conserva como UNA hoja—
    // se publica como un salto real, no como el espacio en que el navegador
    // colapsa un `\n` crudo. Los saltos normales no pasan por aquí: son nodos
    // `spacing`/`empty_line` y ya emiten su `<br>`.
    if (this.isOsu() && (out.indexOf('\n') !== -1 || out.indexOf('\r') !== -1)) {
      out = out.replace(/\r\n|\r|\n/g, '<br>')
    }
    return out
  }

  /** El estilo del nodo (`color`, `font-size`, …) alrededor del texto de una hoja. */
  private wrapTextLeaf(node: RedNode, out: string): string {
    const style = node.metadata?.style as Record<string, string> | undefined
    if (style) {
      const inlineStyles = []
      const color = style.color && sanitizeColor(style.color, this.tokenResolver)
      // Clamp first: osu! clamps the digits itself, so a `[size=100000]`
      // must reach the sanitizer as `200` and not be refused for being long.
      const capped = style.fontSize && clampFontSizeForRender(style.fontSize, this.options.dialect)
      const rawFontSize = capped && sanitizeFontSize(capped, this.tokenResolver)
      const fontSize = rawFontSize && clampFontSizeForRender(rawFontSize, this.options.dialect)
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

  /**
   * El primer tramo de una hoja que abre un enlace que continúa en los
   * hermanos siguientes: el texto de delante, el `<a>` abierto y el resto de
   * la hoja (que ya es contenido del ancla).
   */
  private renderSpanStart(node: RedNode, offset: number, href: string | null): string {
    const raw = String(node.text ?? '')
    const open = href === null ? '<a rel="nofollow">' : `<a href="${href}" rel="nofollow">`
    const inner = this.renderTextLeafInner(raw.slice(0, offset), this.osuLinkContext, '', true)
      + open
      + this.renderTextLeafInner(raw.slice(offset), '', '', false)
    return this.wrapTextLeaf(node, inner)
  }

  /**
   * El último tramo del target, cuando acaba en medio de una hoja: el texto
   * que queda dentro del ancla, el cierre y el resto de la hoja, ya fuera.
   */
  private renderSpanEnd(node: RedNode, endOffset: number, forward: string): string {
    const raw = String(node.text ?? '')
    const head = raw.slice(0, endOffset)
    const tail = raw.slice(endOffset)
    const inner = this.renderTextLeafInner(head, this.osuLinkContext, '', false)
      + '</a>'
      + this.renderTextLeafInner(tail, head.slice(-HTMLRenderer.OSU_LINK_CONTEXT_MAX), forward, true)
    return this.wrapTextLeaf(node, inner)
  }

  // ─── Render Helpers ─────────────────────────────────────

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

  /**
   * Un `<span>` de osu! alrededor de su contenido, cortado en cada bloque.
   *
   * osu! publica su HTML a través de HTMLPurifier, que no admite un inline
   * envolviendo un bloque: cierra el `<span>` justo antes del `<div>`/`<h2>` y
   * NO lo reabre después. El resultado visible es que un `[size=150]` que
   * envuelve un `[box]` no agranda nada de dentro del box, ni el texto que
   * sigue. Sin el corte, el estilo se filtraba a todo el bloque.
   *
   * El bloque puede estar a cualquier profundidad, no sólo entre los hijos
   * directos: `[size=150][b][heading]x[/heading][/b][/size]` corta el span con
   * el `<strong>` por medio, y por eso el corte no se decide aquí sino en
   * {@link renderCutBlock}, que es quien ve llegar el bloque.
   */
  private wrapOsuInlineSpan(node: RedNode, extra: string = ''): string {
    return this.wrapOsuSplittingBlocks('span', node, extra)
  }

  /**
   * Un elemento de osu! que sólo admite contenido inline (`<span>`, `<h2>`),
   * cortado en cada bloque que aparezca dentro (ver `wrapOsuInlineSpan`).
   */
  private wrapOsuSplittingBlocks(tag: string, node: RedNode, extra: string = ''): string {
    const open = `<${tag}${this.idAttr(node)}${extra ? ` ${extra}` : ''}>`
    const depth = this.cutOpens.length
    this.cutOpens.push(open)
    this.cutCloses.push(CUT_CLOSE[tag])
    this.cutReopens.push(0)
    const content = this.renderChildren(node)
    // Si un bloque cerró este elemento por dentro, su cierre ya se emitió: el
    // que queda al final cerraría otra cosa (el span de al lado, el párrafo).
    const closed = depth < this.cutClosed
    this.cutOpens.length = depth
    this.cutCloses.length = depth
    this.cutReopens.length = depth
    if (this.cutClosed > depth) this.cutClosed = depth
    return closed ? `${open}${content}` : `${open}${content}${CUT_CLOSE[tag]}`
  }

  /**
   * Un elemento de FORMATO de osu! (`<strong>`, `<em>`, `<u>`, `<s>`).
   *
   * A diferencia de un `<span>`, HTMLPurifier sí lo reabre dentro del bloque
   * —medido: `[b][box=t]y[/box]post[/b]` deja el cuerpo del box y `post` en
   * negrita, mientras el `[size]` de al lado no pinta nada de eso—, así que
   * participa en el corte al revés: se cierra antes del bloque y se vuelve a
   * abrir dentro (y después). Para eso tiene que estar en `cutOpen` aunque no
   * lo corte nada todavía: el bloque puede llegar más abajo.
   */
  private wrapOsuFormatting(tag: string, node: RedNode): string {
    if (!this.isOsu()) return this.wrapInline(tag, node)
    const open = `<${tag}${this.idAttr(node)}>`
    const depth = this.cutOpens.length
    this.cutOpens.push(open)
    this.cutCloses.push(CUT_CLOSE[tag])
    this.cutReopens.push(1)
    const content = this.renderChildren(node)
    this.cutOpens.length = depth
    this.cutCloses.length = depth
    this.cutReopens.length = depth
    if (this.cutClosed > depth) this.cutClosed = depth
    return `${open}${content}${CUT_CLOSE[tag]}`
  }

  /**
   * Un bloque bajo osu!: cierra de golpe todo lo inline que lo envuelve.
   *
   * Es el corte que hace HTMLPurifier al publicar, y tiene dos mitades. Los
   * `<span>`/`<h2>` se cierran antes del bloque y NO vuelven (su cierre queda
   * emitido: el envoltorio no lo repite al final). Los de formato se cierran
   * también —un inline abierto no puede quedarse cruzando un bloque— pero se
   * REABREN dentro del bloque y otra vez tras él, que es lo que deja el
   * formato del autor aplicando al contenido de dentro sin que el span de
   * fuera se cuele.
   *
   * Sólo se llega aquí con algo inline abierto (`cutOpen`): un bloque suelto,
   * sin nada que lo envuelva, se pinta tal cual.
   */
  private renderCutBlock(node: RedNode): string {
    const n = this.cutOpens.length
    let closers = ''
    // `cutClosed` marca hasta dónde llegó un corte anterior: los envoltorios
    // que NO se reabren (`<span>`, `<h2>`) por debajo de esa marca ya emitieron
    // su cierre y no se cierran otra vez; repetirlo dejaba `</h2>` sueltos en
    // un `[heading]` anidado (`osu/20778568`). Los de formato sí se cierran
    // siempre: el corte anterior los reabrió alrededor de su bloque.
    for (let i = n - 1; i >= 0; i--) {
      if (i < this.cutClosed && this.cutReopens[i] === 0) continue
      closers += this.cutCloses[i]
    }
    // Los que no reabren quedan cerrados para siempre; a los de formato no les
    // afecta, porque vuelven a abrirse aquí mismo.
    this.cutClosed = n
    let reopens = ''
    let reopensClose = ''
    for (let i = 0; i < n; i++) {
      if (this.cutReopens[i] === 0) continue
      reopens += this.cutOpens[i]
      reopensClose = this.cutCloses[i] + reopensClose
    }
    return closers + reopens + this.renderNodeInner(node) + reopensClose + reopens
  }

  /**
   * Los `kind` cuyo HTML de osu! es un elemento de bloque — los que hacen que
   * HTMLPurifier corte un inline (ver `wrapOsuInlineSpan`).
   *
   * `imagemap` entra porque osu! lo pinta como `<div class="imagemap">`; una
   * imagen suelta (`image`, `<img>`) no, que es inline.
   */
  private static readonly OSU_BLOCK_KINDS: ReadonlySet<string> = new Set([
    'box', 'boxw', 'spoilerbox', 'notice', 'wnotice', 'quote', 'heading', 'code',
    'list', 'list_item', 'center', 'right', 'left', 'imagemap',
  ])

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

  /** Characters `escapeHtml` has to rewrite. Non-global on purpose: `test` must not carry `lastIndex`. */
  private static readonly HTML_ESCAPE_RE = /[&<>"']/

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

  /** Keyword-or-number CSS values (font-weight, font-style, text-decoration). */
  private isCssKeyword(raw: string | undefined): boolean {
    return !!raw && /^[a-z]{2,20}(?: [a-z]{2,20})?$|^[1-9]00$/i.test(raw.trim())
  }

  /** Read a metadata field, falling back to the raw tag attribute. */

  /**
   * Lo único que osu! acepta en `[color=…]`.
   *
   * Su `BBCodeForDB::parseColour` sella el tag con un uid sólo si el valor
   * matchea `#[[:xdigit:]]{6}` o `[[:alpha:]]+` — nada más. No valida que el
   * nombre sea un color CSS de verdad (`banana` pasa), pero `#fff`, `#ffffffff`,
   * `rgb(...)`, `$token` o un hex sin `#` no pasan. Sin uid, la segunda pasada
   * no ve el tag y el opener *y* el closer quedan como texto en la página.
   */
  private static readonly OSU_COLOR_RE = /^(?:#[0-9a-fA-F]{6}|[a-zA-Z]+)$/

  /**
   * `[color]` con el vocabulario de cada dialecto.
   *
   * Miliastry (y Lyne) aceptan a propósito más que osu: `#RGB`, `#RGBA`, un
   * `$token` de diseño, nombres propios. Bajo `dialect: 'osu'` eso es una
   * mentira: el editor pintaría color donde la página publicada muestra el
   * BBCode crudo. Así que replicamos lo que hace osu — literal el opener,
   * literal el closer, y los hijos renderizados normalmente en el medio.
   *
   * El chequeo mira el texto crudo del atributo, no el valor saneado: osu
   * matchea sobre la fuente, así que `[color="#ffffff"]` (con comillas) también
   * se le escapa.
   */
  private renderColor(node: RedNode): string {
    if (this.options.dialect === 'osu') {
      const text = node.text || ''
      const eq = text.indexOf('=')
      // Sin `=` en el texto el nodo no vino del parser de BBCode (import de
      // HTML, por ejemplo): ahí el único valor disponible es el de metadata.
      const raw = eq >= 0 ? text.slice(eq + 1) : (text ? '' : nodeAttrValue(node, 'color'))
      const candidate = (raw.startsWith('$') && this.tokenResolver)
        ? resolveTokenValue(raw, this.tokenResolver)
        : raw
      if (!HTMLRenderer.OSU_COLOR_RE.test(candidate)) {
        const opener = eq >= 0 ? `[color${text}]` : `[${text || 'color'}]`
        return this.escapeHtml(opener) + this.renderChildren(node) + this.escapeHtml('[/color]')
      }
    }
    return this.isOsu()
      ? this.wrapOsuInlineSpan(node, this.colorStyle(node))
      : this.wrapInline('span', node, this.colorStyle(node))
  }

  private colorStyle(node: RedNode): string {
    // Bajo osu! manda HTMLPurifier, no `sanitizeColor`: un nombre que no está
    // en su tabla deja el `<span>` SIN `style` (`[color=rose]`), y `abc`/
    // `abcdef` se publican como `#abc`/`#abcdef`. Un `$token` se resuelve
    // antes, como en `renderColor`.
    const raw = nodeAttrValue(node, 'color')
    const color = this.options.dialect === 'osu'
      ? osuCssColor(resolveTokenValue(raw, this.tokenResolver))
      : sanitizeColor(raw, this.tokenResolver)
    return color ? `style="color:${color};"` : ''
  }

  private fontSizeStyle(node: RedNode): string {
    // Clamped per dialect BEFORE sanitizing (see `FontSizeLimits`): osu! prints
    // 200 % for `[size=100000]`, and the sanitizer's 4-digit bound would rather
    // drop it than show a size the published page does have.
    const capped = clampFontSizeForRender(nodeAttrValue(node, 'size'), this.options.dialect)
    const size = sanitizeFontSize(capped, this.tokenResolver)
    return size ? `style="font-size:${clampFontSizeForRender(size, this.options.dialect)}%;"` : ''
  }

  private fontStyle(node: RedNode): string {
    const font = sanitizeFontFamily(nodeAttrValue(node, 'font'), this.tokenResolver)
    return font ? `style="font-family:${font};"` : ''
  }

  private renderLink(node: RedNode, kind: string): string {
    let href = String(node.metadata?.href ?? '') || nodeAttrValue(node)
    // Un `[email]a@b.com[/email]` llega con href exactamente `mailto:` y la
    // dirección en el hijo de texto. Sin completarlo aquí el href quedaba
    // vacío y el round-trip devolvía `[url=mailto:]a@b.com[/url]`.
    if (kind === 'email' && href === 'mailto:') {
      href += node.children.map(c => c.text || '').join('')
    }
    // Ensure the URL has a protocol for external links.
    //
    // Under osu! nothing is added: el `[url=ftp://x]` publica `href="ftp://x"`
    // tal cual (el purificador admite ftp), y el prefijo lo convertía en
    // `https://ftp//x` (`.cache/url-close`, C14). Los dialectos propios sí
    // necesitan el esquema para que el enlace sea clicable.
    if (!this.isOsu() && href && !href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('mailto:')) {
      href = 'https://' + href
    }
    // osu! ends `[url=…]`'s address at its first `]` (`BBCodeForDB::parseUrl`,
    // a lazy `.+?\]`): a Markdown link pasted into it — `[x](y)` — becomes a
    // dead link with the rest of the address printed before the text. The osu!
    // preview shows exactly that, instead of a link that only works here. The
    // leaked text is decoration (no leaf of its own): the reconciler keeps it
    // out of the source.
    let leaked = ''
    const cut = kind === 'url' && this.isOsu() ? href.indexOf(']') : -1
    if (cut >= 0) {
      leaked = `<span class="bb-osu-leaked-href">${this.escapeHtml(href.slice(cut + 1))}]</span>`
      href = href.slice(0, cut)
    }
    // Linkificar la URL que hace de texto del enlace la anidaría en dos `<a>`.
    // Bajo osu! eso es justo lo que pasa — pero sólo en `[url=DIRECCIÓN]…`: el
    // contenido de un `[url]DIRECCIÓN[/url]` sin atributo lo ESCRIBE el paso de
    // guardado con `extraEscapes` (`https&#58;//…`), así que su texto ya no es
    // una URL y `parseLinks` no enlaza nada dentro. Medido con `for-db`. Y el
    // purificador lo resuelve cerrando esta ancla en la primera ancla interna:
    // lo anterior se queda dentro y el resto se publica fuera.
    const hasHrefAttribute = String(node.text ?? '').startsWith('=')
    const wasOff = this.linkifySuppressed
    if (!this.isOsu() || !hasHrefAttribute) this.linkifySuppressed = true
    let inner: string
    try {
      inner = this.renderChildren(node)
    } finally {
      this.linkifySuppressed = wasOff
    }
    // Bajo osu! un enlace sin contenido publica `<a href=…></a>` vacío: el
    // texto que el preview ponía de relleno (la propia dirección) es una
    // invención del editor. Medido en `osu/8525223`: el `[/centre]` cruza un
    // `[url=…]` y el árbol lo cierra vacío; osu! publica el ancla sin texto.
    let content = leaked + (inner || (this.isOsu() ? '' : href))
    // El purificador no admite anclas anidadas, y lo que hace con la de dentro
    // depende de dónde caiga. `<a ` y no `<a`: un `<audio>` del contenido no
    // es un ancla. Medido con el harness:
    //   `[url=A]https://B[/url]` → el ancla interna sale FUERA y se ve;
    //   `[url=A][b]https://B tail[/b][/url]` → la interna DESAPARECE con su
    //   texto (`<strong> tail</strong>` dentro de la de fuera).
    let afterLink = ''
    if (this.isOsu()) {
      const at = HTMLRenderer.ANCHOR_AT.exec(content)?.index ?? -1
      if (at !== -1) {
        if (HTMLRenderer.tagIsNestedAt(content, at)) {
          // Dentro de un `<strong>`/`<span>` el ancla interna se va entera
          // (elemento y texto); los hermanos del envoltorio quedan.
          content = content.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, '')
        } else {
          afterLink = content.slice(at)
          content = content.slice(0, at)
        }
      }
    }
    // osu! publica el href que deja su purificador, no el que se escribió: sin
    // esto cada URL con espacio, acento o comilla diverge.
    const published = this.isOsu() ? osuPurifiedHref(href) : href
    const h = published ? ` href="${this.escapeHtml(published)}"` : ''    
    const hasMediaChild = node.children.some(c => c.kind === 'image' || c.kind === 'svg' || c.kind === 'video')
    const imgCls = hasMediaChild ? ' class="bb-link-img"' : ''
    return `<a${this.idAttr(node)}${imgCls}${h} target="_blank" rel="noopener">${content}</a>${afterLink}`
  }

  private renderProfile(node: RedNode): string {
    return this.renderEntity(node, 'profile')
  }

  private renderEntity(node: RedNode, type: 'profile' | 'guild' | 'map'): string {
    const key = type === 'profile' ? 'username' : type === 'guild' ? 'tag' : 'id'
    const val = String(node.metadata?.[key] ?? '') || nodeAttrValue(node)
    const content = this.renderChildren(node) || val
    // El converter HTML→BBCode ve `<strong><a>`, no la etiqueta original. Sin
    // esta marca `[profile]peppy[/profile]` volvía como `[b][url=...]…[/url][/b]`,
    // y sin el valor `[profile=5458323]` perdía el id y volvía como `[profile]`.
    const entity = ` data-entity="${type}"` +
      (val ? ` data-entity-value="${this.escapeHtml(val)}"` : '')
    if (this.options.entityLinkResolver) {
      const link = this.options.entityLinkResolver(type, val || content)
      if (link) {
        const ext = link.external ? ' target="_blank" rel="noopener noreferrer"' : ''
        return `<strong${entity}><a${this.idAttr(node)} href="${this.escapeHtml(link.href)}"${ext}>${content}</a></strong>`
      }
    }
    if (type === 'profile' && this.isOsu()) {
      // Sacado de los fixtures `basic_profile*` de osu-web, no adivinado: el
      // enlace es un `<a>` pelado (nada de `<strong>`), y `data-user-id` lleva
      // el id numérico cuando `[profile=N]` lo trae y `@` + el texto crudo
      // cuando no. El href es ese mismo valor, URL-encoded.
      const key = val || `@${this.collectNodeText(node)}`
      const href = osuPurifiedHref(`https://osu.ppy.sh/users/${encodeURIComponent(key)}`)
      return `<a${this.idAttr(node)}${entity} class="user-name js-usercard" data-user-id="${this.escapeHtml(key)}"${href ? ` href="${href}"` : ''}>${content}</a>`
    }
    if (type === 'profile') {
      const url = this.options.theme === 'lyne' || this.options.dialect === 'lyne'
        ? `/u/${encodeURIComponent(val || content)}`
        : `https://osu.ppy.sh/users/${this.escapeHtml(val || content)}`
      return `<strong${entity}><a${this.idAttr(node)} href="${url}" target="_blank" rel="noopener">${content}</a></strong>`
    }
    if (type === 'guild') {
      return `<strong${entity}><a${this.idAttr(node)} href="/guilds/${encodeURIComponent(val || content)}">${content}</a></strong>`
    }
    if (type === 'map') {
      return `<strong${entity}><a${this.idAttr(node)} href="/maps/${encodeURIComponent(val || content)}">${content}</a></strong>`
    }
    return `<strong${entity}><a${this.idAttr(node)} href="#">${content}</a></strong>`
  }

  /** Etiquetas sin cierre que el escáner de anidamiento no apila. */
  private static readonly VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'source', 'wbr'])

  /**
   * ¿La etiqueta que empieza en `at` está dentro de otro ELEMENTO del HTML?
   *
   * Recorre sólo los tags anteriores. Se usa para el ancla interna de un
   * `[url=…]`: a nivel del contenido de fuera HTMLPurifier la saca (se ve);
   * envuelta en un formato, la borra con su texto (medido, ver `renderLink`).
   */
  private static tagIsNestedAt(html: string, at: number): boolean {
    const stack: string[] = []
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && m.index < at) {
      const name = m[2].toLowerCase()
      if (m[1] === '/') {
        const i = stack.lastIndexOf(name)
        if (i !== -1) stack.length = i
      } else if (!HTMLRenderer.VOID_TAGS.has(name) && !m[0].endsWith('/>')) {
        stack.push(name)
      }
    }
    return stack.length > 0
  }

  /**
   * El aviso que ocupa el sitio de un medio que no se puede pintar.
   *
   * Lleva `data-bb-empty` con la etiqueta de origen porque el camino
   * HTML→BBCode lee de vuelta lo que hay en el lienzo: sin la marca, el texto
   * del aviso entraba al documento como contenido y se comía la etiqueta. En
   * `docs/ai/hxovc.bbcode`, con cinco `[img][/img]` vacíos, cada edición del
   * bloque convertía otro en la frase «[img] missing source URL».
   */
  private mediaError(tag: string, message: string): string {
    return `<div class="media-error" data-bb-empty="${tag}">${message}</div>`
  }

  private renderImage(node: RedNode): string {
    // `[img]url[/img]` carries its source as text content, not as a value
    // attribute. Trying only metadata/attrs rendered the URL as prose on every
    // pasted userpage image.
    let src = String(node.metadata?.src ?? '') || nodeAttrValue(node) || this.collectNodeText(node).trim()
    if (!src) {
      // osu! publica `<img alt="" src="" loading="lazy" />` para un `[img]`
      // que se guardó vacío (`[img]\n[/img]`, `[img] [/img]`, medido con el
      // harness): el elemento no muestra nada y el aviso del editor no tiene
      // equivalente. `[img][/img]` sin salto no se sella y queda literal, que
      // ya lo resuelve el pairing.
      if (this.isOsu()) return `<img${this.idAttr(node)} class="bb-img" src="" alt="">`
      return this.mediaError('img', '[img] missing source URL')
    }
    if (this.options.mediaProxy) {
      src = this.options.mediaProxy(src)
    }
    const imgAttr = parseImgAttr(nodeAttrValue(node))
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
    // El modificador no se puede reconstruir desde el `style` resultante
    // (`round` y `120x120` producen el mismo CSS), así que viaja literal.
    const rawAttr = nodeAttrValue(node)
    const attr = rawAttr ? ` data-img-attr="${this.escapeHtml(rawAttr)}"` : ''
    return `<img${this.idAttr(node)}${cls}${attr} src="${this.escapeHtml(src)}" alt="" style="${styles.join(';')};">`
  }

  private renderVideo(node: RedNode): string {
    // `[youtube]https://youtu.be/…[/youtube]` puts the URL in the body.
    let id = String(node.metadata?.videoId ?? '') || nodeAttrValue(node) || this.collectNodeText(node).trim()
    if (!id) return this.mediaError('youtube', '[youtube] missing video ID')
    const ytMatch = /(?:youtu\.be\/|v=|\/embed\/|\/shorts\/)([\w-]{11})/.exec(id)
    if (ytMatch) id = ytMatch[1]
    // `data-youtube` es lo que deja al converter HTML→BBCode reconocer este
    // iframe. Sin él el vídeo volvía como un `group` vacío: se perdía entero.
    // Las clases de osu van en el iframe mismo, no en un div contenedor: son
    // las que le dan la caja 16:9. Y su `src` lleva siempre `?rel=0`.
    if (this.isOsu()) {
      // osu! incrusta los primeros `youtube_embed_max` (10) y a partir de ahí
      // deja un enlace: `++$count < $max` (BBCodeFromDB::parseYoutube).
      this.youtubeEmbeds += 1
      if (this.youtubeEmbeds >= HTMLRenderer.OSU_YOUTUBE_EMBED_MAX) {
        const href = osuPurifiedHref(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`)
        return `<a${this.idAttr(node)}${href ? ` href="${href}"` : ''} rel="nofollow">See in YouTube (${this.escapeHtml(id)})</a>`
      }
    }
    const cls = this.isOsu() ? 'u-embed-wide u-embed-wide--bbcode' : 'bb-youtube'
    const rel = this.isOsu() ? '?rel=0' : ''
    return `<iframe${this.idAttr(node)} class="${cls}" data-youtube="${this.escapeHtml(id)}" src="https://www.youtube.com/embed/${this.escapeHtml(id)}${rel}" frameborder="0" allowfullscreen></iframe>`
  }

  private renderAudio(node: RedNode): string {
    let src = String(node.metadata?.src ?? '') || node.text || ''
    if (this.options.mediaProxy && src) {
      src = this.options.mediaProxy(src)
    }
    const isLyne = this.options.theme === 'lyne' || this.options.dialect === 'lyne'
    if (isLyne) {
      const rawName = src.split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || 'audio_track.mp3'
      let fileName = rawName
      try {
        fileName = decodeURIComponent(rawName)
      } catch {}
      return `<div${this.idAttr(node)} class="lx-audio bb-audio" data-src="${this.escapeHtml(src)}">`
        + `<audio preload="metadata" src="${this.escapeHtml(src)}"></audio>`
        + `<div class="lx-track" role="progressbar" aria-label="Audio progress"><div class="fill"></div></div>`
        + `<div class="lx-row">`
        + `<button type="button" class="lx-btn" aria-label="Play"><svg viewBox="0 0 16 16"><path d="M3 1.5 14 8 3 14.5z"/></svg></button>`
        + `<div class="lx-title">`
        + `<div class="name">${this.escapeHtml(fileName)}</div>`
        + `<div class="label"><span class="dot"></span> <span class="status-text">audio</span></div>`
        + `</div>`
        + `<div class="lx-vol">`
        + `<button type="button" class="lx-vol-btn" aria-label="Mute"><svg viewBox="0 0 16 16"><path d="M10.707 11.182A4.5 4.5 0 0 0 12.025 8a4.5 4.5 0 0 0-1.318-3.182L10 5.525A3.5 3.5 0 0 1 11.025 8 3.5 3.5 0 0 1 10 10.475zM6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06"/></svg></button>`
        + `<input type="range" class="lx-vol-slider" min="0" max="1" step="0.01" value="0.2" aria-label="Volume" style="background:linear-gradient(to right, var(--color-accent, #2EE6E2) 20%, var(--color-inset-well, #080D20) 20%);" />`
        + `</div>`
        + `<button type="button" class="lx-speed" aria-label="Playback speed">1.0×</button>`
        + `<div class="lx-time"><span class="cur">0:00</span> / <span class="total">–:––</span></div>`
        + `</div>`
        + `</div>`
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
      const color = sanitizeColor(nodeAttrValue(node, 'color'), this.tokenResolver)
      const styleAttr = color
        ? ` style="background:${this.hexToRgba(color, 0.08)};border-color:${this.hexToRgba(color, 0.4)};border-left-color:${color};color:${this.hexToRgba(color, 0.85)};"`
        : ''
      const markStyle = color ? ` style="color:${color};"` : ''
      const content = this.renderChildren(node)
      const warningIcon = warning ? `<span aria-hidden class="bb-notice-mark"${markStyle}>⚠</span>` : ''
      return `<div${this.idAttr(node)} class="notice bb-cut-panel bb-notice${warning ? ' bb-wnotice' : ''}" role="note"${styleAttr}>${warningIcon}<div class="bb-notice-body">${content}</div></div>`
    }

    // osu pinta el aviso con `.well` a secas — no hay ninguna clase `notice`
    // en su hoja de estilos, que es por lo que el bloque salía desnudo.
    if (this.isOsu()) {
      const content = HTMLRenderer.trimOsuEdges(this.renderChildren(node))
      return `<div${this.idAttr(node)} class="well">${content}</div>`
    }

    return this.wrapBlock('div', node, 'class="notice"')
  }

  private renderTables(node: RedNode): string {
    const variant = (String(node.metadata?.variant ?? '') || nodeAttrValue(node) || '').trim().toLowerCase()
    const variants = new Set(variant.split(/[\s,]+/).filter(Boolean))
    const tableClasses = [
      'bb-table',
      variants.has('striped') ? 'bb-table-striped' : '',
      variants.has('borders') ? 'bb-table-borders' : '',
    ].filter(Boolean).join(' ')
    this.tableDepth++
    this.maxColsStack.push(HTMLRenderer.widestRow(node))
    const content = this.renderChildren(node)
    this.maxColsStack.pop()
    this.tableDepth--
    // `[tables=striped:#hex]`: de `--table-accent` se deriva toda la paleta
    // de la tabla (gradiente del frame, hover de filas, encabezado, bordes).
    const accent = this.boxAccentStyle(node, 'table')
    return `<div${this.idAttr(node)} class="bb-table-frame"${accent}><table class="${tableClasses}"><tbody>${content}</tbody></table></div>`
  }

  /** Celdas directas de una fila, sin materializar un array intermedio. */
  private static countCells(node: RedNode): number {
    let count = 0
    const children = node.children
    for (let i = 0; i < children.length; i++) {
      const kind = children[i].kind
      if (kind === 'table_th' || kind === 'table_col') count++
    }
    return count
  }

  /**
   * Columnas de la tabla más ancha bajo `tableNode`, memoizado por tabla.
   *
   * `getTableContext` se llama una vez POR CELDA, y recorría todas las filas
   * de la tabla en cada llamada, con un `.filter()` —y su array— por fila.
   * Una tabla de 20×20 hacía 8.000 arrays intermedios en cada renderizado
   * para llegar 400 veces al mismo número. El caché se vacía al empezar cada
   * render, así que no retiene nodos entre documentos.
   */
  private static widestRow(tableNode: RedNode): number {
    let maxCols = 1
    const rows = tableNode.children
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (row.kind !== 'table_row') continue
      const count = HTMLRenderer.countCells(row)
      if (count > maxCols) maxCols = count
    }
    return maxCols
  }

  private getTableContext(node: RedNode): { cellCount: number; maxCols: number; isDirect: boolean } {
    const parent = node.parent
    const isDirect = parent?.kind === 'tables'
    const tableNode = isDirect ? parent : (parent?.parent?.kind === 'tables' ? parent.parent : undefined)
    const cellCount = parent ? HTMLRenderer.countCells(parent) : 1

    let maxCols = cellCount
    if (tableNode) {
      // La tabla en curso está en lo alto de la pila; solo se recorre si esta
      // celda llegó por un camino que no pasó por `renderTables`.
      const widest = this.maxColsStack.length > 0
        ? this.maxColsStack[this.maxColsStack.length - 1]
        : HTMLRenderer.widestRow(tableNode)
      if (widest > maxCols) maxCols = widest
    }
    return { cellCount, maxCols, isDirect }
  }

  private renderGallery(node: RedNode): string {
    const content = this.renderChildren(node)
    return `<div${this.idAttr(node)} class="bb-gallery">${content}</div>`
  }

  private renderColumns(node: RedNode): string {
    const cols = parseInt(String(node.metadata?.columns ?? '') || nodeAttrValue(node) || '2', 10)
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
    const variant = (String(node.metadata?.variant ?? '') || nodeAttrValue(node) || 'line').trim().toLowerCase()
    if (variant === 'dots') return `<div${this.idAttr(node)} class="bb-separator">· · ·</div>`
    if (variant === 'stars') return `<div${this.idAttr(node)} class="bb-separator">✦ ✦ ✦</div>`
    return `<hr${this.idAttr(node)} class="bb-separator" />`
  }

  private renderScroll(node: RedNode): string {
    const h = parseInt(String(node.metadata?.height ?? '') || nodeAttrValue(node) || '200', 10)
    const maxH = Math.max(50, Math.min(2000, isNaN(h) ? 200 : h))
    const content = this.renderChildren(node)
    return `<div${this.idAttr(node)} class="bb-scroll" style="max-height:${maxH}px;">${content}</div>`
  }

  private renderAbbr(node: RedNode): string {
    const title = String(node.metadata?.title ?? '') || nodeAttrValue(node)
    const attr = title ? ` title="${this.escapeHtml(title)}"` : ''
    return this.wrapInline('abbr', node, attr)
  }

  private renderTooltip(node: RedNode): string {
    const tip = String(node.metadata?.tip ?? '') || nodeAttrValue(node)
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
    const alignVal = (String(node.metadata?.align ?? '') || nodeAttrValue(node) || 'center').trim().toLowerCase()
    const validAlign = alignVal === 'left' || alignVal === 'right' ? alignVal : 'center'
    return this.renderAlignAs(node, validAlign)
  }

  /**
   * `[centre]` / `[left]` / `[right]` (y `[align=…]`).
   *
   * osu! no usa `text-align` inline: estiliza el bloque por nombre de clase,
   * con la grafía británica `centre`. Fuera del dialecto osu el estilo inline
   * se mantiene, porque ni Miliastry ni Lyne traen esas reglas.
   */
  private renderAlignAs(node: RedNode, align: 'center' | 'left' | 'right'): string {
    if (this.isOsu()) {
      const name = align === 'center' ? 'centre' : align
      return this.wrapBlock('div', node, `class="bbcode__align-${name}"`)
    }
    return this.wrapBlock('div', node, `style="text-align:${align};"`)
  }

  private renderEffect(node: RedNode): string {
    const raw = (String(node.metadata?.effectType ?? '') || nodeAttrValue(node) || 'glow').toLowerCase().trim()
    const effectType = raw.includes(':') ? raw.split(':')[0] : (raw.startsWith('#') ? 'glow' : raw)
    const rawColor = String(node.metadata?.color ?? '') || (raw.includes(':') ? raw.split(':')[1] : (raw.startsWith('#') ? raw : nodeAttrValue(node)))
    const color = sanitizeColor(rawColor, this.tokenResolver)
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
    const raw = (String(node.metadata?.animType ?? '') || nodeAttrValue(node) || 'pulse').toLowerCase().trim()
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
    const raw = (String(node.metadata?.containerType ?? '') || nodeAttrValue(node) || 'stack').trim()
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
        const accent = sanitizeColor(param, this.tokenResolver)
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
        const accent = sanitizeColor(param, this.tokenResolver)
        const cls = accent ? ' bb-accented' : ''
        const style = accent ? ` style="--${containerType}-accent:${accent};"` : ''
        return `<div${idAttr} class="bb-cut-panel bb-${containerType}${cls}"${style}>${content}</div>`
      }
      case 'neon-box':
      case 'neonbox': {
        const c = sanitizeColor(param || nodeAttrValue(node), this.tokenResolver) || 'var(--color-accent, #2EE6E2)'
        return `<div${idAttr} class="bb-cut-panel bb-neon-box" style="--neon-color:${c};border-color:${c};">${content}</div>`
      }
      default:
        return `<div${idAttr} class="bb-stack">${content}</div>`
    }
  }

  private renderStyleTag(node: RedNode): string {
    const raw = (String(node.metadata?.style ?? '') || nodeAttrValue(node) || '').trim()
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
      if (!STYLE_PROP_WHITELIST.has(prop)) continue
      // Los paréntesis son válidos en CSS (rgba(), blur(), rotate(), scale(),
      // color-mix()…) — antes se eliminaban y rompían esos valores. Lo que sí
      // se bloquea son las funciones/fuentes peligrosas (url(), expression(),
      // javascript:), que no tienen uso legítimo en el whitelist de props.
      let safeVal = stripStyleValue(val)
      if (safeVal.startsWith('$') && this.tokenResolver) {
        safeVal = resolveTokenValue(safeVal, this.tokenResolver)
      }
      if (isDangerousStyleValue(safeVal)) continue
      safeStyles.push(`${prop}:${safeVal}`)
    }

    if (safeStyles.length === 0) return `<span${idAttr}>${content}</span>`
    return `<span${idAttr} style="${safeStyles.join(';')}">${content}</span>`
  }

  private renderQuote(node: RedNode): string {
    const source = node.metadata?.source || nodeAttrValue(node)
    const content = this.renderChildren(node)
    if (source) {
      return `<blockquote${this.idAttr(node)}><div style="margin-bottom:8px"><strong>${this.escapeHtml(String(source))} wrote:</strong></div>${content}</blockquote>`
    }
    return `<blockquote${this.idAttr(node)}>${content}</blockquote>`
  }

  /**
   * Splits a `box`/`spoilerbox` node's own content around a trailing
   * `box_tail` (`pairing: 'osu'` crossing only — see `Types/core.ts` and
   * `Parser.ts`'s `closeDivUnits`): `body` is everything that belongs inside
   * the body div / details panel, `tail` is `null` for an ordinary,
   * non-crossing box, or the HTML of whatever landed after a crossing closer
   * consumed the body div early, WITHOUT closing the wrapper (osu!'s own
   * HTML keeps that content visible, still inside the wrapper, after the
   * body — measured: `[centre][box=a]x[/centre]y[/box]` → `<div box><a/>
   * <div body>x</div>y</div>`).
   */
  private splitBoxTail(node: RedNode): { body: string; tail: string | null } {
    const children = node.children
    const last = children.length > 0 ? children[children.length - 1] : null
    if (!last || last.kind !== 'box_tail') {
      return { body: this.renderChildren(node), tail: null }
    }
    let body = ''
    for (let i = 0; i < children.length - 1; i++) body += this.renderNode(children[i])
    return { body, tail: this.renderChildren(last) }
  }

  /**
   * La estructura exacta que `bbcode-spoilerbox` de osu-web espera.
   *
   * El toggle de osu es JS: `js-spoilerbox__link` es el gancho del click y
   * `js-spoilerbox__body` el panel que abre. Si falta cualquiera de las dos
   * clases el box queda mudo, así que la estructura no es decorativa.
   *
   * Bajo un cruce (`pairing: 'osu'`, ver `splitBoxTail`) el `tail` se pinta
   * DESPUÉS del `</div>` del cuerpo pero DENTRO del wrapper — exactamente
   * donde cae en el HTML real de osu!. `trimOsuEdges` se aplica a `body` y a
   * `tail` por separado (cada uno tiene su propio borde real recortable);
   * la costura entre ambos no se toca aquí, ya la decide el sistema de
   * newlines a nivel de árbol (ver `WIDTHLESS_CLOSE`).
   */
  private renderOsuSpoilerbox(node: RedNode, title: string, extra: string): string {
    const closer = this.osuTitleCloser(node)
    if (closer) title = title.split(closer).join('')
    const frames = this.osuTitleFrames(node)
    const head = `<div${this.idAttr(node)} class="js-spoilerbox bbcode-spoilerbox"${extra}>` +
      `<a class="js-spoilerbox__link bbcode-spoilerbox__link" href="#">` +
      `<span class="bbcode-spoilerbox__link-icon"></span>` +
      `<span class="bbcode-spoilerbox__link-text">${title}</span></a>`
    // Lo que el título publica DESPUÉS del `</div>` del wrapper: sólo texto, y
    // sólo cuando algo del título lo partió (ver `osuTitleTailText`).
    const tailText = frames === null && closer === null
      ? ''
      : this.breakTitleLines(this.escapeHtml(this.osuTitleTailText(node, closer, frames)))

    if (frames === null) {
      const { body, tail } = this.splitBoxTail(node)
      const bodyDiv = `<div class="js-spoilerbox__body bbcode-spoilerbox__body">${HTMLRenderer.trimOsuEdges(body)}</div>`
      const tailHtml = tail !== null ? HTMLRenderer.trimOsuEdges(tail) : ''
      // Un cierre de ancestro dentro del título termina el box tras su link: el
      // cuerpo sale como HERMANO del box, todavía dentro del ancestro (ver
      // `osuTitleCloser`).
      if (closer) return `${head}</div>${tailText}${bodyDiv}${tailHtml}`
      return `${head}${tailText}${bodyDiv}${tailHtml}</div>`
    }

    // Un `<div>` abierto dentro del título: su caja vive ahí, así que el cuerpo
    // de la caja cae DENTRO de ella (medido: `box-title-opener-sealed.bbcode`
    // publica `<div box><a/></div><div centre><div body>body</div></div>`).
    const inner = frames[frames.length - 1]
    // El div del cuerpo cuelga de lo que la caja reunió DENTRO del último
    // frame. Lo que llegó DESPUÉS de ese frame —un cierre real escrito en el
    // título ya lo gastó, así que el contenido siguiente ya no cuelga de él—
    // se publica tras el `</div>` del cuerpo, pero todavía dentro del frame:
    // medido en `box-title-opener-late-closer.bbcode`
    // (`[centre][box=X[/centre][centre]]A[/centre]B[/box]`), que osu! publica
    // como `<div centre><div body>A</div>B</div>`, no como un cuerpo `AB`.
    const body = HTMLRenderer.trimOsuEdges(this.renderChildren(inner))
    let content = `<div class="js-spoilerbox__body bbcode-spoilerbox__body">${body}</div>`
    for (let i = 1; i < node.children.length; i++) content += this.renderNode(node.children[i])
    let html = content
    for (let i = frames.length - 1; i >= 0; i--) html = this.osuTitleDivOpen(frames[i]) + html + '</div>'
    // Sin cierre en el título el wrapper sigue abierto hasta el final del box,
    // e envuelve también a esos divs.
    return closer ? `${head}</div>${tailText}${html}` : `${head}${tailText}${html}</div>`
  }

  /**
   * Los `<div>` que un TÍTULO de caja abrió y que el cuerpo cuelga dentro.
   *
   * osu! no parsea el título: su pasada de alineación inserta el `<div>` en
   * crudo dentro del `link-text` y HTMLPurifier lo sube fuera del enlace, con
   * todo lo que venga después (el cuerpo de la caja) dentro. El árbol abre esos
   * nodos al construir la caja (`Parser.ts`, evento `open` de `titleEvents`) y
   * los marca con `leadingWidth: 0`: sus bytes son parte del delimitador de
   * apertura del box, así que no tienen tag propio en la fuente. Devuelve la
   * cadena desde el más externo al más interno, o `null` si el título no abrió
   * ninguno.
   */
  private osuTitleFrames(node: RedNode): RedNode[] | null {
    const frames: RedNode[] = []
    let cur: RedNode | undefined = node.children[0]
    while (cur !== undefined && cur.kind === 'title_div') {
      frames.push(cur)
      cur = cur.children[0]
    }
    return frames.length > 0 ? frames : null
  }

  /** El `<div>` con que osu! publica un tag de bloque abierto en un título. */
  private osuTitleDivOpen(frame: RedNode): string {
    const tag = frame.text
    if (tag === 'notice') return '<div class="well">'
    return `<div class="bbcode__align-${tag}">`
  }

  /**
   * El `<div>` de un `title_div` fuera del camino de osu!: mismo markup que el
   * tag que representa (`centre` → `bbcode__align-centre`, `notice` → `.well`)
   * y, en el resto de dialectos, un div alineado por estilo — la misma idea que
   * `renderAlignAs`/`renderNotice`.
   */
  private renderTitleDiv(node: RedNode): string {
    const tag = node.text
    const content = tag === 'notice' ? HTMLRenderer.trimOsuEdges(this.renderChildren(node)) : this.renderChildren(node)
    if (tag === 'notice') {
      return this.isOsu() ? `<div class="well">${content}</div>` : this.wrapBlock('div', node, 'class="notice"')
    }
    if (tag === 'center') {
      return this.isOsu()
        ? `<div class="bbcode__align-centre">${content}</div>`
        : this.wrapBlock('div', node, 'style="text-align:center;"')
    }
    if (tag === 'left' || tag === 'right') {
      return this.isOsu()
        ? `<div class="bbcode__align-${tag}">${content}</div>`
        : this.wrapBlock('div', node, `style="text-align:${tag};"`)
    }
    return content
  }

  /**
   * El texto del título que osu! publica FUERA del `link-text`, ya sin los tags
   * que se sellaron (esos son los divs: el cierre que partió el box y cada
   * apertura con nodo propio). Es lo que queda: un tag sobrante, que osu! deja
   * escrito tal cual (`box-title-opener-surplus.bbcode` publica `X</a></div>
   * [centre]<div body>body</div>`), y nada más.
   *
   * Se calcula sobre `metadata.rawTitle`, que es el texto del atributo: el
   * renderer no ve las posiciones del emparejado, sólo sus consecuencias — el
   * cierre que `osuTitleCloser` encontró y los nodos que el árbol abrió.
   */
  private osuTitleTailText(node: RedNode, closer: string | null, frames: RedNode[] | null): string {
    const raw = node.metadata?.rawTitle
    if (typeof raw !== 'string' || raw === '') return ''
    let tail = raw
    if (closer !== null) {
      const at = raw.indexOf(closer)
      if (at < 0) return ''
      tail = raw.slice(at + closer.length)
    }
    if (frames !== null) {
      for (const frame of frames) {
        const tag = frame.text === 'center' ? '[centre]' : `[${frame.text}]`
        const at = tail.indexOf(tag)
        if (at >= 0) tail = tail.slice(0, at) + tail.slice(at + tag.length)
      }
    }
    return tail
  }

  /**
   * El cierre de un ancestro escrito DENTRO DEL TÍTULO de un box.
   *
   * osu! mete el título en crudo en el `link-text` y después sus pasadas
   * globales lo procesan: en `[centre][box=T[/centre]]body[/box]` el par
   * `[centre]…[/centre]` se sella CON el cierre del título, que sale como un
   * `</div>` dentro del rótulo; HTMLPurifier repara el cruce terminando el box
   * tras su link y dejando el cuerpo como hermano (medido con el harness:
   * `<div class="well"><div class="js-spoilerbox…"><a…>T</a></div>
   * <div class="js-spoilerbox__body…">body</div></div>`). Un cierre cuyo tag no
   * tiene ancestro abierto NO se consume: queda literal en el título, también
   * medido (`[box=T[/centre]]` publica `T[/centre]`).
   */
  private osuTitleCloser(node: RedNode): string | null {
    const raw = node.metadata?.rawTitle
    if (typeof raw !== 'string' || !raw.includes('[/')) return null
    const m = /\[\/(centre|center|notice|wnotice|box|boxw|spoilerbox|quote|list)\]/i.exec(raw)
    if (!m) return null
    const kinds = HTMLRenderer.OSU_TITLE_CLOSER_KINDS[m[1].toLowerCase()]
    if (!kinds) return null
    for (let p = node.parent; p; p = p.parent) {
      if (kinds.has(p.kind)) return m[0]
    }
    return null
  }

  private static readonly OSU_TITLE_CLOSER_KINDS: Record<string, ReadonlySet<string>> = {
    centre: new Set(['center']),
    center: new Set(['center']),
    notice: new Set(['notice', 'wnotice']),
    wnotice: new Set(['notice', 'wnotice']),
    box: new Set(['box', 'boxw']),
    boxw: new Set(['box', 'boxw']),
    spoilerbox: new Set(['spoilerbox']),
    quote: new Set(['quote']),
    list: new Set(['list']),
  }

  /** El rótulo de un box bajo osu: el del autor, o `SPOILER` en mayúsculas. */
  private osuBoxTitle(node: RedNode): string {
    // `[box=]` no lleva rótulo: osu! publica el `link-text` vacío, no SPOILER.
    // El `=` está, el título no, y esa diferencia es la que se ve.
    if (node.metadata?.emptyTitle) return ''
    // osu! publica el atributo tal como está ESCRITO: `[box="playstyle"]`
    // enseña `"playstyle"` con las comillas (medido), mientras que `title` las
    // pierde para el título rico del editor. `[box=Title:#ff0000]` publica
    // también el sufijo de color, por el mismo motivo. Con título rico
    // (`[box=[b]T[/b]]`) siguen mandando sus nodos: osu! sella las etiquetas de
    // dentro del atributo y las publica igual.
    const titleNodes = node.metadata?.titleNodes as RedNode[] | undefined
    const rawAttr = node.metadata?.rawAttr
    if ((!titleNodes || titleNodes.length === 0) && typeof rawAttr === 'string' && rawAttr !== '') {
      return this.breakTitleLines(this.escapeHtml(rawAttr))
    }
    return this.hasOwnTitle(node) ? this.renderTitle(node, 'SPOILER') : 'SPOILER'
  }

  private renderSpoilerbox(node: RedNode): string {
    if (this.isOsu()) {
      // Un [spoilerbox] sin título propio se rotula SPOILER, en mayúsculas.
      return this.renderOsuSpoilerbox(node, this.osuBoxTitle(node), this.bareTitleAttr(node))
    }
    const title = this.renderTitle(node, 'Spoiler')
    const bare = this.bareTitleAttr(node)
    const { body, tail } = this.splitBoxTail(node)
    const isLyne = this.options.theme === 'lyne' || this.options.dialect === 'lyne'
    const bodyCls = isLyne ? 'bb-box-body' : 'bbcode-box-body'
    // El wrapper agrupa el título en un solo flex item (ver renderBox) y usa
    // `bb-box-heading` (no `bb-box-title`) para no colisionar con la regla
    // legacy `.bbcode-preview .bb-box-title` de la app, que pinta un fondo.
    // `--box-accent` colorea el acento del box (título + chevron, y el borde
    // en boxw) cuando el autor puso `[box=Title:#hex]`.
    const accent = this.boxAccentStyle(node)
    const details = `<details${this.idAttr(node)}${bare}${accent}><summary><span class="bb-box-heading">${title}</span></summary><div class="${bodyCls}">${body}</div></details>`
    // Bajo un cruce (`pairing: 'osu'`, ver `splitBoxTail`) `<details>` no
    // tiene forma de mostrar algo "dentro pero fuera del panel colapsable" —
    // así que el tail se pinta DESPUÉS del elemento entero, en vez de dentro.
    // Eso conserva la misma propiedad que tiene en osu!: ese contenido se ve
    // aunque el box esté colapsado (osu! lo pinta fuera del `__body`, que es
    // lo único que el JS oculta).
    return tail !== null ? details + tail : details
  }

  private renderBox(node: RedNode): string {
    if (this.isOsu()) {
      // osu no distingue box de spoilerbox: es la misma construcción, y sin
      // título propio rotula SPOILER igual que `[spoilerbox]`.
      return this.renderOsuSpoilerbox(node, this.osuBoxTitle(node), this.bareTitleAttr(node))
    }
    const title = this.renderTitle(node, 'Box')
    const bare = this.bareTitleAttr(node)
    const { body, tail } = this.splitBoxTail(node)
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
    const details = `<details${this.idAttr(node)} class="${cls}"${bare}${accent}><summary><span class="bb-box-heading">${title}</span></summary><div class="${bodyCls}">${body}</div></details>`
    // Ver `renderSpoilerbox`: mismo motivo para pintar el tail fuera de
    // `<details>` en vez de dentro.
    return tail !== null ? details + tail : details
  }

  /**
   * Marca un `[box]`/`[spoilerbox]` sin título propio.
   *
   * El `<summary>` siempre lleva texto ("Box", "Spoiler"), así que sin esta
   * marca el camino HTML→BBCode leía ese relleno como si el autor lo hubiera
   * escrito y devolvía `[box=Box]`.
   */
  private bareTitleAttr(node: RedNode): string {
    return this.hasOwnTitle(node) ? '' : ' data-bare-title="1"'
  }

  /**
   * ¿El título del box lo escribió el autor, o es el relleno del parser?
   *
   * `BBCodeToGreenNode` ya deja `metadata.title = 'Box'`/`'Spoiler'` para un
   * tag pelado, así que el `fallback` de `renderTitle` nunca llega a usarse:
   * quien quiera otro rótulo por defecto tiene que preguntar por aquí.
   */
  private hasOwnTitle(node: RedNode): boolean {
    const raw = node.metadata?.rawTitle
    return raw !== undefined ? String(raw) !== '' : node.metadata?.title !== undefined
  }

  private renderTitle(node: RedNode, fallback: string): string {
    const titleNodes = node.metadata?.titleNodes as RedNode[] | undefined
    if (titleNodes && titleNodes.length > 0) {
      const html = this.breakTitleLines(titleNodes.map(c => this.renderNode(c)).join(''))
      // El título se pinta desde dentro del tag de apertura, y en el texto de
      // osu! lo cierra su `]`: la vecindad de la hoja siguiente (el cuerpo) no
      // ve la cola del título, ve el tag —como no ver nada—, que es lo que
      // `parseLinks` mira. Sin esto, `[box=T]https://x` heredaba la `T`... y una
      // URL precedida de texto no se enlaza.
      this.osuLinkContext = ''
      return html
    }
    let title = String(node.metadata?.title ?? nodeAttrValue(node) ?? fallback)
    if (this.tokenResolver) {
      title = title.replace(/\$([\p{L}_][\p{L}\p{M}\p{N}_-]*)/gu, (match, name) => {
        const resolved = this.tokenResolver!(name) ?? this.tokenResolver!(match)
        return resolved !== undefined ? resolved : match
      })
    }
    return this.breakTitleLines(this.escapeHtml(title))
  }

  /** See {@link HTMLRendererOptions.boxTitleLineBreaks}. */
  private breakTitleLines(html: string): string {
    // A title is text, not a flow: a swallowed newline in it is still the
    // author's line break (or the literal newline without the option).
    html = html.replace(SWALLOWED_NEWLINE_RE, '\n')
    return this.options.boxTitleLineBreaks ? html.replace(TITLE_NEWLINE_RE, '<br />') : html
  }

  /**
   * `[box=Title:#hex]`, `[tables=striped:#hex]`, `[columns=2:#hex]` → un
   * ` style="--<suffix>-accent:#hex;"` del que el CSS deriva la paleta
   * (título + chevron y borde en boxw; gradientes/header/hover en tables;
   * borde + fondo en columns). Devuelve '' si no hay color válido.
   */
  private boxAccentStyle(node: RedNode, suffix: 'box' | 'table' | 'columns' = 'box'): string {
    const color = sanitizeColor(String(node.metadata?.color ?? ''), this.tokenResolver)
    if (!color) return ''
    const border = this.hexToRgba(color, 0.35)
    const bg = this.hexToRgba(color, 0.08)
    return ` style="--${suffix}-accent:${color};--${suffix}-border:${border};--${suffix}-bg:${bg};"`
  }

  private renderList(node: RedNode): string {
    const isOrdered = this.osuListOrdered(node)
    const tag = isOrdered ? 'ol' : 'ul'
    if (this.isOsu()) return this.renderOsuList(node, tag)
    const content = node.children.map(c => this.renderNode(c)).join('\n')
    return `<${tag}${this.idAttr(node)}>${content}</${tag}>`
  }

  /**
   * `[list]` como lo publica osu!.
   *
   * osu! sólo abre la lista (`<ol…><li>`) si el `[*]` viene pegado a la
   * apertura; si hay texto antes del primer ítem, ese texto se convierte en
   * un `<ul class="bbcode__list-title"><li>` — la "lista con título" — y la
   * lista real empieza en el primer ítem, aunque no quede ninguno
   * (`<ol…></ol>` vacío). Quasar lo pintaba como texto suelto dentro de la
   * lista, un ítem menos y sin el bloque de título.
   */
  private renderOsuList(node: RedNode, tag: 'ol' | 'ul'): string {
    // Dentro de un FORMATO sellado no hay lista: osu! publica el texto de los
    // ítems corrido (ver `osuFlattensList`).
    if (HTMLRenderer.osuFlattensList(node)) return this.renderOsuFlatList(node)
    const children = node.children
    const first = children.findIndex(c => c.kind === 'list_item')
    const open = `<${tag}${this.idAttr(node)}>`
    // osu!'s first regex is `\[list:uid\]\s*\[\*:uid\]`: whitespace before the
    // first `[*]` is part of the ordinary list — and swallowed by it — not a
    // title. Only real content there opens the `bbcode__list-title` block.
    let firstContent = first
    while (firstContent > 0) {
      const c = children[firstContent - 1]
      if (c.kind === 'spacing' || c.kind === 'empty_line' || (c.kind === 'text' && c.text.trim() === '')) firstContent -= 1
      else break
    }
    if (firstContent === 0) return `${open}${this.renderOsuListBody(children)}</${tag}>`
    // Ningún ítem es hijo DIRECT de la lista, pero uno o varios viven dentro
    // de un envoltorio inline (`[list][color=#000]\n[*]…[/list]`,
    // `osu/2814070`): osu! no anida ahí. Su paso de título corta en el primer
    // `<li>`, deja el envoltorio vacío en el `<li>` del título y abre el
    // `<ol>` fuera, con todos los ítems dentro. Sin esto el envoltorio entero
    // se publicaba como título y cada ítem abría su propio `<ol>` dentro del
    // `<span>`.
    if (first === -1) {
      const items: RedNode[] = []
      for (const child of children) {
        if (isBlockKind(child.kind)) continue
        HTMLRenderer.collectOsuStrays(child, items)
      }
      if (items.length > 0) {
        const pruned = this.osuPruned
        for (const item of items) pruned.add(item)
        let title = ''
        try {
          for (const child of children) title += this.renderNode(child)
        } finally {
          for (const item of items) pruned.delete(item)
        }
        let body = open
        for (const item of items) body += this.renderOsuItem(item)
        return `<ul class="bbcode__list-title"><li>${title}</li></ul>${body}</${tag}>`
      }
    }
    const upto = first === -1 ? children.length : first
    // Una `[list]` anidada corta el título igual que un ítem: el paso de título
    // de osu! termina en el primer `<li>`, que es el de la lista anidada, así
    // que el `<ul class="bbcode__list-title"><li>` queda con el texto de delante
    // y VACÍO de lista, y los ítems de la anidada salen en un `<ol>` propio con
    // la clase de la lista EXTERIOR (la que escribe el reemplazo). Medido: d4,
    // d6, d9, d10, d11; los ítems que la exterior tenga después de la anidada
    // se publican fuera de la lista, como texto (d8).
    let nested = -1
    for (let i = 0; i < upto; i++) {
      const c = children[i]
      if (c.kind !== 'list' || !HTMLRenderer.osuListStartsAtItem(c)) continue
      nested = i
      break
    }
    if (nested !== -1) {
      let title = ''
      for (let i = 0; i < nested; i++) title += this.renderNode(children[i])
      let out = `<ul class="bbcode__list-title"><li>${title}</li></ul>${open}`
      out += this.renderOsuListBody(children[nested].children)
      out += `</${tag}>`
      for (let i = nested + 1; i < children.length; i++) {
        const c = children[i]
        out += c.kind === 'list_item' ? this.renderChildren(c) : this.renderNode(c)
      }
      return out
    }
    let title = ''
    for (let i = 0; i < upto; i++) title += this.renderNode(children[i])
    const items = this.renderOsuListBody(children.slice(upto))
    return `<ul class="bbcode__list-title"><li>${title}</li></ul>${open}${items}</${tag}>`
  }

  /**
   * El cuerpo de una `[list]`: sus ítems, todos hermanos del mismo `<ol>`.
   *
   * osu! convierte `[*]` en `<li>` allá donde caiga el texto — no mira el
   * anidamiento — y HTMLPurifier lo saca del bloque que lo envolvía, dejándolo
   * vacío: `[list][*]a[box=x][*]b[/box][/list]` publica `<ol><li>a…box sin
   * cuerpo</li><li>b</li></ol>`, los dos ítems hermanos. Un `[*]` que el árbol
   * dejó dentro de un box, un notice o el ítem anterior se pinta por tanto
   * FUERA, en el punto donde el árbol lo tenía: se marca mientras se pinta su
   * contenedor (para que no salga también ahí dentro) y se emite después, ya
   * como `<li>` de esta lista. Medido con el harness: `osu-cases/list-items-in-
   * box` es la mitad del caso (la lista entera en zona de título) y
   * `osu/11231432` la otra.
   *
   * Las listas anidadas no entran: una `[list]` hija reclama los suyos, y el
   * `[*]` de dentro es ítem suyo, no de esta.
   */
  /**
   * ¿La lista es de las normales (su contenido empieza en un ítem) o de las que
   * tienen título? Es la misma condición que abre el `<ul
   * class="bbcode__list-title">`, y la que distingue la lista anidada que corta
   * el título de la que se pinta dentro (una lista con título propio, medida en
   * `osu/5724103`: el `<ul>` anidado también cuenta como contenido).
   */
  private static osuListStartsAtItem(node: RedNode): boolean {
    const i = HTMLRenderer.firstContentIndex(node.children)
    return i !== -1 && node.children[i].kind === 'list_item'
  }

  /** Índice del primer hijo que no es espaciado, línea vacía ni texto en blanco. */
  private static firstContentIndex(children: readonly RedNode[]): number {
    for (let i = 0; i < children.length; i++) {
      const c = children[i]
      if (c.kind === 'spacing' || c.kind === 'empty_line' || (c.kind === 'text' && c.text.trim() === '')) continue
      return i
    }
    return -1
  }

  private renderOsuListBody(children: readonly RedNode[]): string {
    const pruned = this.osuPruned
    const added: RedNode[] = []
    let out = ''
    try {
      for (const child of children) {
        if (child.kind === 'list') {
          out += this.renderNode(child)
          continue
        }
        const strays: RedNode[] = []
        HTMLRenderer.collectOsuStrays(child, strays)
        // Sólo se saca el ítem si el bloque se queda sin nada detrás de él. osu!
        // cierra el `<li>` en el siguiente `[*]`, así que el bloque del que sale
        // se cierra justo ahí y lo que viniera después se publica fuera de la
        // lista: sacarlo con contenido detrás mudaba ese contenido de sitio
        // (`osu/13972931`, un box cruzado: 59 líneas de desplazamiento).
        if (strays.length === 0 || !HTMLRenderer.osuTailIsEmpty(child, strays[strays.length - 1])) {
          out += this.renderNode(child)
          continue
        }
        for (const s of strays) { pruned.add(s); added.push(s) }
        out += this.renderNode(child)
        for (const s of strays) out += this.renderOsuItem(s)
      }
    } finally {
      // Un render que lance a mitad no puede dejar ítems podados para el
      // siguiente: el reconciliador vuelve a pintar bloques sueltos.
      for (const s of added) pruned.delete(s)
    }
    return out
  }

  /**
   * ¿Tras el ítem `last` no queda nada en `root` que osu! mantendría dentro del
   * bloque? El espaciado y las líneas vacías no cuentan (se cierran con el
   * bloque sin mover texto). Se salta el cuerpo del propio ítem: se mueve entero.
   */
  private static osuTailIsEmpty(root: RedNode, last: RedNode): boolean {
    let after = false
    let clean = true
    const walk = (n: RedNode): void => {
      if (!clean) return
      if (n === last) {
        after = true
        return
      }
      if (after && n.children.length === 0) {
        // `discarded_tag` es el cierre de un bloque que osu! consume (su
        // `</div>`): no publica texto, así que no cuenta como contenido.
        if (n.kind === 'spacing' || n.kind === 'empty_line' || n.kind === 'discarded_tag') return
        if (n.kind === 'text' && n.text.trim() === '') return
        clean = false
        return
      }
      for (const c of n.children) walk(c)
    }
    walk(root)
    return clean
  }

  /**
   * Los `[*]` de la zona de un hijo de la lista que son ítems de ESA lista: los
   * que no tienen otra `[list]` en medio, que se los queda. En orden de
   * documento, que es el orden en que osu! emite los `<li>`.
   */
  private static collectOsuStrays(node: RedNode, out: RedNode[]): void {
    for (const c of node.children) {
      if (c.kind === 'list') continue
      if (c.kind === 'list_item') out.push(c)
      HTMLRenderer.collectOsuStrays(c, out)
    }
  }

  /** El `<li>` de un ítem: el `<ol>` que lo abre es de quien lo pinta. */
  private renderOsuItem(node: RedNode): string {
    return `<li${this.idAttr(node)}>${this.renderChildren(node)}</li>`
  }

  /**
   * ¿La lista cae dentro de un formato que osu! deja viajar por los bloques?
   *
   * `[b]`, `[i]`, `[u]` y `[c]` son los que HTMLPurifier cierra antes de un
   * bloque y REABRE dentro y después (ver `wrapOsuFormatting`). Dentro de uno
   * de ellos osu! no abre lista: `[b][list][*]a[*]b[/list][/b]` publica
   * `<strong>ab</strong>` — sin `<ol>`, sin `<li>`, sin `<br>` entre ítems —
   * y lo mismo con el bloque que sea: `[i][notice]n[list]…[/list][/notice][/i]`
   * deja `n` y los ítems dentro del MISMO `<em>`, y `[b][quote][list]…`
   * conserva el `<blockquote>` pero no la lista. Medido. La condición es
   * estar DENTRO del formato, no colgar de él: `[box=b][b][list]…` también
   * se aplana, y `[b][box=b][list]…` igual.
   *
   * `[s]`/`[strike]` NO entran: `[s][list][*]a[*]b[/list][/s]` publica
   * `<del><ol><li>a</li><li>b</li></ol></del>` (medido). Un formato sin sellar
   * tampoco: su apertura es texto literal y no hay nodo que envolver.
   *
   * `inline_code` va por completitud: `[c]` es un bloque crudo en el árbol
   * (su contenido es texto), así que un `[list]` escrito dentro nunca llega a
   * ser un nodo `list`. Sí valdría para un árbol pegado como HTML.
   */
  private static osuFlattensList(node: RedNode): boolean {
    for (let p = node.parent; p !== null; p = p.parent) {
      if (p.kind === 'bold' || p.kind === 'italic' || p.kind === 'underline' || p.kind === 'inline_code') return true
    }
    return false
  }

  /**
   * Una lista aplanada por un formato: el contenido de sus ítems, corrido.
   *
   * El texto de la zona de título se queda (con sus saltos internos: un
   * título de dos líneas publica `first<br />second`); el hueco que osu! se
   * come contra el primer `[*]` — `#\[list:uid\]\s*\[\*:uid\]` — no. Los ítems
   * van en su sitio, cada uno sin `<li>` y sin el salto final que el siguiente
   * `[*]` se traga. Lo que queda detrás del último ítem lo decide el cierre
   * de la lista: el `\s*` de `[/list]` se lo come si la lista lo tiene.
   */
  private renderOsuFlatList(node: RedNode): string {
    this.osuFlatListDepth += 1
    try {
      const children = node.children
      // Una lista que un bloque cerró por dentro (su `[/list]` es más tarde,
      // fuera del formato) no tiene el `\s*` de su propio cierre: lo que quede
      // detrás del último ítem se queda. Medido en `osu/22686692`, donde el
      // `[b]` cierra la lista y el espacio de delante publica en negrita.
      const sealedCloser = (node.green.trailingWidth ?? 0) > 0
      let out = ''
      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (child.kind === 'list_item') {
          out += this.renderOsuFlatItem(child, HTMLRenderer.osuFlatSeam(children, i) || sealedCloser)
          continue
        }
        if (child.kind === 'list') {
          out += this.renderOsuFlatList(child)
          continue
        }
        if (HTMLRenderer.isOsuFlatBlank(child)) {
          if (HTMLRenderer.osuFlatSeam(children, i)) continue
          if (sealedCloser && HTMLRenderer.osuFlatNext(children, i) === null) continue
          out += this.renderNode(child)
          continue
        }
        out += this.renderNode(child)
      }
      return out
    } finally {
      this.osuFlatListDepth -= 1
    }
  }

  /**
   * El contenido de un ítem en una lista aplanada: sin `<li>` ni su cierre.
   *
   * `trimEnd` es el `\s*` que osu! tiene delante del `[*]` siguiente (o del
   * `[/list]` de la lista): se lleva saltos Y espacios —`[*]a [*]b` publica
   * `ab`; en una lista normal el espacio cae al final del `<li>` donde no se
   * ve, aplanado quedaría entre las dos palabras—. Con la lista cerrada por
   * un bloque de fuera no hay `[/list]` que lo coma y el espacio publica
   * (medido en `osu/22686692`: `[*][s]Top #9 Ecuador[/s] [/b]…` lo deja en
   * negrita).
   */
  private renderOsuFlatItem(node: RedNode, trimEnd: boolean): string {
    const children = node.children
    let end = children.length
    while (trimEnd && end > 0 && HTMLRenderer.isOsuFlatBreak(children[end - 1])) end -= 1
    let out = ''
    for (let i = 0; i < end; i++) out += this.renderNode(children[i])
    if (trimEnd) out = out.replace(/[ \t\r\n\f\v]+$/, '')
    return out
  }

  /** ¿Este hijo es de los que osu! se come alrededor de los ítems? */
  private static isOsuFlatBlank(node: RedNode): boolean {
    if (HTMLRenderer.isOsuFlatBreak(node)) return true
    return node.kind === 'text' && node.text.trim() === ''
  }

  /** Un salto de línea (o una línea vacía) del árbol, que el `[*]` se come. */
  private static isOsuFlatBreak(node: RedNode): boolean {
    return node.kind === 'spacing' || node.kind === 'empty_line'
  }

  /**
   * ¿Ese hueco es el que la lista se come? Sí si lo único que queda detrás son
   * ítems (o listas anidadas): es el `\s*` de `\[\*:uid\]`. Un hueco ENTRE dos
   * trozos de título es contenido y se pinta.
   */
  private static osuFlatSeam(children: readonly RedNode[], i: number): boolean {
    const next = HTMLRenderer.osuFlatNext(children, i)
    return next !== null && (next.kind === 'list_item' || next.kind === 'list')
  }

  /** El primer hermano que no es un hueco, o `null` si no hay nada detrás. */
  private static osuFlatNext(children: readonly RedNode[], i: number): RedNode | null {
    for (let j = i + 1; j < children.length; j++) {
      if (HTMLRenderer.isOsuFlatBlank(children[j])) continue
      return children[j]
    }
    return null
  }

  /**
   * ¿Ese `[list]` publica `<ol>` o `<ul>`?
   *
   * El paso de osu! toma CUALQUIER valor (`#\[list=[^]]+:uid\]`) como la
   * grafía ordenada — `[list=10]`, un typo como `[list=nope]`, todos publican
   * `<ol>` — y el `[list]` pelado es el único desordenado. Se lee del atributo
   * y no de una lista de "valores buenos": el paso no los mira.
   */
  private osuListOrdered(node: RedNode): boolean {
    return node.metadata?.ordered === true || nodeAttrValue(node) !== ''
  }

  private renderListItem(node: RedNode): string {
    if (!this.isOsu()) return `<li${this.idAttr(node)}>${this.renderChildren(node)}</li>`
    // Un ítem que su lista saca fuera del bloque donde cayó: lo pinta la lista,
    // en su sitio como hermano (ver `renderOsuListBody`).
    if (this.osuPruned.has(node)) return ''
    // Dentro de una lista que un formato aplanó no hay `<li>` que abrir, ni
    // siquiera para un `[*]` que cayó en un bloque de dentro.
    if (this.osuFlatListDepth > 0) return this.renderOsuFlatItem(node, true)
    // Dentro de la lista: el `<ol>`/`<ul>` ya lo puso `renderOsuList`.
    if (node.parent?.kind === 'list') return this.renderOsuItem(node)
    // Huérfano CON una lista por encima: el ítem cayó dentro de un box, un
    // notice o cualquier otro bloque que la lista se tragó, y osu! lo publica
    // igual como `<li>` — su propio paso de lista abre el `<ol>` justo antes
    // del primer ítem, así que esos ítems quedan dentro del bloque, en una
    // lista propia. Sin esto se pintaban como texto corrido, sin viñeta y sin
    // el salto de línea que osu! publica entre uno y otro
    // (`osu-cases/list-items-in-box`). La clase es la del `<ol>` que abre ese
    // paso: `unordered` sólo para el `[list]` pelado (medido con el harness).
    if (this.hasListAncestor(node)) {
      const open = this.osuListOrdered(this.nearestListAncestor(node)!) ? '<ol>' : '<ol class="unordered">'
      return `${open}${this.renderOsuItem(node)}</ol>`
    }
    // Un `[*]` sin `[list]` alrededor: osu! publica el `<li>` suelto y
    // HTMLPurifier lo desenvuelve (un `li` sólo vive dentro de `ul`/`ol`), así
    // que el texto queda corrido. Pintarlo como `<li>` lo volvía un bloque
    // propio en el preview.
    //
    // La pregunta es por el árbol, no por lo que haya abierto el render — el
    // renderer también pinta hijos sueltos (el reconciliador lo hace para
    // emparejar cada uno con su nodo), y ahí un contador diría que este ítem
    // está fuera de su lista.
    return this.renderChildren(node)
  }

  /**
   * La `[list]` más cercana por encima de `node`, si la hay. Es la que decide
   * si un `[*]` que no es hijo directo de una lista sigue siendo un ítem.
   */
  private nearestListAncestor(node: RedNode): RedNode | null {
    for (let p = node.parent; p !== null; p = p.parent) {
      if (p.kind === 'list') return p
    }
    return null
  }

  private hasListAncestor(node: RedNode): boolean {
    return this.nearestListAncestor(node) !== null
  }

  private renderCode(node: RedNode): string {
    let content = node.children.map(c => c.text || '').join('')
    // On a canvas the block is being written: the lines osu! would strip are
    // lines the caret can be on, and a last `\n` paints none of its own.
    if (this.options.terminalLines) {
      const tail = content.endsWith('\n') ? `<br ${TERMINAL_LINE_ATTR}>` : ''
      return `<pre${this.idAttr(node)}><code>${this.escapeHtml(content)}${tail}</code></pre>`
    }
    // osu! quirk: strip leading and trailing empty lines inside [code]
    const leadingMatch = content.match(/^(?:[\t ]*[\r\n])+/)
    if (leadingMatch) content = content.slice(leadingMatch[0].length)
    
    const trailingMatch = content.match(/(?:[\r\n][\t ]*)+$/)
    if (trailingMatch) content = content.slice(0, -trailingMatch[0].length)

    // Los saltos recortados arriba son de presentación: si no se anotan, el
    // camino HTML→BBCode los da por inexistentes y reescribe el bloque del
    // autor como `[code]…[/code]` en una sola línea.
    const pad = `${leadingMatch ? leadingMatch[0] : ''}\u0000${trailingMatch ? trailingMatch[0] : ''}`
    const padAttr = pad === '\u0000' ? '' : ` data-code-pad="${this.escapeHtml(JSON.stringify(pad))}"`
    return `<pre${this.idAttr(node)}${padAttr}><code>${this.escapeHtml(content)}</code></pre>`
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
  /**
   * The body osu! needs for an `[imagemap]` to become a map at all.
   *
   * Mirrors the inner regex of `BBCodeFromDB::parseImagemap` (`.+` does not
   * cross a newline there, `\s` does): `[imagemap]`, a newline, blank lines,
   * the URL on its own line (indented with ASCII whitespace — that line also
   * carries `\s*`), one or more `x y w h target [label]` lines with blank
   * lines allowed between them, blank lines, then the closer. Anything else
   * fails the pass and reaches the page as text.
   *
   * Written line by line instead of as one `RegExp` on purpose: transcribed
   * literally, the original is
   * `(?:\s*(?:[0-9.]+ ){4}(?:#|https?:\/\/[^\s]+|mailto:[^\s]+)(?: .*)?\n)+`
   * and a JS `RegExp` for it — no backtrack limit, unlike PHP's PCRE — runs
   * catastrophically on a body that ALMOST matches. `osu/14880483` (twelve
   * maps, several of them inline) never finished rendering: the first scan of
   * the corpus hung there for minutes, twice.
   */
  private static isOsuImagemapBody(rawText: string): boolean {
    const lines = `[imagemap]${rawText}[/imagemap]`.split('\n')
    // `^\[imagemap\]\n`: the body opens on the line AFTER the opener. Both the
    // image URL and the closer carry `\s*` in front (ASCII, like PCRE), so an
    // indented body still builds the map — `osu/14981802`, `osu/36631973`,
    // `osu/18579521`; ` [/imagemap]` is `osu-cases/imagemap-indented-closer`.
    if (lines[0] !== '[imagemap]' || !HTMLRenderer.isIndentedLine(lines[lines.length - 1], '[/imagemap]')) return false
    let i = 1
    const last = lines.length - 1
    while (i < last && HTMLRenderer.isBlankLine(lines[i])) i++
    if (i >= last || !HTMLRenderer.isHttpLine(lines[i])) return false
    i++
    // `(?<links>…)+`: at least one area; `\s*` between them allows blank lines.
    let areas = 0
    for (; i < last; i++) {
      if (HTMLRenderer.isBlankLine(lines[i])) continue
      if (!HTMLRenderer.isOsuImagemapAreaLine(lines[i])) return false
      areas++
    }
    return areas > 0
  }

  /** `\s` as PCRE means it here: ASCII whitespace only (JS `\s` also eats NBSP and friends). */
  private static isBlankLine(line: string): boolean {
    const n = line.length
    for (let i = 0; i < n; i++) {
      const c = line.charCodeAt(i)
      if (c !== 32 && c !== 9 && c !== 12 && c !== 11 && c !== 13) return false
    }
    return true
  }

  /** `^[ \t\f\v\r]*` + `text` + end — the closer's own shape. */
  private static isIndentedLine(line: string, text: string): boolean {
    const n = line.length
    let at = 0
    while (at < n) {
      const c = line.charCodeAt(at)
      if (c !== 32 && c !== 9 && c !== 12 && c !== 11 && c !== 13) break
      at++
    }
    return line.length - at === text.length && startsWithAt(line, text, at)
  }

  /** `^[ \t\f\v\r]*https?:\/\/.+` — the image URL line. */
  private static isHttpLine(line: string): boolean {
    const n = line.length
    let at = 0
    while (at < n) {
      const c = line.charCodeAt(at)
      if (c !== 32 && c !== 9 && c !== 12 && c !== 11 && c !== 13) break
      at++
    }
    return HTMLRenderer.hasScheme(line, at, 'https://') || HTMLRenderer.hasScheme(line, at, 'http://')
  }

  /** `text` at `at`, followed by at least one more character. */
  private static hasScheme(line: string, at: number, scheme: string): boolean {
    return line.length > at + scheme.length && startsWithAt(line, scheme, at)
  }

  /**
   * `(?:[0-9.]+ ){4}(?:#|https?:\/\/[^\s]+|mailto:[^\s]+)(?: .*)?`,
   * anchored at the line's first non-whitespace character.
   *
   * Read with char codes instead of five `RegExp.exec` calls and a `slice`
   * per field: this runs once per area line of every imagemap, and a page in
   * the corpus has 88 of them.
   */
  private static isOsuImagemapAreaLine(line: string): boolean {
    const n = line.length
    let at = 0
    while (at < n) {
      const c = line.charCodeAt(at)
      if (c !== 32 && c !== 9 && c !== 12 && c !== 11 && c !== 13) break
      at++
    }
    if (at === n) return false
    for (let field = 0; field < 4; field++) {
      const start = at
      while (at < n) {
        const c = line.charCodeAt(at)
        if ((c < 48 || c > 57) && c !== 46) break
        at++
      }
      if (at === start || line.charCodeAt(at) !== 32) return false
      at++
    }
    if (line.charCodeAt(at) === 35 /* # */) return true
    for (const scheme of ['https://', 'http://', 'mailto:']) {
      const from = at + scheme.length
      if (!startsWithAt(line, scheme, at) || from >= n) continue
      // `\S+`: the target runs to the next ASCII whitespace.
      let i = from
      while (i < n) {
        const c = line.charCodeAt(i)
        if (c === 32 || c === 9 || c === 12 || c === 11 || c === 13) break
        i++
      }
      return i > from
    }
    return false
  }

  private renderImagemap(node: RedNode): string {
    const rawText = this.collectNodeText(node)
    // osu! only publishes an imagemap whose body matches the shape its own pass
    // requires (`BBCodeFromDB::parseImagemap`, measured through the harness):
    // the opener followed by a newline, one line with the image URL, one or more
    // area lines, and the closer on its own line at the end. Any other shape is
    // left exactly as the author typed it — measured on
    // `docs/ai/osu-cases/imagemap-inline.bbcode`, whose body starts on the
    // opener's own line and comes out as literal text.
    if (this.isOsu() && !HTMLRenderer.isOsuImagemapBody(rawText)) {
      return `<span${this.idAttr(node)}>${this.escapeHtml(`[imagemap]${rawText}[/imagemap]`)}</span>`
    }
    const textLines = trimmedLines(rawText)

    if (textLines.length === 0) {
      return this.mediaError('imagemap', '[imagemap] missing image URL')
    }

    // Handles are for the editor's canvas (`lineHandles`); a published render
    // has none to carry. Building the map of line→leaf ANYWAY was a second
    // split/trim/filter of every line on every imagemap — the largest single
    // cost of the render pass — to compare a length that only matters when
    // handles are on.
    const wantsHandles = this.options.lineHandles === true &&
      (this.options.idMode ?? HTMLRenderer.idMode) !== 'none'
    let lineNodes: (RedNode | null)[] | null = null
    if (wantsHandles) {
      lineNodes = []
      for (const child of node.children) {
        if (child.kind !== 'text') continue
        const parts = trimmedLines(child.text || '')
        for (let k = 0; k < parts.length; k++) lineNodes.push(parts.length === 1 ? child : null)
      }
      if (lineNodes.length !== textLines.length) lineNodes = null
    }
    /**
     * An area's handle: the id of the line that defines it. Like a line's
     * `bb-line` wrapper, it is what the preview highlights when the caret is
     * on that line, and what a click on the area selects — and only emitted
     * where handles are asked for. The id is the line's own leaf, never the
     * map's: a repeated id is what made the canvas rewrite the whole document.
     */
    const handleOf = (i: number): string => {
      const leaf = lineNodes !== null ? lineNodes[i] : null
      return leaf ? ` data-node-id="${this.escapeHtml(leaf.id)}"` : ''
    }

    const imageUrl = textLines[0]
    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      return this.mediaError('imagemap', `[imagemap] invalid image URL: ${this.escapeHtml(imageUrl)}`)
    }

    let areas = ''
    for (let i = 1; i < textLines.length; i++) {
      const line = textLines[i]
      // Los campos se leen a mano. `split(/\s+/)` daba cinco cadenas y un
      // array por área, `parts.slice(5).join(' ')` una sexta: una línea de
      // imagemap es cinco campos y un rótulo, y así se lee sin array.
      const fields = HTMLRenderer.imagemapFields(line)
      if (fields === null) continue
      const { x, y, w, h, url, label } = fields

      if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) continue

      let areaUrl = url
      if (areaUrl && !areaUrl.startsWith('http://') && !areaUrl.startsWith('https://') && !areaUrl.startsWith('mailto:')) {
        areaUrl = 'https://' + areaUrl
      }

      if (this.isOsu()) {
        // osu posiciona por CSS (`.imagemap__link` ya es absolute), así que el
        // style inline lleva sólo las cuatro coordenadas. Un destino `#` no es
        // un enlace: emite un `span` con la misma clase, para que la zona siga
        // mostrando su `title` sin navegar a ninguna parte.
        const pos = `left:${x}%;top:${y}%;width:${w}%;height:${h}%;`
        const title = ` title="${this.escapeHtml(label)}"`
        const href = osuPurifiedHref(areaUrl)
        areas += url === '#'
          ? `<span${handleOf(i)} class="imagemap__link" style="${pos}"${title}></span>`
          : `<a${handleOf(i)} class="imagemap__link"${href ? ` href="${this.escapeHtml(href)}"` : ''} style="${pos}"${title}></a>`
        continue
      }
      // Nunca el id del mapa: una zona que lo repitiera daba dos elementos con
      // el mismo `data-node-id`, y el lienzo WYSIWYG, al ver ids duplicados,
      // reescribía el documento ENTERO en cada tecla. Solo el preview lleva
      // el de su propia línea (`handleOf`).
      areas += `<a${handleOf(i)} href="${this.escapeHtml(areaUrl)}" target="_blank" rel="noopener" class="imagemap-area bbcode-imap-area" style="position:absolute;left:${x}%;top:${y}%;width:${w}%;height:${h}%;" title="${this.escapeHtml(label || 'Link')}"></a>`
    }

    if (this.isOsu()) {
      return `<div${this.idAttr(node)} class="imagemap">` +
        `<img class="imagemap__image" loading="lazy" src="${this.escapeHtml(imageUrl)}" alt="">${areas}</div>`
    }

    return `<div${this.idAttr(node)} class="imagemap-container bbcode-imagemap" style="position:relative;display:inline-block;"><img src="${this.escapeHtml(imageUrl)}" alt="imagemap" style="max-width:100%;height:auto;display:block;">${areas}</div>`
  }

  /**
   * `«x» «y» «w» «h» «url» rótulo…` de una línea de `[imagemap]`, o `null`
   * cuando le faltan campos.
   *
   * El rótulo se junta con un solo espacio, como el `join(' ')` que había
   * aquí: si lo que sigue al destino ya viene sin espacios repetidos se toma
   * tal cual, y sólo cuando los tiene se colapsan.
   */
  private static imagemapFields(line: string): {
    x: number; y: number; w: number; h: number; url: string; label: string
  } | null {
    const n = line.length
    // The fields are read into scalars rather than through five little
    // `{ value, at }` objects: an area line is a legacy tab/space table and
    // this runs for every one of them, so the objects were pure garbage.
    let at = 0
    let field = 0
    let a = '', b = '', c = '', d = '', e = ''
    let labelAt = n
    while (field < 5) {
      let end = at
      while (end < n) {
        const ch = line.charCodeAt(end)
        if (ch === 32 || ch === 9) break
        end += 1
      }
      const value = line.slice(at, end)
      if (value === '') return null
      switch (field) {
        case 0: a = value; break
        case 1: b = value; break
        case 2: c = value; break
        case 3: d = value; break
        default: e = value
      }
      field++
      at = end
      while (at < n) {
        const ch = line.charCodeAt(at)
        if (ch !== 32 && ch !== 9) break
        at += 1
      }
      if (field >= 4) labelAt = at
    }
    let label = ''
    if (labelAt < n) {
      label = line.slice(labelAt)
      // `join(' ')`: only a run of separators needs the collapse.
      if (label.includes('  ') || label.includes('\t')) label = label.split(/[ \t]+/).join(' ')
    }
    return { x: parseFloat(a), y: parseFloat(b), w: parseFloat(c), h: parseFloat(d), url: e, label }
  }

  private collectNodeText(node: RedNode): string {
    if (node.kind === 'spacing' || node.kind === 'empty_line') return '\n'
    const children = node.children
    if (children && children.length > 0) {
      // Appending to one string, like `renderChildren`: the `.map().join('')`
      // allocated a closure and an array at every level of every subtree, and
      // this runs over whole imagemaps and `[profile]` bodies.
      let out = ''
      for (let i = 0; i < children.length; i++) out += this.collectNodeText(children[i])
      return out
    }
    return node.text || ''
  }

  /**
   * Effect parameters off a node, with every colour re-validated.
   *
   * `startsWith('#')` was NOT a filter: `#a" onmouseover="alert(1)` passes
   * it. Every stop has to survive the full colour allowlist or be dropped,
   * because these values end up inside a `style` attribute.
   */
  private effectParams(node: RedNode): EffectParams {
    const meta = (node.metadata ?? {}) as Record<string, unknown>
    const params: EffectParams = {}
    for (const [key, value] of Object.entries(meta)) {
      if (key === 'globalOffset' || key === 'documentLength') continue
      ;(params as Record<string, unknown>)[key] = value
    }

    if (Array.isArray(params.colors)) {
      params.colors = params.colors
        .map(c => (typeof c === 'string' ? sanitizeColor(c, this.tokenResolver) : null))
        .filter((c): c is string => c !== null)
      if (params.colors.length === 0) delete params.colors
    }
    if (Array.isArray(params.stops)) {
      params.stops = params.stops
        .filter(st => st && typeof st.color === 'string' && sanitizeColor(st.color, this.tokenResolver) !== null)
      if (params.stops.length === 0) delete params.stops
    }
    return params
  }

  /** Text inside an effect node, ignoring layout-only children. */
  /**
   * The plain text an effect modulates, line breaks included.
   *
   * A break is a childless `spacing` leaf carrying no text, so collecting
   * it naively contributes nothing and the effect sees one long line.
   * Every two-dimensional axis then collapses: `line` reports zero for
   * the whole block, `column` stretches one row across the paragraph, and
   * `radial` measures a rectangle one line tall. The break was being
   * dropped from the OUTPUT as well, so a multi-line effect previewed as
   * a single run-on line.
   *
   * The document's own plain text spells a break `\n` — that is what
   * `stripColorWrappers` and the studio's sampler both count — so this
   * agrees with them rather than inventing a third answer.
   */
  private effectText(node: RedNode): string {
    return node.children.map(c => this.effectChildText(c)).join('')
  }

  private effectChildText(node: RedNode): string {
    if (node.kind === 'spacing' || node.kind === 'empty_line') return '\n'
    if (node.kind === 'text') return node.text ?? ''
    if (node.children.length === 0) return this.collectNodeText(node)
    return node.children.map(c => this.effectChildText(c)).join('')
  }

  /**
   * The node behind each `\n` of `effectText`, in the same order (null for a
   * newline inside a text leaf, which has no node of its own).
   *
   * A painted break carries its node's id like every other `<br>`: after
   * Enter at the end of an effect, the WYSIWYG canvas opens the line that a
   * final `<br>` does not show (`revealLine`) by finding that break by id.
   * Without it the caret stayed on the line above.
   */
  private effectBreaks(node: RedNode, out: (RedNode | null)[] = []): (RedNode | null)[] {
    for (const c of node.children) {
      if (c.kind === 'spacing' || c.kind === 'empty_line') out.push(c)
      else if (c.kind === 'text' || c.children.length === 0) {
        const text = c.kind === 'text' ? c.text ?? '' : this.collectNodeText(c)
        for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(null)
      } else this.effectBreaks(c, out)
    }
    return out
  }

  /**
   * Paint an effect's computed segments as spans.
   *
   * Shared by rainbow, grow and any modulated gradient, so the preview
   * shows exactly the colours and sizes the BBCode export will contain
   * rather than an approximation of them.
   */
  private renderEffectSegments(node: RedNode, kind: EffectKind): string {
    const text = this.effectText(node)
    if (!text) return this.renderChildren(node)

    const meta = (node.metadata ?? {}) as Record<string, unknown>
    const segments = evaluateEffect(text, kind, this.effectParams(node), {
      globalOffset: meta.globalOffset as number | undefined,
      documentLength: meta.documentLength as number | undefined,
    })

    const breaks = text.indexOf('\n') === -1 ? [] : this.effectBreaks(node)
    let nextBreak = 0
    const br = () => {
      const owner = breaks[nextBreak++]
      if (owner && this.paintsTerminalLine(owner)) return this.terminalLine(owner)
      return owner ? `<br${this.idAttr(owner)}>` : '<br>'
    }

    let out = ''
    for (const seg of segments) {
      // The break is markup, not text: escaping it would print a newline
      // that HTML collapses to a space, which is how a painted block of
      // ASCII art would arrive as one unreadable line.
      // El `indexOf` delante: un degradado sin fusionar emite un segmento POR
      // CARÁCTER, y `/\n/g` es un literal —en ES2015+ eso asigna un objeto
      // nuevo cada vez que se evalúa— para recorrer una cadena de un carácter
      // que casi nunca es un salto de línea.
      const html = this.escapeHtml(seg.text)
      const escaped = html.indexOf('\n') === -1 ? html : html.replace(NEWLINE_RE, br)
      if (seg.color) {
        const safe = sanitizeColor(seg.color, this.tokenResolver)
        out += safe ? `<span style="color:${safe}">${escaped}</span>` : escaped
      } else if (seg.size !== undefined) {
        const ceiling = maxFontSizeFor(this.options.dialect) ?? 400
        out += `<span style="font-size:${Math.max(10, Math.min(ceiling, seg.size))}%">${escaped}</span>`
      } else {
        out += escaped
      }
    }
    // `bb-effect-${kind}`, not `bb-${kind}`: Lyne's text effects own the bare
    // names, and lyne.css styles `.bb-rainbow` globally with a clipped CSS
    // rainbow — every [rainbow] preview showed it fringing its own colours.
    return `<span${this.idAttr(node)} class="bb-effect bb-effect-${kind}">${out}</span>`
  }

  /**
   * A gradient previews as a real CSS gradient when it is a plain
   * left-to-right ramp, and as computed per-character spans otherwise.
   *
   * The CSS path is one span whatever the text: typing changes a text node
   * and the browser recolours it. Per-letter spans match osu!'s export
   * glyph for glyph, but every keystroke recoloured every letter, and the
   * Text Studio lagged while typing; speed won over that fidelity. A
   * gradient with a waveform, a non-index axis or quantisation steps cannot
   * be expressed in CSS, and is still per-character.
   *
   * Line breaks render like everywhere else, as `<br>` with their node id:
   * filtering them out showed a multi-line gradient as one line, and Enter
   * at its end never opened a new one.
   */
  private renderGradient(node: RedNode): string {
    const params = this.effectParams(node)

    if (isPlainGradient(params)) {
      const stops = params.stops && params.stops.length > 0
        ? params.stops.map(st => `${st.color} ${(st.position * 100).toFixed(1)}%`)
        : (params.colors ?? ['#FF0000', '#00FF00'])
      const list = stops.length === 1 ? [stops[0], stops[0]] : stops
      const gradientCss = `linear-gradient(to right, ${list.join(', ')})`
      /*
       * La caja del fondo mide lo que mide la tipografía del span, no sus
       * glifos: un `[size]` mayor dentro del degradado se sale por arriba y
       * por abajo y esas partes se imprimen transparentes (también en un
       * título de caja, que pinta su HTML con este mismo renderizador). El
       * padding crece con el tamaño más grande del subárbol; el margen
       * negativo devuelve el espacio horizontal para que el texto no se mueva.
       */
      const paintScale = maxFontSizeScale(node, this.tokenResolver)
      const paintY = +(0.5 * paintScale).toFixed(3)
      const paintX = +(0.3 * paintScale).toFixed(3)
      return `<span${this.idAttr(node)} style="background: ${gradientCss}; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; padding-block: ${paintY}em; padding-inline: ${paintX}em; margin-inline: -${paintX}em;">${this.renderChildren(node)}</span>`
    }

    return this.renderEffectSegments(node, 'gradient')
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
   * ¿Se linkifican aquí las URLs sueltas del texto?
   *
   * Solo bajo osu!, que es quien las enlaza al publicar, y nunca dentro de un
   * enlace ya hecho: anidar `<a>` dentro de `<a>` no es lo que osu! publica
   * (`[url]https://…[/url]` sale con un único ancla).
   */
  private get linkifiesOsuUrls(): boolean {
    return !this.linkifySuppressed && this.isOsu()
  }

  /**
   * Las URLs que osu! enlaza por su cuenta en el texto, con las mismas
   * fronteras que sus tres pasadas de `BBCodeForDB::parseLinks`: `http(s)` /
   * `ftp`, `www.`, y correos.
   *
   * La vecindad es la parte que no se puede adivinar: osu! exige que la URL
   * empiece el texto, siga a un tag (`[b:1]`) o venga tras un espacio — con
   * `<`.`.`:` `(` corchetes pegados incluidos — y que acabe el texto o quede
   * seguida de espacio, dejando fuera la puntuación final (`https://x/b.`
   * enlaza hasta la `b`). Por eso `xhttps://…` sigue siendo texto.
   *
   * Recibe HTML ya escapado (el de `escapeHtml`): el `href` queda con las
   * mismas entidades que el texto visible, como en osu!. La vecindad tiene DOS
   * mitades, las dos tomadas del texto plano: `context` es lo de delante (ya
   * pintado por otra hoja) y `forward` lo de detrás, la cola que el renderer
   * junta de las hojas hermanas siguientes. El target `[^\s]+?` de osu! puede
   * alargarse dentro de esa cola: `https://…[/url` sin cerrar acaba en el href,
   * así que la función devuelve cuántos caracteres ESCAPADOS de `forward` se
   * tragó el target — el renderer los descuenta de las hojas siguientes.
   */
  private static linkifyOsuUrls(html: string, context = '', forward = ''): { html: string; swallow: number } {
    if (html.indexOf('://') === -1 && html.indexOf('www.') === -1 && html.indexOf('@') === -1) return { html, swallow: 0 }
    const wrap = (prefix: string, target: string) => {
      const raw = target.startsWith('www.') ? `http://${target}`
        : target.includes(':') ? target
        : `mailto:${target}`
      // La URL suelta entra al href igual de cruda que en `parseLinks`: el
      // purificador es quien la publica.
      const href = osuPurifiedHref(raw)
      return `${prefix}<a${href ? ` href="${href}"` : ''} rel="nofollow">${target}</a>`
    }
    if (context === '' && forward === '') {
      return { html: html.replace(HTMLRenderer.OSU_LINK_RE, (whole, prefix: string, target: string) => wrap(prefix, target)), swallow: 0 }
    }
    const cut = context.length
    const leafEnd = cut + html.length
    const subject = context + html + forward
    const re = HTMLRenderer.OSU_LINK_RE
    re.lastIndex = 0
    let out = ''
    let cursor = cut
    let swallow = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(subject)) !== null) {
      const urlStart = m.index + m[1].length
      if (urlStart < cut) continue           // ya se pintó con la hoja anterior
      if (urlStart >= leafEnd) break         // empieza en la hoja siguiente
      const targetEnd = urlStart + m[2].length
      // El prefijo de la frontera puede empezar en el contexto: esa parte ya se
      // pintó, así que sólo se emite la que cae dentro de la hoja.
      const visibleFrom = m.index > cut ? m.index : cut
      out += subject.slice(cursor, visibleFrom) + wrap(subject.slice(visibleFrom, urlStart), m[2])
      if (targetEnd > leafEnd) {
        swallow = targetEnd - leafEnd         // caracteres escapados del forward
        cursor = leafEnd
        break
      }
      cursor = targetEnd
    }
    out += subject.slice(cursor, leafEnd)
    return { html: out, swallow }
  }

  /**
   * Cuántos caracteres de `raw` caen dentro del prefijo que una URL anterior
   * se tragó. El prefijo se midió sobre el texto de VARIAS hojas hermanas, así
   * que una hoja puede consumirlo entero, acabarlo, o quedarse corta.
   */
  private static swallowedPrefixLength(raw: string, swallowed: string): number {
    const n = raw.length < swallowed.length ? raw.length : swallowed.length
    let i = 0
    while (i < n && raw.charCodeAt(i) === swallowed.charCodeAt(i)) i++
    return i
  }

  /**
   * El prefijo CRUDO de `raw` cuyo `escapeHtml` mide `length` caracteres. El
   * escape es carácter a carácter (`&`→`&amp;`, `<`→`&lt;`, …), así que basta
   * con avanzar sumando longitudes.
   */
  private static rawEscapePrefix(raw: string, length: number): string {
    let escaped = 0
    let i = 0
    while (i < raw.length && escaped < length) {
      const code = raw.charCodeAt(i)
      escaped += code === 38 ? 5        // &
        : code === 60 || code === 62 ? 4  // < >
        : code === 34 ? 6                 // "
        : code === 39 ? 5                 // '
        : 1
      i++
    }
    return raw.slice(0, i)
  }

  /**
   * Los enlaces automáticos que NO acaban en su hoja de texto.
   *
   * `BBCodeForDB::parseLinks` corre al final, sobre el texto que todavía lleva
   * sus tags (`[b:1]` y compañía), así que el target de una URL puede cruzar
   * etiquetas y llegar hasta el final de la línea. Al publicarse,
   * `BBCodeFromDB` convierte esas etiquetas en HTML dentro del `href` y el
   * purificador corta el atributo en el primer `<`: el `href` es el texto
   * hasta el primer tag y el ancla se queda con TODO el target, tags incluidos
   * (medido: `https://a.example/x[/url][b]B[/b]TAIL` publica
   * `<a href="https://a.example/x%5B/url%5D">https://a.example/x[/url]<strong>B</strong>TAIL</a>`).
   *
   * El preview trabaja sobre el árbol ya tokenizado, así que la decisión se
   * toma sobre una proyección del texto tal como lo ve osu! (`osuProjection`),
   * y sólo para la forma que se puede pintar sin cortar un nodo: la URL empieza
   * en una hoja hija directa y el target termina al final de esa línea. La
   * etiqueta que corta el `href` tiene que serlo de verdad (un elemento), y el
   * texto literal `[/url]` de un cierre huérfano se queda dentro del `href`,
   * como en osu!.
   *
   * Devuelve, por índice de hijo, dónde empieza la URL dentro de la hoja, qué
   * `href` publica osu! y cuál es el último hijo que queda dentro del ancla.
   */
  private static osuSpanningLinks(parent: RedNode, children: readonly RedNode[]): Map<number, OsuSpanLink> | null {
    // Puerta barata: sin una URL escrita en una hoja directa y sin ningún tag
    // hermano, no hay nada que planificar.
    let urlText = false
    let tags = false
    for (const child of children) {
      if (child.children.length === 0 && child.kind === 'text') {
        const text = child.text
        if (text.includes('://') || text.includes('www.') || text.includes('@')) urlText = true
      } else if (HTMLRenderer.osuWritesTag(child)) {
        tags = true
      }
    }
    if (!urlText || !tags) return null

    const cap = HTMLRenderer.OSU_LINK_CONTEXT_MAX * 8
    const parentTag = HTMLRenderer.osuWritesTag(parent)
    let line = parentTag ? `[${parent.kind}]` : ''
    const leaves: { at: number; start: number; end: number }[] = []
    const tagStarts: number[] = []
    const childEnds: number[] = []
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      const at = line.length
      if (child.children.length === 0 && child.kind === 'text') {
        leaves.push({ at: i, start: at, end: at + child.text.length })
        line += child.text
      } else if (HTMLRenderer.OSU_LINK_NEWLINE_KINDS.has(child.kind)) {
        line += '\n'
      } else {
        if (HTMLRenderer.osuWritesTag(child)) tagStarts.push(at)
        line += HTMLRenderer.osuProjection(child, cap - line.length)
      }
      childEnds.push(line.length)
      if (line.length > cap) return null
    }
    const lineEnd = line.length
    // El cierre del contenedor también es texto para `parseLinks`. Si el target
    // acabara justo en `lineEnd` lo tendría que incluir, y entonces el ancla
    // saldría del ámbito que este método sabe pintar.
    if (parentTag) line += `[/${parent.kind}]`

    const spans = new Map<number, OsuSpanLink>()
    const re = HTMLRenderer.OSU_LINK_RE
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      const start = m.index + m[1].length
      const end = start + m[2].length
      // El target puede acabar al final de la línea, en el salto que la cierra
      // o en medio de una hoja (una segunda URL detrás, `TAIL https://…`).
      // Fuera de esos tres sitios el cierre caería dentro de un tag y el
      // purificador repara la estructura a su manera; no se planifica.
      if (end > lineEnd) continue
      let leaf: { at: number; start: number; end: number } | undefined
      for (const candidate of leaves) {
        if (start >= candidate.start && start < candidate.end) { leaf = candidate; break }
      }
      if (leaf === undefined) continue
      // El `href` corta en el primer tag que `BBCodeFromDB` convierte en HTML.
      let firstTag = -1
      for (const at of tagStarts) {
        if (at > start && at < end) { firstTag = at; break }
      }
      if (firstTag < 0) continue
      let endsAt = -1
      let endOffset: number | undefined
      for (const candidate of leaves) {
        if (end > candidate.start && end < candidate.end) {
          endsAt = candidate.at
          endOffset = end - candidate.start
          break
        }
      }
      if (endsAt < 0) {
        if (end !== lineEnd && line[end] !== '\n') continue
        for (let i = 0; i < childEnds.length; i++) if (childEnds[i] <= end) endsAt = i
      }
      if (endsAt <= leaf.at) continue
      spans.set(leaf.at, { offset: start - leaf.start, href: osuPurifiedHref(line.slice(start, firstTag)), endsAt, endOffset })
    }
    return spans.size === 0 ? null : spans
  }

  /**
   * El texto que un subárbol aporta a la cadena que ve `parseLinks`: el texto
   * de sus hojas, un `\n` por salto y sus tags escritos como corchetes. Los
   * tags fabricados no son los mismos que osu! (`[b]` aquí, `[b:1]` allí),
   * pero la forma —cada `[` y su `]`, sin espacios— es la que decide el
   * regex, y el sufijo `:uid` no añade corchetes ni espacios.
   */
  private static osuProjection(node: RedNode, budget: number): string {
    if (budget <= 0) return ''
    if (node.children.length === 0) {
      if (node.kind === 'text') return node.text.slice(0, budget)
      if (HTMLRenderer.OSU_LINK_NEWLINE_KINDS.has(node.kind)) return '\n'
      return ''
    }
    if (!HTMLRenderer.osuWritesTag(node)) {
      let out = ''
      for (const child of node.children) {
        if (out.length >= budget) break
        out += HTMLRenderer.osuProjection(child, budget - out.length)
      }
      return out
    }
    let out = `[${node.kind}]`
    for (const child of node.children) {
      if (out.length >= budget) break
      out += HTMLRenderer.osuProjection(child, budget - out.length)
    }
    return out + `[/${node.kind}]`
  }

  /** ¿Este nodo deja un tag en el texto de osu! (y un `<` al publicarse)? */
  private static osuWritesTag(node: RedNode): boolean {
    return node.children.length > 0
      && !HTMLRenderer.OSU_LINK_TRANSPARENT_KINDS.has(node.kind)
      && node.kind !== 'box_tail'
  }

  /**
   * Una URL suelta dentro de texto ya escapado, con las fronteras de osu!.
   *
   * `(^|[tag]|espacio+puntuación)` delante y `puntuación* ($|espacio)` detrás,
   * las dos tomadas de `BBCodeForDB::parseLinks`. El tag de la frontera es su
   * `\[.+?\]`: `[`, al menos un carácter y `]`, sin cruzar jamás un `\n` —
   * `[a⏎b]` no es un tag para la pasada y `[]` tampoco (medido: con el salto
   * dentro el autolink no ocurre, y un `[]` no cierra la frontera). El espacio
   * es el de PCRE sin `/u`, que NO es el de JavaScript: U+00A0 y U+3000 son
   * CONTENIDO para osu! (`pre https://a.example/x　TAIL` publica el espacio
   * ideográfico dentro del href).
   */
  /** La primera ancla real de un HTML: `<a ` o `<a>`, nunca `<audio`. */
  private static readonly ANCHOR_AT = /<a[\s>]/

  /** Cuánto texto de la hoja anterior basta como vecindad (`[… ]`, espacios, puntuación). */
  private static readonly OSU_LINK_CONTEXT_MAX = 512

  /**
   * El texto que osu! ve DETRÁS de `children[index]`, hasta el primer salto o
   * elemento: `parseLinks` decide con esa cola si el target de una URL se
   * alarga dentro de la hoja siguiente. Un `spacing`/`empty_line` aporta su
   * `\n` y corta — un tag no cruza un salto y el target no puede contenerlo —,
   * y cualquier otra cosa (un tag, un elemento) corta también.
   *
   * El resultado se indexa por hijo: se calcula de atrás hacia delante una vez
   * por padre y así ninguna hoja recorre sus hermanas.
   */
  private static osuForwardContexts(children: readonly RedNode[]): string[] {
    const cap = HTMLRenderer.OSU_LINK_CONTEXT_MAX
    const out = new Array<string>(children.length)
    let after = ''
    for (let i = children.length - 1; i >= 0; i--) {
      out[i] = after
      const child = children[i]
      if (child.children.length !== 0) {
        after = ''
      } else if (child.kind === 'text' && child.text) {
        after = after.length >= cap ? after : (child.text + after).slice(0, cap)
      } else if (HTMLRenderer.OSU_LINK_NEWLINE_KINDS.has(child.kind)) {
        after = '\n'
      } else {
        after = ''
      }
    }
    return out
  }

  /**
   * Lo que el texto de osu! lleva delante de la próxima hoja: la cola de la
   * anterior, o el salto que las separa. La cadena vacía es "sin vecindad":
   * un tag delante, o el principio del texto.
   */
  private osuLinkContext = ''

  /**
   * La otra mitad: lo que lleva DETRÁS la próxima hoja, calculado por el padre
   * (`osuForwardContexts`) y consumido por `renderNode`. Sólo es vecindad para
   * la hoja de texto a la que se le asignó; nadie más la hereda.
   */
  private osuLinkForward = ''

  /**
   * El principio de las hojas siguientes que una URL ya pintada se tragó
   * (`osuLinkForward`): el renderer lo descuenta de su texto para no pintarlo
   * dos veces.
   */
  private osuLinkSwallow = ''

  /**
   * Kinds the parser groups lines into; the text has no tag of its own there,
   * so the link neighborhood crosses them as it crosses the flat text.
   */
  private static readonly OSU_LINK_TRANSPARENT_KINDS: ReadonlySet<string> = new Set(['document', 'paragraph'])

  /** Kinds that are a newline in the text `parseLinks` runs on. */
  private static readonly OSU_LINK_NEWLINE_KINDS: ReadonlySet<string> = new Set(['spacing', 'empty_line'])

  private static readonly OSU_LINK_RE =
    /(^|\[[^\n]+\]|[ \t\n\r\f\v](?:&lt;|[.:(\[])*)((?:https?|ftp):\/\/[^ \t\n\r\f\v]+?|www\.[^ \t\n\r\f\v]+?|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z-]+)(?=(?:\[[^\n]+\]|&gt;|[.:)\]])*(?:$|[ \t\n\r\f\v]))/g

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

/**
 * Whether a gradient is a plain left-to-right ramp.
 *
 * Only then can CSS express it. Anything with a waveform, a non-index
 * axis, quantisation, inversion or per-word stepping has to be painted
 * per character instead, or the preview and the export disagree.
 */
function isPlainGradient(params: EffectParams): boolean {
  // A tag carrying a span is one fragment of a longer ramp. Painting it
  // as a full-width CSS gradient restarts the sweep inside every
  // fragment, which is exactly the discontinuity the span exists to fix.
  if (params.documentLength !== undefined && params.documentLength > 1) return false
  return (params.wave === undefined || params.wave === 'none')
    && (params.axis === undefined || params.axis === 'index')
    && (params.easing === undefined || params.easing === 'linear')
    && (params.steps === undefined || params.steps < 2)
    && !params.invert
    && (params.unit === undefined || params.unit === 'character')
    && (params.cycles === undefined || params.cycles === 1)
    && (params.phase === undefined || params.phase === 0)
    && (params.expression === undefined || params.expression === '')
}
