/**
 * Inline formatting as text edits — what the toolbar's Bold, Italic, …, Color
 * mean, computed from the tree and never from the DOM.
 *
 * The WYSIWYG canvas used to hand these to `document.execCommand`, which
 * rewrites the DOM as the browser sees fit (`<b>`, `<strong>`, `<font>`,
 * a `style` span, a split element), and the reconciler then had to INFER from
 * that HTML what the author meant. Inference rebuilt whole elements and lost
 * the author's spelling around them. Here the intent is explicit: a range and
 * a format in, the minimal `TextChange`s out — insert `[b]` here and `[/b]`
 * there — so everything outside those few characters is untouched by
 * construction.
 *
 * ─── Shape of the edit ─────────────────────────────────────────────────────
 *
 * The selection is cut into RUNS: maximal stretches of inline content under
 * one parent, broken at line breaks and at blocks. A tag opened in a run
 * closes in the same run, so the result is always well nested — bold never
 * straddles an `[i]` boundary or leaks across a `[box]` edge; a selection
 * that does gets one wrapper per run instead.
 *
 * Toggling OFF strips the enclosing tag and wraps back what stays formatted
 * (before and after the selection) with the author's own spelling of that
 * tag: `[B]abc[/B]` with "b" selected becomes `[B]a[/B]b[B]c[/B]`, and inside
 * `[b][i]abc[/i][/b]` it becomes `[i][b]a[/b]b[b]c[/b][/i]` — the runs keep
 * the nesting right with no special case.
 */

import type { RedNode } from '../Syntax/RedNode'
import type { NodeKind } from '../Types/core'
import type { TextChange } from '../Incremental/ChangeTracker'
import { isBlockKind } from '../BBCode/BBCodeToGreenNode'
import { transformRange } from '../Collab/positions'

export type ToggleFormat = 'bold' | 'italic' | 'underline' | 'strikethrough'

export interface SourceSelection {
  start: number
  end: number
}

export interface FormatEdit {
  /** Non-overlapping, sorted by `start`, all in the coordinates of the source given. */
  changes: TextChange[]
  /** Where the formatted text ended up, in the coordinates of the edited source. */
  selection: SourceSelection
  action: 'wrap' | 'unwrap' | 'recolor' | 'break' | 'join' | 'delete' | 'insert'
}

const OPEN: Record<ToggleFormat, string> = { bold: '[b]', italic: '[i]', underline: '[u]', strikethrough: '[s]' }
const CLOSE: Record<ToggleFormat, string> = { bold: '[/b]', italic: '[/i]', underline: '[/u]', strikethrough: '[/s]' }

/** Children that separate runs without being containers to descend into. */
function isLineBreak(kind: string): boolean {
  return kind === 'spacing' || kind === 'empty_line' || kind === 'box_tail'
}

/** A stretch of inline content under one parent; `[start, end)` in the source. */
interface Run {
  parent: RedNode
  start: number
  end: number
  /** Inline elements lying wholly inside the run (not text leaves). */
  whole: RedNode[]
}

/**
 * The runs `[start, end)` covers.
 *
 * A child that lies wholly inside the range joins the run as a unit — text,
 * or an inline element with everything in it. One that is cut by an end of
 * the range, a line break or a block ends the run; the cut one is descended
 * into, so its part of the selection forms runs of its own, one level down.
 */
function runsIn(node: RedNode, start: number, end: number, out: Run[]): void {
  let run: Run | null = null
  const close = () => {
    if (run && run.end > run.start) out.push(run)
    run = null
  }
  for (const child of node.children) {
    const r = child.range
    if (r.end <= start || r.start >= end) {
      close()
      continue
    }
    const kind = child.kind
    if (kind === 'text') {
      const s = Math.max(start, r.start)
      const e = Math.min(end, r.end)
      if (run) run.end = e
      else run = { parent: node, start: s, end: e, whole: [] }
      if (e < r.end) close()
      continue
    }
    if (isLineBreak(kind)) {
      close()
      continue
    }
    const inline = !isBlockKind(kind as NodeKind)
    if (inline && r.start >= start && r.end <= end && child.children.length > 0) {
      if (run) run.end = r.end
      else run = { parent: node, start: r.start, end: r.end, whole: [] }
      run.whole.push(child)
      continue
    }
    close()
    runsIn(child, start, end, out)
  }
  close()
}

