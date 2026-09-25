/**
 * DocumentEngine — BBCodeExporter
 *
 * Exports the Document Model / Red Tree back to BBCode text.
 * This is how the internal representation becomes editable text.
 *
 * Uses the TagRegistry to determine how each node serializes.
 * Plugins can register custom serializers for custom tags.
 */

import { RedNode } from '../Syntax/RedNode'
import { Visitor } from './Visitor'
import type { VisitorContext } from './Visitor'
import { TagRegistry, type TagDefinition } from '../Model/TagRegistry'
import { clampFontSizeValue } from '../Utils/FontSizeLimits'
import { OsuSemanticModel } from '../Semantic/osu/OsuSemanticModel'
import { parseBBCode } from '../BBCode/Parser'
import { greenToRedNode } from '../BBCode/BBCodeToGreenNode'
import { resolveEditConflicts } from '../Edits/EditPlan'
import { applyEditsToSource } from '../Edits/applyEdits'
import { FlattenOsuNestingRule } from '../Edits/Rules/flattenOsuNesting'
import { mayHaveSameNameNesting } from './sameNameNestingGate'
import {
  toTokenResolver,
  resolveTokenValue,
  type TokenResolverFn,
  type TokenSource,
} from '../Tokens'

/**
 * Export target for BBCodeExporter.
 * - 'osu': Expands Miliastry/Lyne-native tags into osu!-compatible BBCode.
 * - 'miliastry': Preserves Miliastry-native tags as-is for round-trip editing.
 * - 'lyne': Preserves Lyne-native tags as-is for round-trip editing.
 */
export type ExportTarget = 'osu' | 'miliastry' | 'lyne'

export interface BBCodeExporterOptions {
  registry?: TagRegistry
  target?: ExportTarget
  tokens?: TokenSource
  resolveTokens?: boolean
}

export type BBCodeExportOptions = {
  target?: ExportTarget
  tokens?: TokenSource
  resolveTokens?: boolean
}

/**
 * Referencia a un token de diseño dentro de un texto: `$nombre`.
 *
 * A nivel de módulo porque el sitio caliente es la rama de nodo TEXTO, la
 * clase de nodo más frecuente de cualquier documento: un literal de expresión
 * regular ahí dentro construye un `RegExp` por nodo. Había además tres copias
 * idénticas del mismo patrón repartidas por el fichero.
 */
const TOKEN_REF_RE = /\$([a-zA-Z_][a-zA-Z0-9_-]*)/g

/** Sustituye cada `$token` por su valor; deja intacto el que no resuelva. */
function expandTokenRefs(text: string, resolve: TokenResolverFn): string {
  // `indexOf` antes que `replace`: la inmensa mayoría de los textos no lleva
  // ningún `$`, y así no se pone en marcha el motor de expresiones regulares.
  if (text.indexOf('$') === -1) return text
  return text.replace(TOKEN_REF_RE, (match, name: string) => {
    const resolved = resolve(name) ?? resolve(match)
    return resolved !== undefined ? resolved : match
  })
}

/**
 * Rewrites `osu`-target export text so it never publishes a same-name tag
 * nested inside an identical one — osu!'s per-family lazy pairing mangles
 * that (see `Edits/Rules/flattenOsuNesting.ts`'s doc comment). Re-parses the
 * ALREADY-EXPORTED text (never the source document — `quasar-exporter-no-
 * trivia`'s whole-document-rewrite warning is about the SOURCE, and this
 * text has no author spelling left to lose) with the widest dialect so every
 * tag the exporter could have produced is recognised, runs the rule, and
 * applies its edits. A parse failure (should not happen against Quasar's own
 * export output) fails safe by returning the text untouched rather than
 * throwing out of `export()`.
 *
 * Also hands the rule a THUNK that builds a RedNode view of that SAME parse
 * (`greenToRedNode`, no store — this is a one-off read, not a document the
 * incremental parser will ever touch again) on demand, plus an `osu`
 * {@link OsuSemanticModel} of that same tree, so a dropped
 * BLOCK tag (`center`/`left`/`right`/`heading`) can reconcile the newlines it
 * used to eat against `NEWLINE_RULES` — see `FlattenOsuNestingRule.
 * fixupBlockNewlines`'s own doc comment. A thunk, not the tree itself: most
 * exports have no block-kind same-name nesting at all, and building it
 * unconditionally cost the 547 KB fixture roughly 15× its export budget
 * (`export.perf.test.ts`) for documents that never needed it.
 *
 * Deliberately just this one rule, not the general-purpose cleanup rules
 * (`MergeAdjacentRule`, `ReorderWrappersRule`, …) an earlier version also
 * ran afterward to settle an empty-tag seam a split could leave. Those rules
 * act on the WHOLE document, not just the seam this rule touched, and they
 * reorder/merge tags this rule never came near (`MilHibri.test.ts` caught
 * this: an untouched, author-ordered `[color][b]…[/b][/color]` came back
 * silently reordered to `[b][color]…[/color][/b]`). Changing export output
 * the product rule never asked to change is worse than leaving a rare
 * artifact, so that empty-seam case is instead handled locally, inside
 * `emitSplit` itself (deleting the ancestor's own delimiter on a side with
 * nothing else, rather than duplicating it into an empty pair).
 */
