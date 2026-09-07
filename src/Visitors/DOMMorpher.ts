/**
 * DocumentEngine — DOMMorpher
 *
 * Reconciles and morphs an existing HTML DOM tree in-place to match a new HTML string.
 * Operating on pure HTML string output from HTMLRenderer means ZERO changes to Quasar AST schemas.
 *
 * Features:
 * - In-place attribute synchronization
 * - In-place text node value updates
 * - Preserves state of unchanged elements (spoilers, audio/video, selections)
 * - Zero extra wrapper <div> elements
 */

export function morphHTML(container: HTMLElement, newHTML: string): void {
  if (container.childNodes.length === 0) {
    container.innerHTML = newHTML
    return
  }

  const template = document.createElement('template')
  template.innerHTML = newHTML

  morphNodes(container, template.content)
}

/**
 * Reconcile `parent`'s children against `newParent`'s.
 *
 * Children are paired positionally, which is why the identical prefix and
 * suffix are trimmed first: without that, inserting a single node near the
 * start shifts every following sibling by one, so each one compares against the
 * wrong counterpart and gets rewritten — the exact cascade a morpher exists to
 * avoid.
 *
 * Trimming uses `isEqualNode`, a native deep structural comparison. A subtree
 * that compares equal is left completely untouched: no recursion, no attribute
 * loops, and — because the DOM node is never replaced — any runtime state it
 * holds (open spoilers, media playback, selection) survives for free.
 *
 * Note on keys: the obvious next step would be pairing by `data-node-id`, but
 * those are regenerated on every parse. Measured on a one-character edit,
 * **zero** ids survive a rebuild, so keying on them would make every node look
 * new and reduce the morpher to a full replacement. That needs identity that is
 * stable across re-parses first.
 */
function morphNodes(parent: Node, newParent: Node): void {
  const oldNodes = parent.childNodes
  const newNodes = newParent.childNodes

  // ── Phase 1: trim the identical prefix and suffix ──────────────
  // Nothing is mutated here, so reading the live NodeLists is safe.
  const limit = Math.min(oldNodes.length, newNodes.length)

  let lo = 0
  while (lo < limit && oldNodes[lo].isEqualNode(newNodes[lo])) lo++

  let oldHi = oldNodes.length - 1
  let newHi = newNodes.length - 1
  while (oldHi >= lo && newHi >= lo && oldNodes[oldHi].isEqualNode(newNodes[newHi])) {
    oldHi--
    newHi--
  }

  // Everything matched — this whole level is already correct.
  if (lo > oldHi && lo > newHi) return

  // ── Phase 2: reconcile only the window between them ────────────
  // Snapshot before touching anything: the loop mutates `parent`, which would
  // shift a live NodeList underneath us. Only the changed window is copied.
  const oldChildren: Node[] = []
  for (let i = lo; i <= oldHi; i++) oldChildren.push(oldNodes[i])
  const newChildren: Node[] = []
  for (let i = lo; i <= newHi; i++) newChildren.push(newNodes[i])

  // Insertions must land before the preserved suffix, not at the end. Captured
  // now, while indices still refer to the pre-mutation DOM.
  const suffixAnchor: Node | null = oldNodes[oldHi + 1] ?? null

  const maxLen = Math.max(oldChildren.length, newChildren.length)

  for (let i = 0; i < maxLen; i++) {
    const oldNode = oldChildren[i]
    const newNode = newChildren[i]

    if (!oldNode && newNode) {
      parent.insertBefore(newNode.cloneNode(true), suffixAnchor)
    } else if (oldNode && !newNode) {
      parent.removeChild(oldNode)
    } else if (oldNode && newNode) {
      if (oldNode.nodeType === 3 && newNode.nodeType === 3) {
        // Text node: update nodeValue in-place
        if (oldNode.nodeValue !== newNode.nodeValue) {
          oldNode.nodeValue = newNode.nodeValue
        }
      } else if (
        oldNode.nodeType === 1 &&
        newNode.nodeType === 1 &&
        (oldNode as Element).tagName === (newNode as Element).tagName
      ) {
        morphElement(oldNode as Element, newNode as Element)
      } else {
        // Different tag or nodeType: replace node
        oldNode.parentNode!.replaceChild(newNode.cloneNode(true), oldNode)
      }
    }
  }
}

/**
 * Reconcile two HTML elements of the same tag in-place.
 * Syncs attributes, preserves interactive states (<details open>, .open classes),
 * and recursively morphs child nodes.
 */
export function morphElement(oldEl: Element, newEl: Element): void {
  // Preserve interactive runtime states (such as <details open> for spoilerboxes and boxes)
  if (oldEl.tagName === 'DETAILS' && oldEl.hasAttribute('open')) {
    newEl.setAttribute('open', '')
  }
  if (oldEl.classList.contains('open')) {
    newEl.classList.add('open')
  }
  if (oldEl.classList.contains('is-open')) {
    newEl.classList.add('is-open')
  }

  // Sync attributes in-place.
  //
  // `attributes` se recorre por índice: `Array.from` asignaba un array
  // por elemento y por sentido, dos por pareja morfada, y esto corre
  // sobre la ventana cambiada en cada pulsación.
  const newAttrs = newEl.attributes
  for (let i = 0; i < newAttrs.length; i++) {
    const attr = newAttrs[i]
    if (oldEl.getAttribute(attr.name) !== attr.value) {
      oldEl.setAttribute(attr.name, attr.value)
    }
  }
  // Hacia atrás: quitar un atributo compacta la colección viva, y
  // recorrerla hacia delante mientras se borra se salta el siguiente.
  const oldAttrs = oldEl.attributes
  for (let i = oldAttrs.length - 1; i >= 0; i--) {
    const name = oldAttrs[i].name
    if (!newEl.hasAttribute(name)) {
      oldEl.removeAttribute(name)
    }
  }

  // Morph child nodes recursively
  morphNodes(oldEl, newEl)
}
