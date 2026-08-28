import { RedNode } from '../Syntax/RedNode'
import { HTMLDocumentModel } from '../HTML/HTMLDocumentModel'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

export interface SurgicalEdit {
  start: number
  end: number
  text: string
}

export interface ReconcileResult {
  edits: SurgicalEdit[]
  hasChanges: boolean
  resultingSource: string
}

const ZWSP = /​/g

/**
 * Traverses a RedNode tree and builds a map of NodeId -> RedNode for fast lookup.
 */
function buildNodeIdMap(root: RedNode): Map<string, RedNode> {
  const map = new Map<string, RedNode>()
  function walk(node: RedNode) {
    if (node.id) {
      map.set(node.id, node)
    }
    for (const child of node.children) {
      walk(child)
    }
  }
  walk(root)
  return map
}

/**
 * Computes the minimal single-range text edit (common prefix + suffix diff)
 * between two strings, ensuring Monaco only replaces the exact changed characters.
 */
export function computeTextDelta(original: string, updated: string): SurgicalEdit[] {
  if (original === updated) return []

  let prefix = 0
  const minLen = Math.min(original.length, updated.length)
  while (prefix < minLen && original.charCodeAt(prefix) === updated.charCodeAt(prefix)) {
    prefix++
  }

  let origSuffix = original.length
  let updSuffix = updated.length
  while (
    origSuffix > prefix &&
    updSuffix > prefix &&
    original.charCodeAt(origSuffix - 1) === updated.charCodeAt(updSuffix - 1)
  ) {
    origSuffix--
    updSuffix--
  }

  const newText = updated.slice(prefix, updSuffix)
  return [
    {
      start: prefix,
      end: origSuffix,
      text: newText,
    },
  ]
}

/** Every text node under `root`, in document order, with zero-width joiners removed. */
function domTextNodes(root: Node): string[] {
  const out: string[] = []
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) out.push((child.nodeValue || '').replace(ZWSP, ''))
      else if (child.nodeType === 1) walk(child)
    }
  }
  walk(root)
  return out
}

/** Every `text` leaf under `node`, in document order. */
function textLeaves(node: RedNode): RedNode[] {
  const out: RedNode[] = []
  const walk = (n: RedNode) => {
    if (n.kind === 'text') {
      out.push(n)
      return
    }
    for (const child of n.children) walk(child)
  }
  walk(node)
  return out
}

/**
 * The edit for an element whose *text* changed but whose structure did not.
 *
 * This is the only path that deserves the name "surgical": it rewrites the
 * source range of each changed text leaf and nothing else, so the author's
 * spelling of everything around it — hex casing, indentation, attribute
 * quoting, tag casing — comes out of the edit byte for byte.
 *
 * Returns `null` when the mapping cannot be trusted, which sends the caller to
 * the coarser re-serialising path. Reasons to distrust it:
 *
 *  - the number of text nodes changed, so the user altered structure;
 *  - the render injects text of its own (a `[quote]` author line, a `[box]`
 *    summary, the padding a `[code]` block loses), so DOM position and AST leaf
 *    no longer line up one to one.
 */
function diffTextLeaves(
  originalNode: RedNode,
  originalRenderedHtml: string,
  el: HTMLElement,
): SurgicalEdit[] | null {
  const probe = el.ownerDocument.createElement('div')
  probe.innerHTML = originalRenderedHtml

  const before = domTextNodes(probe)
  const after = domTextNodes(el)
  if (before.length !== after.length) return null

  const leaves = textLeaves(originalNode)
  // Strict one-to-one: any render-injected text makes the positions ambiguous.
  if (leaves.length !== before.length) return null
  for (let i = 0; i < leaves.length; i++) {
    if (leaves[i].text !== before[i]) return null
  }

  const edits: SurgicalEdit[] = []
  for (let i = 0; i < leaves.length; i++) {
    if (before[i] === after[i]) continue
    edits.push({
      start: leaves[i].range.start,
      end: leaves[i].range.end,
      text: after[i],
    })
  }
  return edits
}

/**
 * The edit for a blank line the user typed into.
 *
 * An `empty_line` node *is* the newline that terminates its own empty line, so
 * filling that line in means replacing the node with the new content plus that
 * same newline. The surrounding blank lines are the author's and stay put:
 *
 *     [centre]…[/centre]        [centre]…[/centre]
 *                          ->   Miliastry
 *     [notice]…[/notice]        [notice]…[/notice]
 */
function fillEmptyLine(
  originalNode: RedNode,
  cleanHtml: string,
  exporter: BBCodeExporter,
): SurgicalEdit[] | null {
  const subtree = HTMLDocumentModel.fromHTML(cleanHtml)
  if (!subtree.redRoot || subtree.redRoot.children.length === 0) return null

  const typed = exporter
    .export(subtree.redRoot.children[0])
    // A contenteditable keeps a bogus trailing `<br>` in a block it just filled;
    // it is the caret's placeholder, not a line the author asked for.
    .replace(/\n+$/, '')
  if (typed === '') return null

  return [{ start: originalNode.range.start, end: originalNode.range.end, text: `${typed}\n` }]
}