function flattenOsuUnsupportedNesting(source: string): string {
  if (!source || !mayHaveSameNameNesting(source)) return source
  let root
  try {
    // 'osu', not 'lyne': this text was JUST produced for target 'osu', so
    // every tag in it is already one osu! recognises. Re-parsing with the
    // wider 'lyne' dialect would be more permissive but is also incomplete
    // for plain BBCode tags that only exist in the osu!/miliastry table —
    // `left` is one (`OSU_TAG_TO_KIND_ENTRIES` has it, `LYNE_CANONICAL_TAG_TO_KIND`
    // does not), and re-parsing it as 'lyne' would silently leave `[left]`
    // as literal text instead of a tag this rule needs to see.
    root = parseBBCode(source, { dialect: 'osu' })
  } catch {
    return source
  }
  const proposed = new FlattenOsuNestingRule({ redRoot: () => greenToRedNode(root), semantic: new OsuSemanticModel('osu') }).run({ source, root })
  if (proposed.length === 0) return source
  const plan = resolveEditConflicts(proposed, source.length)
  return applyEditsToSource(source, plan.accepted)
}

// Module-level on purpose: `exportChildren` runs once per node with children,
// and closures created there were a measurable share of a full export.
function isGhostKind(n: RedNode): boolean {
  return n.kind === 'discarded_tag' || n.kind === 'discarded_box_close'
}

function isNewlineKind(n: RedNode): boolean {
  return n.kind === 'spacing' || n.kind === 'empty_line'
}

/** Miliastry-native effect tags that osu! doesn't support natively */
const MILIASTRY_INTERNAL_TAGS = new Set(['gradient', 'grow', 'sinewave', 'rainbow', 'paint'])

/**
 * Tags que existen SOLO en Miliastry (registrados en el TagRegistry) y que
 * osu! NO renderiza. Si un usuario pega `[shadow]`/`[zalgo]`/etc. en osu!,
 * el texto sale roto (los corchetes se ven literalmente). Cuando el target
 * es 'osu', estos tags se DEGRADAN a su contenido plano: mejor perder el
 * efecto que romper la userpage. El target 'miliastry' los conserva.
 */
export const MILIASTRY_ONLY_TAGS = new Set([
  'font', 'zalgo', 'aesthetic', 'sparkle', 'bubble', 'flower', 'svg', 'group',
])

export const LYNE_ONLY_TAGS = new Set([
  'boxw', 'wnotice', 'tables', 'table_row', 'table_col', 'table_th', 'gallery', 'columns',
  'separator', 'scroll', 'sup', 'sub', 'abbr', 'mark', 'kbd', 'tooltip', 'flip',
  'raw', 'plain', 'guild', 'map', 'align', 'effect', 'anim', 'container', 'style_tag',
  'neon', 'shimmer', 'glitch', 'typewriter', 'wave', 'fire', 'ice', 'ghost', 'glow',
  'outline', 'emboss', 'engrave', 'pulse', 'bounce', 'shake', 'levitate', 'fade-in', 'fade-out',
  'card', 'glass', 'neon-box', 'square', 'row', 'col', 'th',
])

/**
 * kind → BBCode tag name, in the osu! spelling (`centre`, `youtube`).
 *
 * Module-level on purpose: this used to be an object literal inside
 * `kindToTagName`, which allocated a fresh 30-key object for every node of
 * every export. Note it is NOT interchangeable with `nodeKindToTag` from
 * `BBCodeToGreenNode` — that map inverts the parser's table, where the last
 * spelling registered wins (`center`), while exports must emit osu!'s.
 */
