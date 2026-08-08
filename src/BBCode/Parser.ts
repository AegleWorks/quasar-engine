/**
 * DocumentEngine — BBCode Parser
 *
 * Builds a GreenNode (immutable syntax tree) from BBCode tokens.
 *
 * This is the core parsing logic that replaces the old BBCode parser.
 * Unlike the old parser, this produces GreenNode directly — no BBBlock[]
 * intermediate step. The flow is:
 *
 *   BBCode text
 *     ↓ scanBBCode() [BBCodeLexer]
 *   BBCodeToken[]
 *     ↓ parseTokensToGreen() [this]
 *   GreenNode
 *     ↓ greenToRedNode()
 *   RedNode
 *
 * Key differences from the old parser:
 * - Newlines are explicit tokens (not mixed into text) → precise empty_line detection
 * - All syntactically valid tags are parsed (not just BLOCK_TAGS)
 * - Produces GreenNode directly (no BBBlock[] intermediate)
 * - No newline stripping between block-level tags
 * - Consecutive newlines (2+) = empty_line node (paragraph break)
 * - Single newlines between inline content = ignored (CSS handles spacing)
 */

import { GreenNode, greenNode, greenLeaf } from '../Syntax/GreenNode'
import type { NodeKind } from '../Types/core'
import { GreenNodePool } from '../Syntax/GreenNodePool'
import { tagToNodeKind } from './BBCodeToGreenNode'
import type { BBCodeToken } from '../Lexer/BBCodeLexer'
import { scanBBCode } from '../Lexer/BBCodeLexer'
import { isBlockKind } from './BBCodeToGreenNode'

// ─── Main entry point ──────────────────────────────────────────

/**
 * Parse BBCode tokens into a GreenNode tree.
 *
 * @param tokens  Flat array of tokens from scanBBCode()
 * @param source  Original source text (used for fallback error text)
 * @returns       A GreenNode tree with 'document' as root
 */
export interface ParseOptions {
  strictMode?: boolean;
  /** Optional interner for structural sharing. If provided, identical subtrees
   *  share the same GreenNode reference in memory. */
  interner?: GreenNodePool;
  /**
   * Group top-level inline nodes into `paragraph` nodes. Default `true`.
   *
   * Paragraph grouping happens at the ROOT ONLY — inside `[centre]` or `[box]`
   * the children stay flat. So when the incremental parser re-parses the inner
   * span of such a container in isolation, that span's content is not root
   * content and must not be grouped, or the re-parsed subtree would gain
   * paragraphs the full parse never produces.
   */
  normalizeParagraphs?: boolean;
  /**
   * Plugin-registered tags: tag name → the kind their nodes get.
   *
   * The built-in table deliberately turns unknown tags into literal text
   * (`[Gateron]` in prose must stay visible), which also meant a plugin's tag
   * could render and export but never PARSE. This is the missing link: a tag
   * present here parses as a normal paired container. `BBCodeDocumentModel`
   * fills it from the `TagRegistry`'s non-builtin entries; everything not
   * registered still falls to literal text exactly as before.
   */
  extraTags?: ReadonlyMap<string, NodeKind>;
}