/** Parses one rendered fragment and returns its single top-level node, or null. */
function singleNodeOf(html: string, doc: Document): Node | null {
  const probe = doc.createElement('div')
  probe.innerHTML = html
  return probe.childNodes.length === 1 ? probe.childNodes[0] : null
}

/** How many newlines a string ends with. */
function trailingNewlines(text: string): number {
  const match = /\n+$/.exec(text)
  return match ? match[0].length : 0
}

interface ExpectedSlot {
  /** The AST children this slot was rendered from. */
  nodes: RedNode[]
  /** The rendered DOM node for an element slot, or null for a text run. */
  element: Node | null
  /** The rendered text for a text run. */
  text: string
}

/**
 * Groups a node's children into the DOM slots they render into.
 *
 * Consecutive children that render to bare text (a `spacing` or `empty_line`
 * that the renderer emits as a plain newline) end up merged into one text node
 * by the HTML parser, so they have to be grouped the same way here.
 */
function expectedSlots(node: RedNode, renderer: HTMLRenderer, doc: Document): ExpectedSlot[] | null {
  const slots: ExpectedSlot[] = []
  for (const child of node.children) {
    const html = renderer.render(child)
    if (html === '') continue

    const rendered = singleNodeOf(html, doc)
    if (!rendered) return null

    if (rendered.nodeType === 3) {
      const last = slots[slots.length - 1]
      if (last && last.element === null) {
        last.nodes.push(child)
        last.text += rendered.nodeValue ?? ''
        continue
      }
      slots.push({ nodes: [child], element: null, text: rendered.nodeValue ?? '' })
      continue
    }
    slots.push({ nodes: [child], element: rendered, text: '' })
  }
  return slots
}

/**
 * Edits for the children of `node`, by pairing them with the DOM's children.
 *
 * This is what keeps an edit from taking its whole enclosing block with it. The
 * reconciler used to compare only the container's top-level elements, so typing
 * anywhere inside a long `[centre]…[/centre]` re-serialised every line of it —
 * and a document whose tags span many lines is mostly one such element.
 *
 * Returns `null` when the pairing cannot be trusted, which sends the caller to
 * the coarser paths.
 */
function descend(
  node: RedNode,
  el: HTMLElement,
  exporter: BBCodeExporter,
  renderer: HTMLRenderer,
): SurgicalEdit[] | null {
  const slots = expectedSlots(node, renderer, el.ownerDocument)
  if (!slots || slots.length === 0) return null

  const actual = Array.from(el.childNodes)
  if (actual.length !== slots.length) return null

  const edits: SurgicalEdit[] = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const got = actual[i]

    if (slot.element === null) {
      if (got.nodeType !== 3) return null
      const text = (got.nodeValue ?? '').replace(ZWSP, '')
      if (text === slot.text) continue
      // A text run is only ever line structure — `spacing` and `empty_line`
      // rendered as bare newlines. Anything else would need the exporter and is
      // not safe to guess at.
      if (slot.nodes.some(n => n.kind !== 'spacing' && n.kind !== 'empty_line')) return null
      // The DOM text already carries its own newlines, so it goes to the source
      // as written. The one thing it must not do is lose the newline that used
      // to close the run, or the typed text glues onto the block below it.
      const closed = trailingNewlines(slot.text) > 0
      edits.push({
        start: slot.nodes[0].range.start,
        end: slot.nodes[slot.nodes.length - 1].range.end,
        text: closed && trailingNewlines(text) === 0 ? `${text}\n` : text,
      })
      continue
    }

    if (got.nodeType !== 1) return null
    const gotEl = got as HTMLElement
    const wantEl = slot.element as HTMLElement
    if (gotEl.getAttribute('data-node-id') !== wantEl.getAttribute('data-node-id')) return null
    if (gotEl.outerHTML.replace(ZWSP, '') === wantEl.outerHTML.replace(ZWSP, '')) continue

    const childEdits = editsForNode(slot.nodes[0], gotEl, exporter, renderer)
    if (!childEdits) return null
    edits.push(...childEdits)
  }

  return edits
}

/**
 * The edits for one AST node whose DOM no longer matches its render.
 *
 * Ordered cheapest-and-most-precise first: fill a blank line, descend into the
 * children, rewrite only the changed text leaves, and only then rebuild the
 * node from its DOM.
 */
function editsForNode(
  node: RedNode,
  el: HTMLElement,
  exporter: BBCodeExporter,
  renderer: HTMLRenderer,
): SurgicalEdit[] | null {
  const cleanHtml = el.outerHTML.replace(ZWSP, '')
  const rendered = renderer.render(node).replace(ZWSP, '')
  if (cleanHtml === rendered) return []

  if (node.kind === 'empty_line') return fillEmptyLine(node, cleanHtml, exporter)

  return (
    descend(node, el, exporter, renderer)
    ?? diffTextLeaves(node, rendered, el)
    ?? reserializeElement(node, cleanHtml, exporter)
  )
}