const KIND_TO_TAG_NAME: Record<string, string> = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
  strikethrough: 's',
  color: 'color',
  font_size: 'size',
  font: 'font',
  inline_code: 'c',
  code: 'code',
  spoiler: 'spoiler',
  center: 'centre',
  left: 'left',
  right: 'right',
  heading: 'heading',
  notice: 'notice',
  wnotice: 'wnotice',
  url: 'url',
  email: 'email',
  profile: 'profile',
  guild: 'guild',
  map: 'map',
  image: 'img',
  video: 'youtube',
  audio: 'audio',
  imagemap: 'imagemap',
  quote: 'quote',
  spoilerbox: 'spoilerbox',
  box: 'box',
  boxw: 'boxw',
  list: 'list',
  list_item: '*',
  zalgo: 'zalgo',
  aesthetic: 'aesthetic',
  sparkle: 'sparkle',
  bubble: 'bubble',
  flower: 'flower',
  gradient: 'gradient',
  grow: 'grow',
  rainbow: 'rainbow',
  sinewave: 'sinewave',
  paint: 'paint',
  align: 'align',
  tables: 'tables',
  table_row: 'row',
  table_col: 'col',
  table_th: 'th',
  row: 'row',
  col: 'col',
  th: 'th',
  gallery: 'gallery',
  columns: 'columns',
  separator: 'separator',
  scroll: 'scroll',
  sup: 'sup',
  sub: 'sub',
  abbr: 'abbr',
  mark: 'mark',
  kbd: 'kbd',
  tooltip: 'tooltip',
  flip: 'flip',
  raw: 'raw',
  plain: 'plain',
  effect: 'effect',
  anim: 'anim',
  container: 'container',
  style_tag: 'style',
  neon: 'neon',
  shimmer: 'shimmer',
  glitch: 'glitch',
  typewriter: 'typewriter',
  wave: 'wave',
  fire: 'fire',
  ice: 'ice',
  ghost: 'ghost',
  glow: 'glow',
  outline: 'outline',
  emboss: 'emboss',
  engrave: 'engrave',
  pulse: 'pulse',
  bounce: 'bounce',
  shake: 'shake',
  levitate: 'levitate',
  'fade-in': 'fade-in',
  'fade-out': 'fade-out',
  card: 'card',
  glass: 'glass',
  'neon-box': 'neon-box',
  square: 'square',
}


/**
 * Whether a parsed attribute actually carries a value worth re-emitting.
 *
 * The parser stores an empty string for the attribute of a bare tag, so a
 * plain `[box]` arrives here with `rawTitle: ''` rather than `undefined`.
 * The guards below used to test `!== undefined`, which an empty string
 * passes — exporting `[box]` as `[box=]` and `[quote]` as `[quote=""]`.
 * Both are corruption, not normalization: bare boxes and quotes are
 * ordinary BBCode and must round-trip untouched.
 */
function hasAttrValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value) !== ''
}

/**
 * Expande un cuerpo hexadecimal a los 6 dígitos que exige osu, o `null` si no
 * es un hex de longitud reconocible (3, 4, 6 u 8).
 *
 * El canal alfa se descarta a propósito: osu no soporta transparencia en
 * ninguna forma, así que la alternativa a perderlo es publicar un `[color=…]`
 * que su parser rechaza y deja como texto literal en la página.
 */
function expandHexForOsu(body: string): string | null {
  // La longitud se mira antes que los dígitos, y los dígitos a mano: este
  // camino corre una vez por `[color]`, y en páginas con degradados eso son
  // decenas de miles de veces por exportación. El regex `^[0-9a-fA-F]+$` era
  // ~1 ms del export a osu! sobre el fixture de 547 KB.
  const length = body.length
  if (length !== 3 && length !== 4 && length !== 6 && length !== 8) return null
  for (let i = 0; i < length; i++) {
    const c = body.charCodeAt(i)
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) return null
  }
  switch (length) {
    case 3:
      return body[0] + body[0] + body[1] + body[1] + body[2] + body[2]
    case 4:
      // RGBA corto: expandimos RGB y tiramos el alfa.
      return body[0] + body[0] + body[1] + body[1] + body[2] + body[2]
    case 6:
      // Ya es legal: se devuelve tal cual, sin tocar mayúsculas del autor.
      return body
    case 8:
      // RGBA largo: los dos últimos dígitos son el alfa.
      return body.slice(0, 6)
    default:
      return null
  }
}

/**
 * `target` decide si además de convertir `rgb()` hay que adaptar el hex a la
 * gramática de osu (`BBCodeForDB::parseColour`), que sólo acepta `#` + 6
 * dígitos hex o una secuencia puramente alfabética. Para 'miliastry' y 'lyne'
 * el comportamiento es el de siempre: no se reescribe nada.
 */
function normalizeColorToHex(color: string, target: ExportTarget = 'miliastry'): string {
  if (!color) return color
  const trimmed = color.trim()
  // Un hex ya es canónico: bajarlo a minúsculas reescribía `[color=#FF0000]`
  // del autor en cada exportación, y `Analysis/RoundTrip` fija lo contrario.
  if (trimmed.startsWith('#')) {
    if (target !== 'osu') return trimmed
    const expanded = expandHexForOsu(trimmed.slice(1))
    return expanded === null ? trimmed : `#${expanded}`
  }

  const rgbMatch = trimmed.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i)
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10).toString(16).padStart(2, '0')
    const g = parseInt(rgbMatch[2], 10).toString(16).padStart(2, '0')
    const b = parseInt(rgbMatch[3], 10).toString(16).padStart(2, '0')
    return `#${r}${g}${b}`.toLowerCase()
  }

  // Hex desnudo: osu exige el `#`, así que `ff0000` se publicaría roto. Sólo
  // lo tratamos como hex si trae algún dígito; una palabra puramente
  // alfabética (`red`, y también `beef`, que es hex válido) ya matchea la
  // alternativa alfabética de osu y no hay que tocarla.
  if (target === 'osu' && /\d/.test(trimmed)) {
    const expanded = expandHexForOsu(trimmed)
    if (expanded !== null) return `#${expanded}`
  }

  return trimmed
}