export function parseTokensToGreen(
  tokens: BBCodeToken[],
  source: string,
  options: ParseOptions = {}
): GreenNode {
  const strictMode = options.strictMode ?? false;
  const interner = options.interner ?? null;
  const normalizeParagraphs = options.normalizeParagraphs ?? true;
  const extraTags = options.extraTags;
  const root: GreenNode[] = []
  const stack: {
    /** The literal tag name. Closing matches on THIS, not on `kind`: `[centre]`
     *  and `[center]` share a kind but do not close each other, and that is
     *  existing behaviour, not something to change while optimising. */
    tag: string
    /** Resolved once, when the tag opens. `tagToNodeKind` used to be called
     *  twice per element — once to test for `custom`, once to close it. */
    kind: string
    attrs: string
    children: GreenNode[]
    /** Width of the opening delimiter, e.g. 3 for `[b]`, 11 for `[color=red]`. */
    leadingWidth: number
  }[] = []

  /**
   * Create an internal GreenNode, optionally interning for structural sharing.
   *
   * Note what is NOT here: a start or an end. A green node has a width, and its
   * width is derived from its children plus its own delimiters, so the parser
   * cannot state a span that disagrees with what it actually built.
   */
  function createNode(
    kind: string,
    text: string,
    children: GreenNode[],
    leadingWidth: number = 0,
    trailingWidth: number = 0,
  ): GreenNode {
    if (interner) {
      return interner.internNode(kind, text, children, leadingWidth, trailingWidth)
    }
    return greenNode(kind, text, children, leadingWidth, trailingWidth)
  }

  /** Create a token. `width` defaults to the text's own length. */
  function createLeaf(kind: string, text: string, width: number = text.length): GreenNode {
    if (interner) {
      return interner.internLeaf(kind, text, width)
    }
    return greenLeaf(kind, text, width)
  }

  /**
   * Close a stack frame into an element node.
   *
   * `trailingWidth` is how much of the element's tail is its own closing
   * delimiter — 0 when it was auto-closed (by an enclosing tag, by a sibling
   * `[*]`, or by end of input), because then the closing text belongs to
   * somebody else or does not exist.
   *
   * The element's end used to be passed in as well. It no longer can be, and
   * that is the point: the end is `start + leadingWidth + Σ children + trailing`
   * by construction, so the partition invariant of point 14 stopped being
   * something to check and became something to compute.
   */
  function closeFrame(
    frame: { kind: string; attrs: string; children: GreenNode[]; leadingWidth: number },
    trailingWidth: number,
  ): GreenNode {
    return createNode(
      frame.kind,
      frame.attrs,
      frame.children,
      frame.leadingWidth,
      trailingWidth,
    )
  }

  /**
   * Add a node to the current stack frame, or to root if no frame is open.
   */
  function addToParent(node: GreenNode): void {
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node)
    } else {
      root.push(node)
    }
  }

  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]

    // ── Newline token(s) ─────────────────────────────────────
    if (tok.kind === 'newline') {
      // Count consecutive newlines and emit semantic nodes.
      // NO SUPPRESSION for inline context — the tree must preserve
      // ALL source information. The HTMLRenderer handles inline-safe
      // rendering of spacing/empty_line (as `<br>` / `<br><br>`).
      // Each newline in the run gets ITS OWN range. They used to all share the
      // whole run's span, so `"hola\n\nmundo"` produced `spacing [4..6]` and
      // `empty_line [4..6]` — two nodes owning offset 5, which is exactly the
      // ambiguity that made `shiftRanges` impossible to write correctly.
      let first = true

      while (i < tokens.length && tokens[i].kind === 'newline') {
        const nl = tokens[i]
        // The first newline is soft spacing (ignored in block context); any
        // subsequent one is a hard empty line (rendered as `<br>` everywhere).
        addToParent(createLeaf(first ? 'spacing' : 'empty_line', '', nl.end - nl.start))
        first = false
        i++
      }

      continue
    }

    // ── Plain text ───────────────────────────────────────────
    if (tok.kind === 'text') {
      addToParent(createLeaf('text', tok.value))
      i++
      continue
    }

    // ── Opening tag: [tag] or [tag=attrs] ──────────────────
    if (tok.kind === 'open') {
      // Unknown tags (not in the BBCode spec) must be preserved
      // as literal text. Treating them as real tags would cause
      // their content to disappear from the preview.
      // E.g. [Gateron], [90 misses], [b][Gateron][/b] → visible text
      //
      // Plugin-registered tags (`extraTags`) are the one exception: they are
      // known — just not to the built-in table — and parse as containers.
      let openKind = tagToNodeKind(tok.tag)
      if (openKind === 'custom') {
        const pluginKind = extraTags?.get(tok.tag)
        if (pluginKind === undefined) {
          const tagText = source.slice(tok.start, tok.end)
          addToParent(createLeaf('text', tagText))
          i++
          continue
        }
        openKind = pluginKind
      }

      if (tok.tag === '*') {
        // Auto-close previous [*] if it's currently open. It ends where this
        // one begins and owns no closing delimiter.
        if (stack.length > 0 && stack[stack.length - 1].tag === '*') {
          addToParent(closeFrame(stack.pop()!, 0))
        }
        stack.push({
          tag: tok.tag,
          kind: openKind,
          attrs: tok.attrs,
          children: [],
          leadingWidth: tok.end - tok.start,
        })
        i++
        continue
      }

      // Push onto the stack — children will be added later.
      //
      // There used to be a `SELF_CLOSING` branch here, guarded by a Set that
      // was declared empty (`new Set<string>([])`), so it was unreachable. The
      // only self-closing tag BBCode has is `[*]`, and that is handled by its
      // own branch above.
      stack.push({
        tag: tok.tag,
        kind: openKind,
        attrs: tok.attrs,
        children: [],
        leadingWidth: tok.end - tok.start,
      })
      i++
      continue
    }

    // ── Closing tag: [/tag] ──────────────────────────────────
    if (tok.kind === 'close') {
      const closeWidth = tok.end - tok.start

      if (strictMode) {
        if (stack.length > 0 && stack[stack.length - 1].tag === '*' && tok.tag === 'list') {
          // Auto-close [*] before closing [list] even in strict mode. The
          // `[/list]` belongs to the list, not to the item.
          addToParent(closeFrame(stack.pop()!, 0))
        }
        // STRICT MODE: Only match the very top of the stack.
        if (stack.length > 0 && stack[stack.length - 1].tag === tok.tag) {
          addToParent(closeFrame(stack.pop()!, closeWidth))
        } else {
          // Strict Mode Mismatch: Emit an 'error' node with the raw tag as child
          const expected = stack.length > 0 ? stack[stack.length - 1].tag : 'nothing'
          const text = source.slice(tok.start, tok.end)
          const errMsg = `Syntax Error: Expected /${expected}, got /${tok.tag}`
          addToParent(createNode('error', errMsg, [createLeaf('text', text)]))
        }
      } else {
        // LEGACY MODE: Walk backwards, auto-close inner tags, ignore orphaned closing tags.
        let found = -1
        for (let j = stack.length - 1; j >= 0; j--) {
          if (stack[j].tag === tok.tag) {
            found = j
            break
          }
        }

        if (found !== -1) {
          // Auto-close any tags that were opened inside this one. They end
          // where the closing delimiter BEGINS — the delimiter itself is owned
          // by the tag it actually closes, so an auto-closed inner tag gets a
          // trailing width of 0. This used to hand them `tok.end`, which made
          // `[b][i]x[/b]` produce an `italic` and a `bold` both ending at 10,
          // overlapping on the four characters of `[/b]`.
          while (stack.length - 1 > found) {
            const inner = stack.pop()!
            stack[stack.length - 1].children.push(closeFrame(inner, 0))
          }

          // Close the matched tag itself — this one does own the delimiter.
          addToParent(closeFrame(stack.pop()!, closeWidth))
        } else {
          // Orphaned closing tag: no matching opener anywhere on the stack.
          //
          // This used to be dropped silently, which punched a hole in the
          // source coverage — those characters belonged to no node, so the
          // tree could not answer "what is at this offset?" for them. They are
          // now kept as literal text, exactly as unknown tags already were
          // (see the `custom` branch above), which is also what the user
          // typed and therefore what they expect to see.
          addToParent(createLeaf('text', source.slice(tok.start, tok.end)))
        }
      }

      i++
      continue
    }
  }

  // ── Close any remaining unclosed tags ────────────────────────
  // These are tags that were opened but never closed in the source.
  // They get all remaining source as their content.
  while (stack.length > 0) {
    // No closing delimiter exists, so trailing width is 0.
    addToParent(closeFrame(stack.pop()!, 0))
  }

  if (!normalizeParagraphs) {
    return createNode('document', '', root)
  }

  // Normalize root inline nodes into paragraphs
  const normalizedRoot: GreenNode[] = []
  let currentParagraph: GreenNode[] = []

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      normalizedRoot.push(createNode('paragraph', '', currentParagraph))
      currentParagraph = []
    }
  }

  for (const child of root) {
    // GreenNode.kind is a widened `string`; the kind vocabulary is shared with
    // NodeKind and every value reaching here came from tagToNodeKind().
    if (isBlockKind(child.kind as NodeKind) || child.kind === 'empty_line') {
      flushParagraph()
      normalizedRoot.push(child)
    } else {
      currentParagraph.push(child)
    }
  }
  flushParagraph()

  // The root spans the whole source, always. It used to be derived from its
  // children (`root[0].start` … `last.end`), which meant that anything the
  // parser dropped — an orphaned closing tag, most commonly — silently
  // shrank the document. Every token now lands somewhere in the tree, so the
  // children genuinely cover `[0..source.length]` and the root can say so.
  return createNode('document', '', normalizedRoot)
}

/**
 * Full parse: BBCode text → GreenNode.
 *
 * Convenience function that combines the lexer and parser.
 * BBCodeDocumentModel internally uses scanBBCode() + parseTokensToGreen() directly.
 *
 * Usage:
 *   import { parseBBCode } from '../BBCode/Parser'
 *   const tree = parseBBCode('[b]Hello[/b]')
 */
export function parseBBCode(source: string, options: ParseOptions = {}): GreenNode {
  const tokens = scanBBCode(source)
  return parseTokensToGreen(tokens, source, options)
}