/** Last resort for one element: rebuild just that block from its DOM. */
function reserializeElement(
  originalNode: RedNode,
  cleanHtml: string,
  exporter: BBCodeExporter,
): SurgicalEdit[] | null {
  const subtree = HTMLDocumentModel.fromHTML(cleanHtml)
  if (!subtree.redRoot || subtree.redRoot.children.length === 0) return null
  return [
    {
      start: originalNode.range.start,
      end: originalNode.range.end,
      text: exporter.export(subtree.redRoot.children[0]).trim(),
    },
  ]
}

/**
 * The edits for whatever the user deleted.
 *
 * Walking the DOM only ever finds what still exists, so a block the user
 * removed produced no edit at all: the canvas showed it gone, the source still
 * had it, and the next repaint brought it back. The DOM is the truth here — any
 * top-level node whose id is no longer in it was deleted.
 *
 * Nodes that render to nothing carry no id into the DOM, so their absence
 * proves nothing and they are left alone.
 */
function deletionsFor(
  originalAST: RedNode,
  editorContainer: HTMLElement,
  renderer: HTMLRenderer,
): SurgicalEdit[] {
  const present = new Set<string>()
  for (const el of Array.from(editorContainer.querySelectorAll('[data-node-id]'))) {
    const id = el.getAttribute('data-node-id')
    if (id) present.add(id)
  }

  const out: SurgicalEdit[] = []
  for (const child of originalAST.children) {
    if (!child.id || present.has(child.id)) continue
    if (!renderer.render(child).includes('data-node-id')) continue
    out.push({ start: child.range.start, end: child.range.end, text: '' })
  }
  return out
}

/**
 * Reconciles the visual DOM of a contenteditable container against the original BBCode document AST.
 * Produces minimal, non-destructive surgical edits preserving untouched BBCode blocks and structure.
 */
export function reconcileVisualDOMToBBCode(
  originalSource: string,
  originalAST: RedNode | null,
  editorContainer: HTMLElement,
  exporter: BBCodeExporter = new BBCodeExporter(),
  renderer: HTMLRenderer = new HTMLRenderer()
): ReconcileResult {
  const fullFallback = (): ReconcileResult => {
    const rawHtml = editorContainer.innerHTML.replace(ZWSP, '').trim()
    const doc = HTMLDocumentModel.fromHTML(rawHtml)
    const exported = doc.redRoot
      ? exporter.export(doc.redRoot)
      : editorContainer.innerText.replace(ZWSP, '').trim()
    const edits = computeTextDelta(originalSource, exported)
    return { edits, hasChanges: edits.length > 0, resultingSource: exported }
  }

  if (!originalAST || !originalSource) return fullFallback()

  const idMap = buildNodeIdMap(originalAST)

  // The container renders the document node's children, so the same pairing
  // used inside a block works here — including for a blank line that the
  // renderer emitted as a bare newline instead of an element. Typing into one
  // of those used to be an unmatched top-level text node, which sent the whole
  // document through the re-serialising fallback.
  const topLevel = descend(originalAST, editorContainer, exporter, renderer)
  if (topLevel) {
    return finalise(originalSource, [...topLevel, ...deletionsFor(originalAST, editorContainer, renderer)])
  }

  const edits: SurgicalEdit[] = []
  const childNodes = Array.from(editorContainer.childNodes)
  let requiresFullFallback = false

  for (const node of childNodes) {
    if (node.nodeType === 1) {
      const el = node as HTMLElement
      const tag = el.tagName.toLowerCase()

      if (tag === 'br') {
        continue
      }

      const nodeId = el.getAttribute('data-node-id')

      if (nodeId && idMap.has(nodeId)) {
        const elementEdits = editsForNode(idMap.get(nodeId)!, el, exporter, renderer)
        if (!elementEdits) {
          requiresFullFallback = true
          break
        }
        edits.push(...elementEdits)
      } else {
        // Element without ID or newly added/split block -> fallback to full clean serialize
        requiresFullFallback = true
        break
      }
    } else if (node.nodeType === 3) {
      const text = (node.nodeValue || '').replace(ZWSP, '').trim()
      if (text.length > 0) {
        requiresFullFallback = true
        break
      }
    }
  }

  if (requiresFullFallback) return fullFallback()

  return finalise(originalSource, [...edits, ...deletionsFor(originalAST, editorContainer, renderer)])
}

/** Applies the collected edits bottom-to-top so earlier ranges stay valid. */
function finalise(originalSource: string, edits: SurgicalEdit[]): ReconcileResult {
  if (edits.length === 0) {
    return {
      edits: [],
      hasChanges: false,
      resultingSource: originalSource,
    }
  }

  const sortedEdits = [...edits].sort((a, b) => b.start - a.start)
  let updatedSource = originalSource
  for (const edit of sortedEdits) {
    updatedSource = updatedSource.slice(0, edit.start) + edit.text + updatedSource.slice(edit.end)
  }

  return {
    edits: sortedEdits,
    hasChanges: true,
    resultingSource: updatedSource,
  }
}