export class BBCodeExporter extends Visitor<string> {
  private registry: TagRegistry
  private depth: number = 0
  private target: ExportTarget
  private tokens?: TokenSource
  private tokenResolver?: TokenResolverFn
  private explicitResolveTokens?: boolean
  /**
   * El resolvedor a aplicar en ESTE recorrido, o `null` si no hay expansión.
   *
   * Se decide una vez en `visit`, no por nodo: `shouldResolveTokens()` da la
   * misma respuesta para todo el documento, y se estaba llamando en la rama
   * de nodo texto, la más frecuente que hay.
   */
  private expandTokens: TokenResolverFn | null = null

  /**
   * What the tree being exported means under osu!'s rules — the ONE place the
   * stranded-closer newline budget lives (`Semantic/osu`). `BBCodeExporter`
   * never repeats that table: a `discarded_tag`/`discarded_box_close` leaf's
   * own bracket never survives export (see `exportNode`'s first line), so
   * nothing is left in the exported text to do the eating osu!'s render did
   * invisibly — `exportChildren` asks the model which of a dropped ghost's
   * neighbour newlines osu! swallowed, and drops those same newlines as
   * literal text instead. One model per `visit()`: a model answers for one
   * tree snapshot, and it is built only when a ghost actually shows up.
   */
  private semantic: OsuSemanticModel | null = null

  private semanticModel(): OsuSemanticModel {
    if (this.semantic === null) {
      // The model's dialect follows the renderer's constructor default:
      // 'osu' and 'lyne' are exact, every other target reads as 'miliastry'.
      const dialect = this.target === 'osu' || this.target === 'lyne' ? this.target : 'miliastry'
      this.semantic = new OsuSemanticModel(dialect)
    }
    return this.semantic
  }

  constructor(
    registryOrOptions?: TagRegistry | BBCodeExporterOptions,
    target: ExportTarget = 'osu',
    options?: BBCodeExporterOptions | { tokens?: TokenSource; resolveTokens?: boolean },
  ) {
    super()
    if (registryOrOptions && !(registryOrOptions instanceof TagRegistry) && !('get' in registryOrOptions)) {
      const opts = registryOrOptions as BBCodeExporterOptions
      this.registry = opts.registry ?? new TagRegistry()
      this.target = opts.target ?? 'osu'
      this.tokens = opts.tokens
      this.tokenResolver = toTokenResolver(opts.tokens)
      this.explicitResolveTokens = opts.resolveTokens
    } else {
      this.registry = (registryOrOptions as TagRegistry) ?? new TagRegistry()
      this.target = target
      if (options) {
        this.tokens = options.tokens
        this.tokenResolver = toTokenResolver(options.tokens)
        this.explicitResolveTokens = options.resolveTokens
      }
    }
  }

  /**
   * Set the export target. Controls how Miliastry-native tags are serialized.
   */
  setTarget(target: ExportTarget): void {
    this.target = target
  }

  setTokens(tokens?: TokenSource): void {
    this.tokens = tokens
    this.tokenResolver = toTokenResolver(tokens)
  }

  getTokens(): TokenSource | undefined {
    return this.tokens
  }

  getTokenResolver(): TokenResolverFn | undefined {
    return this.tokenResolver
  }

  private shouldResolveTokens(): boolean {
    if (this.explicitResolveTokens !== undefined) {
      return this.explicitResolveTokens
    }
    return this.target === 'osu'
  }

  /**
   * Export a RedNode tree to BBCode.
   */
  visit(node: RedNode, context?: VisitorContext): string {
    if (context) this.context = context
    this.depth = 0
    this.semantic = null
    this.expandTokens =
      this.tokenResolver !== undefined && this.shouldResolveTokens() ? this.tokenResolver : null
    return this.exportNode(node)
  }