/** `node` and its ancestors, nearest first, stopping before the root. */
function nearest(node: RedNode, kind: string): RedNode | null {
  for (let n: RedNode | null = node; n && n.parent; n = n.parent) {
    if (n.kind === kind) return n
  }
  return null
}

/** Every node of `kind` in `node`'s subtree, `node` included. */
function allOfKind(node: RedNode, kind: string, out: RedNode[]): void {
  if (node.kind === kind) out.push(node)
  for (const child of node.children) allOfKind(child, kind, out)
}

/** Whether all the text a run holds is already formatted with `kind`. */
function covered(run: Run, kind: string): boolean {
  if (nearest(run.parent, kind)) return true
  // No enclosing tag: the run is covered only when it is nothing but whole
  // elements of that kind (a selection hugging `[b]x[/b]` from outside).
  let pos = run.start
  for (const w of run.whole) {
    if (w.range.start !== pos || w.kind !== kind) return false
    pos = w.range.end
  }
  return pos === run.end
}

/**
 * The word a caret is INSIDE, or null.
 *
 * Only strictly inside: at the edge of a word ("hola|") the user is typing,
 * and Bold there means "what I type next", which is the caller's to handle —
 * turning the word behind the caret bold would surprise them.
 */
function wordAt(root: RedNode, source: string, offset: number): SourceSelection | null {
  const isWord = (ch: string) => /[\p{L}\p{N}_'’-]/u.test(ch)
  const leaf = root.findNodeAtOffset(offset)
  const prev = offset > 0 ? root.findNodeAtOffset(offset - 1) : null
  const host = leaf?.kind === 'text' ? leaf : prev?.kind === 'text' ? prev : null
  if (!host) return null
  const { start: lo, end: hi } = host.range
  let s = offset
  let e = offset
  while (s > lo && isWord(source[s - 1])) s--
  while (e < hi && isWord(source[e])) e++
  return s < offset && offset < e ? { start: s, end: e } : null
}

/** Sorts and fuses changes that touch, so the list is safe to apply in order. */
function normalise(changes: TextChange[]): TextChange[] {
  const sorted = [...changes].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: TextChange[] = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c.start <= last.end) {
      // Insertions at one point keep the order they were produced in.
      last.text += c.text
      last.end = Math.max(last.end, c.end)
    } else {
      out.push({ ...c })
    }
  }
  return out
}

/** Removes the tags of `node`, keeping its content. */
function strip(node: RedNode, out: TextChange[]): void {
  out.push({ start: node.range.start, end: node.innerStart, text: '' })
  out.push({ start: node.innerEnd, end: node.range.end, text: '' })
}

/** Wraps every run of `[start, end)` inside `scope` in `open`…`close`. */
function wrapRuns(scope: RedNode, start: number, end: number, open: string, close: string, out: TextChange[]): void {
  if (end <= start) return
  const runs: Run[] = []
  runsIn(scope, start, end, runs)
  for (const run of runs) {
    out.push({ start: run.start, end: run.start, text: open })
    out.push({ start: run.end, end: run.end, text: close })
  }
}

/**
 * Where the formatted text lands. The changes are simultaneous (all in the
 * original coordinates); taken last to first they are a valid SEQUENCE, which
 * is what `transformRange` maps through — its start sticks right and its end
 * left, so the tags inserted at the edges stay outside the selection.
 */
function selectionOf(requested: SourceSelection, runs: Run[], changes: TextChange[]): SourceSelection {
  const start = runs.length ? runs[0].start : requested.start
  const end = runs.length ? runs[runs.length - 1].end : requested.end
  return transformRange({ start, end }, [...changes].reverse())
}

/**
 * Bold, italic, underline or strikethrough ON the selection, or OFF it when
 * every character in it already has that format.
 *
 * A collapsed selection applies to the word the caret is inside, as document
 * editors do; anywhere else it answers null and the caller decides.
 */
