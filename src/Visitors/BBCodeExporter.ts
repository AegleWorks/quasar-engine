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

function normalizeColorToHex(color: string): string {
  if (!color) return color
  const trimmed = color.trim()
  // Un hex ya es canónico: bajarlo a minúsculas reescribía `[color=#FF0000]`
  // del autor en cada exportación, y `Analysis/RoundTrip` fija lo contrario.
  if (trimmed.startsWith('#')) return trimmed

  const rgbMatch = trimmed.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i)
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10).toString(16).padStart(2, '0')
    const g = parseInt(rgbMatch[2], 10).toString(16).padStart(2, '0')
    const b = parseInt(rgbMatch[3], 10).toString(16).padStart(2, '0')
    return `#${r}${g}${b}`.toLowerCase()
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
    return this.visit(root)
  }

  /**
   * Exporta los hijos directos y los concatena.
   *
   * Reemplaza el `children.map(...).join('')`, que asignaba un cierre y un
   * array intermedio de N cadenas en cada nivel del árbol. `HTMLRenderer`
   * hizo este mismo cambio y dejó la nota; el exportador se quedó atrás, y es
   * el camino que corre bajo un límite de 60.000 caracteres.
   */
  private exportChildren(node: RedNode): string {
    const children = node.children
    let out = ''
    for (let i = 0; i < children.length; i++) out += this.exportNode(children[i])
    return out
  }

  private exportNode(node: RedNode): string {
    // Un cierre que no cerró nada no vuelve al source. Escribirlo hacía que el
    // siguiente parseo lo leyera otra vez como etiqueta viva, y el documento no
    // convergía al reexportarlo.
    if (node.kind === 'discarded_tag') return ''

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
          out = `[color=${normalizeColorToHex(col)}]${out}[/color]`
        }
        if (style.fontSize) {
          let size = style.fontSize
          if (this.shouldResolveTokens() && size.startsWith('$')) {
            size = resolveTokenValue(size, this.tokenResolver)
          }
          out = `[size=${size}]${out}[/size]`
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
        return `=${size}`
      } else if (node.kind === 'color' && hasAttrValue(node.metadata.color)) {
        let color = String(node.metadata.color)
        if (this.shouldResolveTokens() && color.startsWith('$')) {
          color = resolveTokenValue(color, this.tokenResolver)
        }
        return `=${normalizeColorToHex(color)}`
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
        return `=${normalizeColorToHex(col)}`
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