  /**
   * Export the entire document to BBCode.
   * Optionally override the export target or options for this specific call.
   */
  export(
    root: RedNode,
    targetOrOptions?: ExportTarget | BBCodeExportOptions,
    options?: BBCodeExportOptions,
  ): string {
    if (typeof targetOrOptions === 'string') {
      this.target = targetOrOptions
      if (options?.tokens !== undefined) {
        this.setTokens(options.tokens)
      }
      if (options?.resolveTokens !== undefined) {
        this.explicitResolveTokens = options.resolveTokens
      }
    } else if (targetOrOptions && typeof targetOrOptions === 'object') {
      if (targetOrOptions.target !== undefined) {
        this.target = targetOrOptions.target
      }
      if (targetOrOptions.tokens !== undefined) {
        this.setTokens(targetOrOptions.tokens)
      }
      if (targetOrOptions.resolveTokens !== undefined) {
        this.explicitResolveTokens = targetOrOptions.resolveTokens
      }
    }
    const raw = this.visit(root)
    // osu! cannot nest a tag inside an identical one (see
    // `Edits/Rules/flattenOsuNesting.ts`'s doc comment and the
    // `quasar-nested-color-is-supported` memory) — every other target is
    // untouched, so this can never change what the default preview shows.
    return this.target === 'osu' ? flattenOsuUnsupportedNesting(raw) : raw
  }

  /**
   * Exporta los hijos directos y los concatena.
   *
   * Reemplaza el `children.map(...).join('')`, que asignaba un cierre y un
   * array intermedio de N cadenas en cada nivel del árbol. `HTMLRenderer`
   * hizo este mismo cambio y dejó la nota; el exportador se quedó atrás, y es
   * el camino que corre bajo un límite de 60.000 caracteres.
   */
  /**
   * A `discarded_tag`/`discarded_box_close` ghost's own bracket never
   * reaches the exported text (`exportNode`'s first line drops it outright —
   * a stray closer that closed nothing must not come back as a live tag on
   * the next parse). osu's render still spent that ghost's own newline
   * budget invisibly, though, so a newline this pass left untouched would
   * surface as a `<br>` the default preview never showed.
   *
   * The naive fix — drop every newline the render swallowed near a ghost —
   * double-spends. Ghosts contribute zero bytes to the export, so a REAL
   * closer that used to sit behind one or more ghosts can end up genuinely,
   * byte-adjacent to newlines that ghost used to buffer it from; that real
   * closer's grammar has no memory of the ghost, so once osu re-parses the
   * exported text it spends its OWN `afterClose` budget against whatever is
   * next to it now, for free — whether this method drops anything or not.
   * Explicitly dropping a newline the render swallowed only because a ghost
   * ATE IT ITSELF (rather than one that just happened to sit past a
   * NATURALLY-still-swallowed seam) eats it a second time, and shifts every
   * following newline one slot closer to that real closer's reach too
   * (measured on `docs/ai/examples/perfil sarou.txt`: a `[heading]` ghost's
   * own budget explicitly dropped its one newline, and the real `[centre]`
   * it used to stand in front of then ate the NEXT one for free, erasing a
   * line break the default preview keeps).
   *
   * So this walks children in MERGED REGIONS — a maximal run of
   * `spacing`/`empty_line`/`discarded_tag`/`discarded_box_close` nodes
   * bounded by real content on both sides, since consecutive ghosts
   * contribute no bytes and their surrounding newline runs physically
   * concatenate in the export the instant those ghosts vanish — and asks two
   * separate questions per region: how many of its newlines, from the
   * START, will the nearest REAL closer before it eat for free after
   * export (`naturalCount`, from the SAME `NEWLINE_RULES` table via
   * {@link OsuSemanticModel.closingBudget}); and, per newline, did osu's render
   * swallow it at all ({@link OsuSemanticModel.isNewlineSwallowed}, the
   * exact verdict the default preview used). Only a swallowed newline PAST
   * `naturalCount` needs dropping here — one within it is already spoken
   * for, and dropping it too would just shove the next one into the reach
   * that free consumption leaves behind.
   */
  private exportChildren(node: RedNode): string {
    const children = node.children

    let out = ''
    // The node before the current region. Its closing budget is only needed
    // when a ghost follows, which is rare, so it is resolved lazily: asking
    // the model for every child made the whole export ~4× slower.
    let pendingRealChild: RedNode | null = null
    let i = 0
    while (i < children.length) {
      const child = children[i]
      const kind = child.kind
      if (kind === 'spacing' || kind === 'empty_line' || kind === 'discarded_tag' || kind === 'discarded_box_close') {
        // One read of `kind` per child and no array for the region: this loop
        // sees every newline between two texts, and slicing each region just
        // to look for a ghost was a steady allocation on every export.
        const regionStart = i
        let hasGhost = false
        while (i < children.length) {
          const regionKind = children[i].kind
          if (regionKind === 'discarded_tag' || regionKind === 'discarded_box_close') hasGhost = true
          else if (regionKind !== 'spacing' && regionKind !== 'empty_line') break
          i++
        }

        // No ghost anywhere in this region: nothing was dropped from the
        // exported text here, so there is nothing for a real tag to newly
        // re-claim either — leave every newline exactly as `exportNode`
        // always has. This is the ordinary, non-crossing case
        // `quasar-exporter-no-trivia` promises byte-for-byte: touching it
        // broke `RoundTrip.test.ts` (`[centre]\n[color=…]` lost its
        // newline, because `center`'s own `afterOpen` rule alone made
        // `isNewlineSwallowed` true with no ghost involved at all).
        if (!hasGhost) {
          for (let j = regionStart; j < i; j++) out += this.exportNode(children[j]) // 'spacing'/'empty_line' → '\n'
          pendingRealChild = null
          continue
        }

        const region = children.slice(regionStart, i)
        const semantic = this.semanticModel()
        const pendingRealRule = pendingRealChild ? semantic.closingBudget(pendingRealChild) : null
        const newlineNodes = region.filter(isNewlineKind)
        const naturalCount = pendingRealRule ? Math.min(newlineNodes.length, pendingRealRule.afterClose) : 0

        let newlineIndex = 0
        for (const regionChild of region) {
          if (isGhostKind(regionChild)) {
            out += this.exportNode(regionChild) // always '' — see exportNode
            continue
          }
          const k = newlineIndex++
          const swallowed = semantic.isNewlineSwallowed(regionChild)
          if (k < naturalCount || !swallowed) out += '\n'
        }
        pendingRealChild = null
        continue
      }

      out += this.exportNode(child)
      pendingRealChild = child
      i++
    }
    return out
  }

