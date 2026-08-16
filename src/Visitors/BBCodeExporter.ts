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

/**
 * Export target for BBCodeExporter.
 * - 'osu': Expands Miliastry/Lyne-native tags into osu!-compatible BBCode.
 * - 'miliastry': Preserves Miliastry-native tags as-is for round-trip editing.
 * - 'lyne': Preserves Lyne-native tags as-is for round-trip editing.
 */
export type ExportTarget = 'osu' | 'miliastry' | 'lyne'

/** Miliastry-native effect tags that osu! doesn't support natively */
const MILIASTRY_INTERNAL_TAGS = new Set(['gradient', 'grow', 'sinewave', 'rainbow'])

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
  align: 'align',
  tables: 'tables',
  table_row: 'row',
  table_col: 'col',
  table_th: 'th',
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
}


export class BBCodeExporter extends Visitor<string> {
  private registry: TagRegistry
  private depth: number = 0
  private target: ExportTarget

  constructor(registry: TagRegistry = new TagRegistry(), target: ExportTarget = 'osu') {
    super()
    this.registry = registry
    this.target = target
  }

  /**
   * Set the export target. Controls how Miliastry-native tags are serialized.
   */
  setTarget(target: ExportTarget): void {
    this.target = target
  }

  /**
   * Export a RedNode tree to BBCode.
   */
  visit(node: RedNode, context?: VisitorContext): string {
    if (context) this.context = context
    this.depth = 0
    return this.exportNode(node)
  }

  /**
   * Export the entire document to BBCode.
   * Optionally override the export target for this specific call.
   */
  export(root: RedNode, target?: ExportTarget): string {
    if (target !== undefined) this.target = target
    return this.visit(root)
  }

  private exportNode(node: RedNode): string {
    const tagDef = this.registry.getByKind(node.kind)

    // Text nodes
    if (node.kind === 'text') {
      let out = node.text
      const style = node.metadata?.style as Record<string, string> | undefined
      if (style) {
        // Envolvemos desde adentro hacia afuera (o al revés, no importa mucho para osu)
        if (style.fontWeight === 'bold') out = `[b]${out}[/b]`
        if (style.fontStyle === 'italic') out = `[i]${out}[/i]`
        if (style.textDecoration === 'underline') out = `[u]${out}[/u]`
        if (style.textDecoration === 'line-through') out = `[s]${out}[/s]`
        if (style.color) out = `[color=${style.color}]${out}[/color]`
        if (style.fontSize) out = `[size=${style.fontSize}]${out}[/size]`
        // Se pueden seguir sumando estilos dinámicos
      }
      return out
    }

    // Document root
    if (node.kind === 'document') {
      return node.children.map(c => this.exportNode(c)).join('')
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
    const content = node.children.map(c => this.exportNode(c)).join('')

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
            const val = node.metadata[prop.name]
            if (val !== undefined && val !== null) {
              parts.push(`${prop.name}=${val}`)
            }
          }
          if (parts.length > 0) return `=${parts[0]}`
        }
      } else if (node.kind === 'font_size' && node.metadata.size !== undefined) {
        return `=${node.metadata.size}`
      } else if (node.kind === 'color' && node.metadata.color !== undefined) {
        return `=${node.metadata.color}`
      } else if (node.kind === 'font' && node.metadata.font !== undefined) {
        return `=${node.metadata.font}`
      } else if (node.kind === 'url' && node.metadata.href !== undefined) {
        return `=${node.metadata.href}`
      } else if (node.kind === 'email' && node.metadata.href !== undefined) {
        return `=${(node.metadata.href as string).replace('mailto:', '')}`
      } else if (node.kind === 'quote' && node.metadata.source !== undefined) {
        return `="${node.metadata.source}"`
      } else if ((node.kind === 'box' || node.kind === 'boxw' || node.kind === 'spoilerbox') && (node.metadata.rawTitle !== undefined || node.metadata.title !== undefined)) {
        const titleVal = node.metadata.rawTitle !== undefined ? node.metadata.rawTitle : node.metadata.title
        // `[box=Title:#hex]`: el color se guardó aparte en metadata; se vuelve
        // a añadir aquí para que el round-trip no pierda el sufijo.
        const color = node.metadata.color as string | undefined
        return `=${titleVal}${color ? `:${color}` : ''}`
      } else if ((node.kind === 'notice' || node.kind === 'wnotice') && node.metadata.color !== undefined) {
        return `=${node.metadata.color}`
      } else if (node.kind === 'tables' && node.metadata.variant !== undefined) {
        const color = node.metadata.color as string | undefined
        return `=${node.metadata.variant}${color ? `:${color}` : ''}`
      } else if (node.kind === 'columns' && node.metadata.columns !== undefined) {
        const color = node.metadata.color as string | undefined
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
        return `=${node.metadata.effectType}`
      } else if (node.kind === 'image' && node.metadata.imgAttr !== undefined) {
        return `=${node.metadata.imgAttr}`
      } else if (node.kind === 'anim' && node.metadata.animType !== undefined) {
        return `=${node.metadata.animType}`
      } else if (node.kind === 'container' && node.metadata.containerType !== undefined) {
        return `=${node.metadata.containerType}`
      } else if (node.kind === 'style_tag' && node.metadata.style !== undefined) {
        return `=${node.metadata.style}`
      }
    }

    // Fallback: check node text for attribute info
    const text = node.text || ''
    if (text.startsWith('=') || text.startsWith(' ')) {
      // The text is exactly the attributes string (e.g. "=50" or " min=50 max=200")
      return text
    }

    return ''
  }
}
