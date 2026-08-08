/**
 * DocumentEngine — TreeBuilder
 *
 * Converts a TokenStream into a GreenNode tree.
 * This is the bridge between the Lexer and the Syntax Tree.
 *
 * The TreeBuilder is language-agnostic — it uses registry-based
 * node factories to build the appropriate tree structure.
 */

import { GreenNode, greenNode, greenLeaf } from './GreenNode'
import { RedNode } from './RedNode'
import type { TokenStream, Token } from '../Types/tokens'
import type { NodeKind } from '../Types/core'

// ─── Build Result ──────────────────────────────────────────────

export interface BuildResult {
  green: GreenNode
  red: RedNode
  tokens: Token[]
}

// ─── Node Factory Interface ────────────────────────────────────

export interface NodeFactory {
  /** Create a GreenNode from a token or sequence of tokens */
  createGreen(tokens: Token[], stream: TokenStream): GreenNode | null
  /** Create a RedNode from a green node */
  createRed(green: GreenNode, parent?: RedNode | null): RedNode
}

// ─── TreeBuilder ───────────────────────────────────────────────

export class TreeBuilder {
  private factories: Map<string, NodeFactory> = new Map()
  private defaultKind: NodeKind = 'unknown'

  constructor(defaultKind?: NodeKind) {
    if (defaultKind) this.defaultKind = defaultKind
  }

  /**
   * Register a node factory for a specific token kind or tag name.
   */
  register(kind: string, factory: NodeFactory): void {
    this.factories.set(kind, factory)
  }

  /**
   * Build a tree from a token stream.
   */
  build(stream: TokenStream): BuildResult {
    const tokens: Token[] = []

    // Collect all tokens
    while (!stream.isEof()) {
      tokens.push(stream.advance())
    }

    // Build the green tree
    const green = this.buildGreen(tokens)

    // Build the red tree
    const red = this.buildRed(green)

    return { green, red, tokens }
  }

  /**
   * Build a green tree from a token array.
   * Uses registered factories to determine node structure.
   *
   * By default, creates a flat document structure.
   * Language-specific builders (like BBCodeParser) override this.
   */
  buildGreen(tokens: Token[]): GreenNode {
    // Default: create a document node with all tokens as direct children
    const children: GreenNode[] = []
    let start = tokens.length > 0 ? tokens[0].range.start : 0
    let end = tokens.length > 0 ? tokens[tokens.length - 1].range.end : 0

    for (const token of tokens) {
      // Try registered factories
      let green: GreenNode | null = null

      if (token.name && this.factories.has(token.name)) {
        green = this.factories.get(token.name)!.createGreen([token], {
          peek: () => token,
          advance: () => token,
          lookAhead: () => token,
          isEof: () => true,
          position: () => 0,
          seek: () => {},
          remaining: () => [],
          getAll: () => [token],
        } as TokenStream)
      }

      if (!green && this.factories.has(token.kind)) {
        green = this.factories.get(token.kind)!.createGreen([token], {
          peek: () => token,
          advance: () => token,
          lookAhead: () => token,
          isEof: () => true,
          position: () => 0,
          seek: () => {},
          remaining: () => [],
          getAll: () => [token],
        } as TokenStream)
      }

      if (!green) {
        // Default: create a text leaf or tag leaf
        if (token.kind === 'text' || token.kind === 'newline') {
          green = greenLeaf('text', token.text)
        } else if (token.kind === 'open_tag' || token.kind === 'close_tag' || token.kind === 'self_closing_tag') {
          green = greenLeaf(token.name ? `tag:${token.name}` : 'tag', token.text)
        } else {
          green = greenLeaf(token.kind, token.text)
        }
      }

      children.push(green)
    }

    return greenNode('document', '', children)
  }

  /**
   * Build a red tree from a green tree.
   */
  buildRed(green: GreenNode, parent?: RedNode | null, kind?: NodeKind): RedNode {
    const red = new RedNode(green, {
      parent: parent ?? null,
      kind: kind ?? this.defaultKind,
    })

    for (const childGreen of green.children as GreenNode[]) {
      // Determine child kind based on green node kind
      let childKind: NodeKind = childGreen.kind as NodeKind
      if (childGreen.kind.startsWith('tag:')) {
        const tagName = childGreen.kind.slice(4)
        childKind = this.tagToKind(tagName)
      }

      const childRed = this.buildRed(childGreen, red, childKind)
      red.appendChild(childRed)
    }

    return red
  }

  /**
   * Create a RedNode directly from children (for language-specific parsers).
   */
  createRedFromChildren(
    kind: NodeKind,
    text: string,
    children: RedNode[],
    parent?: RedNode | null,
  ): RedNode {
    const green = greenNode(kind, text, children.map(c => c.green))
    const red = new RedNode(green, { parent: parent ?? null, kind })
    for (const child of children) {
      child.parent = red
      red.appendChild(child)
    }
    return red
  }

  // ─── Tag to Kind Mapping ────────────────────────────────

  private tagToKind(tag: string): NodeKind {
    const map: Record<string, NodeKind> = {
      'b': 'bold',
      'i': 'italic',
      'u': 'underline',
      's': 'strikethrough',
      'strike': 'strikethrough',
      'color': 'color',
      'size': 'font_size',
      'font': 'font',
      'shadow': 'shadow',
      'c': 'inline_code',
      'code': 'code',
      'spoiler': 'spoiler',
      'centre': 'center',
      'right': 'right',
      'center': 'center',
      'url': 'url',
      'email': 'email',
      'profile': 'profile',
      'img': 'image',
      'youtube': 'video',
      'audio': 'audio',
      'imagemap': 'imagemap',
      'quote': 'quote',
      'notice': 'notice',
      'spoilerbox': 'spoilerbox',
      'box': 'box',
      'list': 'list',
      '*': 'list_item',
      'heading': 'heading',
      'zalgo': 'zalgo',
      'aesthetic': 'aesthetic',
      'sparkle': 'sparkle',
      'bubble': 'bubble',
      'flower': 'flower',
    }
    return map[tag] ?? 'custom'
  }
}