export function toggleInlineFormat(
  root: RedNode,
  source: string,
  selection: SourceSelection,
  format: ToggleFormat,
): FormatEdit | null {
  const range = selection.start === selection.end ? wordAt(root, source, selection.start) : selection
  if (!range) return null

  const runs: Run[] = []
  runsIn(root, Math.min(range.start, range.end), Math.max(range.start, range.end), runs)
  if (runs.length === 0) return null

  const changes: TextChange[] = []
  const allCovered = runs.every(run => covered(run, format))

  if (!allCovered) {
    for (const run of runs) {
      if (covered(run, format)) continue
      // Same-format elements inside the run would nest in the new wrapper.
      for (const w of run.whole) {
        const inner: RedNode[] = []
        allOfKind(w, format, inner)
        for (const n of inner) strip(n, changes)
      }
      changes.push({ start: run.start, end: run.start, text: OPEN[format] })
      changes.push({ start: run.end, end: run.end, text: CLOSE[format] })
    }
    const normal = normalise(changes)
    return { changes: normal, selection: selectionOf(range, runs, normal), action: 'wrap' }
  }

  // OFF: strip each enclosing tag once, and wrap back what the selection leaves
  // formatted inside it, spelled as the author spelled that tag.
  const enclosing = new Map<RedNode, Run[]>()
  for (const run of runs) {
    const host = nearest(run.parent, format)
    if (host) {
      const list = enclosing.get(host)
      if (list) list.push(run)
      else enclosing.set(host, [run])
    }
    for (const w of run.whole) {
      const inner: RedNode[] = []
      allOfKind(w, format, inner)
      for (const n of inner) strip(n, changes)
    }
  }
  for (const [host, inside] of enclosing) {
    const open = source.slice(host.range.start, host.innerStart)
    const close = source.slice(host.innerEnd, host.range.end)
    strip(host, changes)
    let pos = host.innerStart
    for (const run of inside) {
      wrapRuns(host, pos, run.start, open, close, changes)
      pos = run.end
    }
    wrapRuns(host, pos, host.innerEnd, open, close, changes)
  }
  const normal = normalise(changes)
  return { changes: normal, selection: selectionOf(range, runs, normal), action: 'unwrap' }
}

/**
 * Color on the selection.
 *
 * A selection that is exactly the content of a `[color]` recolors that tag
 * in place — its value and nothing else, so `[COLOR="#abc"]` keeps its
 * casing and quotes. Anything else is wrapped, run by run, and any `[color]`
 * lying wholly inside the selection is dropped: the author asked for all of
 * it in the new color, and a nested tag would win over the new one.
 */
export function applyColor(
  root: RedNode,
  source: string,
  selection: SourceSelection,
  color: string,
): FormatEdit | null {
  const range = selection.start === selection.end ? wordAt(root, source, selection.start) : selection
  if (!range) return null

  const runs: Run[] = []
  runsIn(root, Math.min(range.start, range.end), Math.max(range.start, range.end), runs)
  if (runs.length === 0) return null

  const changes: TextChange[] = []
  let recolored = 0
  for (const run of runs) {
    const host = nearest(run.parent, 'color')
    const exact =
      host && host.innerStart === run.start && host.innerEnd === run.end
        ? host
        : run.whole.length === 1 && run.whole[0].kind === 'color' && run.whole[0].range.start === run.start && run.whole[0].range.end === run.end
          ? run.whole[0]
          : null
    if (exact) {
      const open = source.slice(exact.range.start, exact.innerStart)
      const m = /^(\[color=)("?)[^\]"]*("?)\]$/i.exec(open)
      changes.push({
        start: exact.range.start,
        end: exact.innerStart,
        text: m ? `${m[1]}${m[2]}${color}${m[3]}]` : `[color=${color}]`,
      })
      recolored++
      continue
    }
    for (const w of run.whole) {
      const inner: RedNode[] = []
      allOfKind(w, 'color', inner)
      for (const n of inner) strip(n, changes)
    }
    changes.push({ start: run.start, end: run.start, text: `[color=${color}]` })
    changes.push({ start: run.end, end: run.end, text: '[/color]' })
  }
  const normal = normalise(changes)
  return {
    changes: normal,
    selection: selectionOf(range, runs, normal),
    action: recolored === runs.length ? 'recolor' : 'wrap',
  }
}