  private exportNode(node: RedNode): string {
    // Un cierre que no cerró nada no vuelve al source. Escribirlo hacía que el
    // siguiente parseo lo leyera otra vez como etiqueta viva, y el documento no
    // convergía al reexportarlo.
    if (node.kind === 'discarded_tag' || node.kind === 'discarded_box_close') return ''

    const tagDef = this.registry.getByKind(node.kind)

    // Text nodes
    if (node.kind === 'text') {
      let out = node.text
      if (this.expandTokens !== null) out = expandTokenRefs(out, this.expandTokens)
      const style = node.metadata?.style as Record<string, string> | undefined
      if (style) {
        // Envolvemos desde adentro hacia afuera (o al revés, no importa mucho para osu)
        if (style.fontWeight === 'bold') out = `[b]${out}[/b]`
        if (style.fontStyle === 'italic') out = `[i]${out}[/i]`
        if (style.textDecoration === 'underline') out = `[u]${out}[/u]`
        if (style.textDecoration === 'line-through') out = `[s]${out}[/s]`
        if (style.color) {
          let col = style.color
          if (this.shouldResolveTokens() && col.startsWith('$')) {
            col = resolveTokenValue(col, this.tokenResolver)
          }
          out = `[color=${normalizeColorToHex(col, this.target)}]${out}[/color]`
        }
        if (style.fontSize) {
          let size = style.fontSize
          if (this.shouldResolveTokens() && size.startsWith('$')) {
            size = resolveTokenValue(size, this.tokenResolver)
          }
          out = `[size=${clampFontSizeValue(size, this.target)}]${out}[/size]`
        }
        // Se pueden seguir sumando estilos dinámicos
      }
      return out
    }

    // Document root
    if (node.kind === 'document') {
      return this.exportChildren(node)
    }

    // Custom tag handlers from registry
    // When target is 'miliastry', skip custom handlers for Miliastry-native tags
    // so they serialize as-is instead of expanding to osu!-compatible formats.
    if (tagDef?.toBBCode && !(this.target === 'miliastry' && MILIASTRY_INTERNAL_TAGS.has(node.kind))) {
      return tagDef.toBBCode({
        node,
        source: this.context.source,
        visitChildren: (n) => this.exportNode(n),
        renderChild: () => ({ kind: 'text', text: '', children: [], props: {} }),
      })
    }

    // Tags Miliastry-only / Lyne-only: en target 'osu' se degradan a contenido plano para
    // que el BBCode generado SIEMPRE sea pegable en osu! sin tags rotos.
    if (this.target === 'osu' && (MILIASTRY_ONLY_TAGS.has(node.kind) || LYNE_ONLY_TAGS.has(node.kind))) {
      return node.children.map((c) => this.exportNode(c)).join('')
    }

    // Default BBCode serialization
    let tagName = this.kindToTagName(node.kind)
    const attrs = this.getTagAttributes(node)
    const content = this.exportChildren(node)

    if (!tagName) {
      if (node.kind === 'spacing') return '\n'
      if (node.kind === 'empty_line') return '\n'
      // Plugin tags: not in the builtin kind→tag table, but registered, so
      // they serialize under their registered name and round-trip. Strictly
      // limited to NON-builtin registrations — builtins missing from the
      // table (sinewave, rainbow, svg…) keep their existing content-only
      // serialization, which Studio flows depend on.
      if (tagDef && !this.registry.isBuiltin(tagDef.name)) {
        tagName = tagDef.name
      } else {
        return content
      }
    }

    if (this.target === 'osu') {
      // osu! solo sella `[spoilerbox]` desnudo (`BBCodeForDB::parseBox` lo
      // reemplaza con un `strtr` literal), así que uno con título se publicaba
      // como texto. `[box=Título]` produce exactamente el mismo spoilerbox con
      // ese título, que es lo que la vista previa ya enseña.
      if (node.kind === 'spoilerbox' && attrs !== '') {
        return `[box${attrs}]${content}[/box]`
      }
      // La gramática de imagemap de osu! (`BBCodeFromDB::parseImagemap`) exige
      // un salto justo después de `[imagemap]` y otro antes de `[/imagemap]`;
      // sin ellos el bloque entero sale como texto literal. Se añaden solo si
      // faltan, así que reexportar no los duplica.
      if (node.kind === 'imagemap' && content !== '') {
        const head = content.startsWith('\n') ? '' : '\n'
        const tail = content.endsWith('\n') ? '' : '\n'
        return `[${tagName}${attrs}]${head}${content}${tail}[/${tagName}]`
      }
    }

    if (node.kind === 'image' || node.kind === 'video' || node.kind === 'audio') {
      // image lleva su tamaño/modificador en el attr (`[img=400x300]url[/img]`)
      // y la URL en el contenido; video/audio usan el attr como src, así que
      // solo image debe re-emitir atributos.
      const mediaAttrs = node.kind === 'image' ? attrs : ''
      return `[${tagName}${mediaAttrs}]${content}[/${tagName}]`
    }

    const kindName: string = node.kind
    if (kindName === 'list_item') {
      return `[*]${content}`
    }

    if (content === '' && !node.children.length) {
      if (kindName === 'list_item') return '[*]'
      return `[${tagName}${attrs}]${content}[/${tagName}]`
    }

    return `[${tagName}${attrs}]${content}[/${tagName}]`
  }

  private kindToTagName(kind: string): string | null {
    return KIND_TO_TAG_NAME[kind] ?? null
  }

  private getTagAttributes(node: RedNode): string {
    // For BBCode, attributes are in the node text or metadata
    if (node.metadata) {
      if (node.metadata.tagName) {
        const tag = this.registry.get(node.metadata.tagName as string)
        if (tag?.properties) {
          const parts: string[] = []
          for (const prop of tag.properties) {
            let val = node.metadata[prop.name]
            if (val !== undefined && val !== null) {
              if (this.shouldResolveTokens() && typeof val === 'string' && val.startsWith('$')) {
                val = resolveTokenValue(val, this.tokenResolver)
              }
              parts.push(`${prop.name}=${val}`)
            }
          }
          if (parts.length > 0) return `=${parts[0]}`
        }
      } else if (node.kind === 'font_size' && hasAttrValue(node.metadata.size)) {
        let size = String(node.metadata.size)
        if (this.shouldResolveTokens() && size.startsWith('$')) {
          size = resolveTokenValue(size, this.tokenResolver)
        }
        // The published page caps it anyway; export what it will actually show.
        return `=${clampFontSizeValue(size, this.target)}`
      } else if (node.kind === 'color' && hasAttrValue(node.metadata.color)) {
        let color = String(node.metadata.color)
        if (this.shouldResolveTokens() && color.startsWith('$')) {
          color = resolveTokenValue(color, this.tokenResolver)
        }
        return `=${normalizeColorToHex(color, this.target)}`
      } else if (node.kind === 'font' && hasAttrValue(node.metadata.font)) {
        let font = String(node.metadata.font)
        if (this.shouldResolveTokens() && font.startsWith('$')) {
          font = resolveTokenValue(font, this.tokenResolver)
        }
        return `=${font}`
      } else if (node.kind === 'url' && node.metadata.href !== undefined) {
        return `=${node.metadata.href}`
      } else if (node.kind === 'email' && hasAttrValue(node.metadata.href)) {
        // The parser prefixes the address with `mailto:`, so a bare `[email]`
        // arrives as exactly that prefix and nothing else — test the address.
        const address = (node.metadata.href as string).replace('mailto:', '')
        return address === '' ? '' : `=${address}`
      } else if (node.kind === 'quote' && hasAttrValue(node.metadata.source)) {
        let src = String(node.metadata.source)
        if (this.expandTokens !== null) src = expandTokenRefs(src, this.expandTokens)
        return `="${src}"`
      } else if (node.kind === 'box' || node.kind === 'boxw' || node.kind === 'spoilerbox') {
        // `rawTitle` is the source spelling; `title` is the parsed one, which
        // falls back to a synthetic "Box"/"Spoiler" when the tag is bare. Only
        // the raw form can be trusted to reproduce the input, so it wins.
        const raw = node.metadata.rawTitle
        let titleVal = String((raw !== undefined ? raw : node.metadata.title) ?? '')
        if (this.expandTokens !== null) titleVal = expandTokenRefs(titleVal, this.expandTokens)
        // `[box=Title:#hex]`: el color se guardó aparte en metadata; se vuelve
        // a añadir aquí para que el round-trip no pierda el sufijo.
        let color = node.metadata.color as string | undefined
        if (this.shouldResolveTokens() && color && color.startsWith('$')) {
          color = resolveTokenValue(color, this.tokenResolver)
        }
        // A bare `[box]` has neither, and must stay bare.
        if (titleVal === '' && !color) return ''
        return `=${titleVal}${color ? `:${color}` : ''}`
      } else if ((node.kind === 'notice' || node.kind === 'wnotice') && node.metadata.color !== undefined) {
        let color = String(node.metadata.color)
        if (this.shouldResolveTokens() && color.startsWith('$')) {
          color = resolveTokenValue(color, this.tokenResolver)
        }
        return `=${color}`
      } else if (node.kind === 'tables' && node.metadata.variant !== undefined) {
        let color = node.metadata.color as string | undefined
        if (this.shouldResolveTokens() && color && color.startsWith('$')) {
          color = resolveTokenValue(color, this.tokenResolver)
        }
        return `=${node.metadata.variant}${color ? `:${color}` : ''}`
      } else if (node.kind === 'columns' && node.metadata.columns !== undefined) {
        let color = node.metadata.color as string | undefined
        if (this.shouldResolveTokens() && color && color.startsWith('$')) {
          color = resolveTokenValue(color, this.tokenResolver)
        }
        return `=${node.metadata.columns}${color ? `:${color}` : ''}`
      } else if (node.kind === 'separator' && node.metadata.variant !== undefined) {
        return `=${node.metadata.variant}`
      } else if (node.kind === 'scroll' && node.metadata.height !== undefined) {
        return `=${node.metadata.height}`
      } else if (node.kind === 'abbr' && node.metadata.title !== undefined) {
        return `=${node.metadata.title}`
      } else if (node.kind === 'tooltip' && node.metadata.tip !== undefined) {
        return `=${node.metadata.tip}`
      } else if (node.kind === 'guild' && node.metadata.tag !== undefined) {
        return `=${node.metadata.tag}`
      } else if (node.kind === 'map' && node.metadata.id !== undefined) {
        return `=${node.metadata.id}`
      } else if (node.kind === 'align' && node.metadata.align !== undefined) {
        return `=${node.metadata.align}`
      } else if (node.kind === 'effect' && node.metadata.effectType !== undefined) {
        let color = node.metadata.color as string | undefined
        if (this.shouldResolveTokens() && color && color.startsWith('$')) {
          color = resolveTokenValue(color, this.tokenResolver)
        }
        return `=${node.metadata.effectType}${color ? `:${color}` : ''}`
      } else if (node.kind === 'image' && node.metadata.imgAttr !== undefined) {
        return `=${node.metadata.imgAttr}`
      } else if (node.kind === 'anim' && node.metadata.animType !== undefined) {
        return `=${node.metadata.animType}`
      } else if (node.kind === 'container' && node.metadata.containerType !== undefined) {
        let color = node.metadata.color as string | undefined
        if (this.shouldResolveTokens() && color && color.startsWith('$')) {
          color = resolveTokenValue(color, this.tokenResolver)
        }
        return `=${node.metadata.containerType}${color ? `:${color}` : ''}`
      } else if (node.kind === 'style_tag' && node.metadata.style !== undefined) {
        let style = String(node.metadata.style)
        if (this.shouldResolveTokens()) {
          style = style.replace(/\$([a-zA-Z0-9_.-]+)/g, (match) => {
            return resolveTokenValue(match, this.tokenResolver)
          })
        }
        return `=${style}`
      } else if (hasAttrValue(node.metadata.value)) {
        let val = String(node.metadata.value)
        if (this.shouldResolveTokens() && val.startsWith('$')) {
          val = resolveTokenValue(val, this.tokenResolver)
        }
        return `=${val}`
      } else if (hasAttrValue(node.metadata.raw)) {
        let raw = String(node.metadata.raw)
        if (this.shouldResolveTokens() && raw.startsWith('$')) {
          raw = resolveTokenValue(raw, this.tokenResolver)
        }
        return `=${raw}`
      }
    }

    // Fallback: check node text for attribute info
    const text = node.text || ''
    if (text.startsWith('=') || text.startsWith(' ')) {
      if (node.kind === 'color' && text.startsWith('=')) {
        let col = text.slice(1)
        if (this.shouldResolveTokens() && col.startsWith('$')) {
          col = resolveTokenValue(col, this.tokenResolver)
        }
        return `=${normalizeColorToHex(col, this.target)}`
      }
      if (this.shouldResolveTokens() && text.startsWith('=')) {
        let val = text.slice(1)
        if (val.startsWith('$')) {
          return `=${resolveTokenValue(val, this.tokenResolver)}`
        }
      }
      return text
    }

    return ''
  }
}
