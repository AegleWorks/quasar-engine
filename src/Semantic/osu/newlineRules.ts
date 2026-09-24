/**
 * osu!'s newline rules, as data: how many newlines each construct swallows
 * around its own tags. Facts about the DOCUMENT under osu!'s renderer, not
 * about HTML, so they live here rather than in `HTMLRenderer`, which used to
 * own them (see docs/10-Semantic-Model-Plan.md). Pure data and pure
 * functions: nothing here renders or exports anything.
 */

import type { RedNode } from '../../Syntax/RedNode'
import { tagToNodeKind, type BBCodeDialect } from '../../BBCode/BBCodeToGreenNode'

/** How many newlines a construct swallows around its own tags. */
export interface NewlineRule {
  /** Newlines eaten right after the opening tag. */
  readonly afterOpen: 'all' | 'whitespace' | 'one' | 'none'
  /** Newlines eaten right before the closing tag. */
  readonly beforeClose: 'all' | 'whitespace' | 'none'
  /** Whitespace eaten right before the OPENING tag (`\s*\[\*\]`). */
  readonly beforeOpen: 'whitespace' | 'none'
  /** Newlines eaten right after the closing tag. */
  readonly afterClose: number
}

/**
 * Every block the legacy rule applies to when `NEWLINE_RULES` has no row of
 * its own (Miliastry-only blocks). Was `HTMLRenderer.BLOCK_TAGS`.
 */
export const BLOCK_KINDS: ReadonlySet<string> = new Set([
  'notice', 'wnotice', 'spoilerbox', 'box', 'boxw', 'list', 'quote', 'code', 'svg',
  'heading', 'center', 'right', 'left', 'align', 'imagemap', 'image', 'document',
  'tables', 'table_row', 'gallery', 'columns', 'separator', 'scroll',
  'container',
])

// osu! turns newlines into `<br />` with one flat rule at the very end of
// `BBCodeFromDB::toHTML` — `str_replace("\n", '<br />')`. Every subtlety
// lives BEFORE that line: each block pass is a regex that eats the newlines
// touching its own tags, so those newlines are simply gone by the time the
// flat rule runs. The amount eaten differs per tag, and the asymmetries are
// not decorative:
//
//   parseBox      `\[box=…\]\n*`   `\n*\[/box\]\n?`
//   parseCode     `\[code\]\n*`    `\n*\[/code\]\n?`
//   parseNotice   `\[notice\]\n*`  `\n*\[/notice\]\n?`
//   parseList     `\s*\[\*\]`      `\s*\[/list\]\n?\n?`
//   parseQuote    `\[quote…\]\s*`  `\s*\[/quote\]\n?\n?`
//   parseHeading  —                `\[/heading\]\n?`
//   parseImagemap —                `\[/imagemap\]\n?`
//   parseAlignment  strtr of `[centre]\n` and `[/centre]\n` — exactly one
//
// Quasar used to approximate all of that with two neighbourhood heuristics
// (`isPrevBlockBoundary` / `isTrailingBlockBoundary`) that treated every
// block alike, so they over-ate at `[centre]`/`[/imagemap]` and under-ate at
// `[/list]`/`[/quote]`. This models the real rules instead.
//
// Deliberately NOT gated on the dialect: Miliastry is "osu with steroids"
// and has to break lines the same way. Blocks that only exist in Miliastry
// (tables, gallery, columns, scroll, …) have no osu counterpart to copy, so
// they keep the legacy behaviour via {@link LEGACY_BLOCK_RULE}.

/** How many newlines a construct swallows around its own tags. */
export const NEWLINE_RULES: Readonly<Record<string, NewlineRule>> = {
  // `\n*` inside both edges, one newline after the close.
  box:        { afterOpen: 'all', beforeClose: 'all', beforeOpen: 'none', afterClose: 1 },
  boxw:       { afterOpen: 'all', beforeClose: 'all', beforeOpen: 'none', afterClose: 1 },
  spoilerbox: { afterOpen: 'all', beforeClose: 'all', beforeOpen: 'none', afterClose: 1 },
  notice:     { afterOpen: 'all', beforeClose: 'all', beforeOpen: 'none', afterClose: 1 },
  wnotice:    { afterOpen: 'all', beforeClose: 'all', beforeOpen: 'none', afterClose: 1 },
  code:       { afterOpen: 'all', beforeClose: 'all', beforeOpen: 'none', afterClose: 1 },
  // `\s*` — not just newlines — and TWO newlines after the close.
  quote:      { afterOpen: 'whitespace', beforeClose: 'whitespace', beforeOpen: 'none', afterClose: 2 },
  // `[list]` itself eats nothing after its opening tag: the pass that eats
  // is `\s*\[\*\]`, which needs an item to follow. `[list]\n\nloose text`
  // keeps both newlines; `[list]\n[*]a` loses one to the item, not the list.
  list:       { afterOpen: 'none', beforeClose: 'whitespace', beforeOpen: 'none', afterClose: 2 },
  // `\s*\[\*\]`. The matching `[/*]` of the table exists only in legacy
  // phpBB rows — `BBCodeForDB` never emits one — so the item's close is
  // width-less here and its two-newline budget is unreachable by design;
  // `[*]a\n\n[*]b` loses both newlines to the NEXT item's `\s*`, which is
  // the same output by a different route.
  list_item:  { afterOpen: 'none', beforeClose: 'none', beforeOpen: 'whitespace', afterClose: 0 },
  // strtr with `[centre]\n` / `[/centre]\n`: exactly one on each outer edge,
  // and nothing before the close — `x\n[/centre]` really does keep its `<br>`.
  center:     { afterOpen: 'one', beforeClose: 'none', beforeOpen: 'none', afterClose: 1 },
  left:       { afterOpen: 'one', beforeClose: 'none', beforeOpen: 'none', afterClose: 1 },
  right:      { afterOpen: 'one', beforeClose: 'none', beforeOpen: 'none', afterClose: 1 },
  align:      { afterOpen: 'one', beforeClose: 'none', beforeOpen: 'none', afterClose: 1 },
  heading:    { afterOpen: 'none', beforeClose: 'none', beforeOpen: 'none', afterClose: 1 },
  imagemap:   { afterOpen: 'none', beforeClose: 'none', beforeOpen: 'none', afterClose: 1 },
  // `[img]` is inline in osu and swallows nothing at all.
  image:      { afterOpen: 'none', beforeClose: 'none', beforeOpen: 'none', afterClose: 0 },
  document:   { afterOpen: 'none', beforeClose: 'none', beforeOpen: 'none', afterClose: 0 },
  // No `discarded_box_close` row here on purpose: it is never looked up by
  // KIND (it is a leaf, never a `parent.kind` in the `eaten*` scans below)
  // — `closingRule` resolves its budget from its own text instead, the
  // same way `discarded_tag` always has (see `discardedTagRule`), because
  // it can now stand for any of FIVE different tags, not just `box`/
  // `spoilerbox` (`Parser.ts`'s `closeDivUnits`).
}

/**
 * What a Miliastry-only block does. This is what the old
 * `isPrevBlockBoundary` / `isTrailingBlockBoundary` pair did for every block:
 * eat the first newline after the open, every newline before the close, and
 * the first newline after the close.
 */
export const LEGACY_BLOCK_RULE: NewlineRule = {
  afterOpen: 'one', beforeClose: 'all', beforeOpen: 'none', afterClose: 1,
} as const

/**
 * Containers whose opening tag occupies no source text, so a backwards scan
 * has to walk straight through them.
 */
export const WIDTHLESS_OPEN: ReadonlySet<string> = new Set(['paragraph', 'group'])

/**
 * Same for the closing side. `list_item` is here because `[/*]` is never
 * written: an item ends where the next `[*]` or the `[/list]` begins, so
 * `\s*\[/list\]` sees the newline that Quasar stores inside the item.
 */
export const WIDTHLESS_CLOSE: ReadonlySet<string> = new Set(['paragraph', 'group', 'list_item'])

/**
 * `pairing: 'osu'` only — the four div-emitting kinds that can be closed
 * by an UNRELATED crossing closer instead of their own (`Parser.ts`'s
 * `closeDivUnits`; `box`/`spoilerbox` are deliberately NOT here — their
 * own crossing already has a dedicated `box_tail`/`WIDTHLESS_CLOSE`-free
 * path). See `eatenByClosingTag`.
 */
export const CROSSABLE_DIV_KINDS: ReadonlySet<string> = new Set(['notice', 'center', 'left', 'right'])

/**
 * Descend through widthless-open wrappers (`paragraph`, `group`) to the
 * FIRST real child, the mirror of how `eatenAfterClosingTag` descends
 * through `WIDTHLESS_CLOSE` to the LAST one. Used only to find a
 * `discarded_box_close` that root normalization left as a paragraph's
 * first child instead of a direct root-level sibling (see Parser.ts).
 */
export function firstNonWidthlessOpenChild(node: RedNode): RedNode {
  let cur = node
  while (WIDTHLESS_OPEN.has(cur.kind) && cur.children.length > 0) {
    cur = cur.children[0]
  }
  return cur
}

export function newlineRule(kind: string): NewlineRule | null {
  const rule = NEWLINE_RULES[kind]
  if (rule) return rule
  return BLOCK_KINDS.has(kind) ? LEGACY_BLOCK_RULE : null
}

/**
 * `[/box]` recovered from a `discarded_tag` leaf's own text, same shape as
 * `SemanticAnalyzer`'s `DISCARDED_CLOSING_TAG` (which pairs these leaves
 * with the opener a crossing auto-closed, for the `crossed-tags`
 * diagnostic). A `discarded_tag` never arises any other way — the legacy
 * closing-tag walk in `Parser.ts` only mints one when `tok.tag` is already
 * in `autoClosed`, i.e. an opener for it existed earlier and a crossing
 * close already claimed it — so every leaf here really did close SOME
 * tag, just too late to count. A genuinely orphan lazy-family closer with
 * no opener anywhere is never even a `discarded_tag`/`discarded_box_close`
 * — `Osu/osuPairing.ts`'s `sealLazy` forces it to plain literal `text`
 * before the tree is even built (see its own module doc).
 */
export const DISCARDED_CLOSING_TAG = /^\[\/([a-zA-Z0-9_*-]+)\]$/

/**
 * The close-side newline rule the tag a `discarded_tag`/`discarded_box_close`
 * leaf WOULD have closed carries, if any — `[/box]` gets `box`'s own
 * `beforeClose`/`afterClose` budget, `[/centre]` gets `center`'s (a
 * DIFFERENT budget — see `NEWLINE_RULES`), `[/b]` gets `null` (inline tags
 * carry no newline budget in osu, so a stranded `[/b]` eats nothing, same
 * as a matched one). Resolved from the leaf's own text rather than
 * threaded through as metadata: the tag name only exists once, in the
 * source, and every other consumer of `discarded_tag` (the `crossed-tags`
 * diagnostic, the incremental parser) already recovers it the same way
 * instead of widening the node shape. Also covers `discarded_box_close`
 * (`pairing: 'osu'` only): `Parser.ts`'s `closeDivUnits` mints one for ANY
 * of its five div-emitting tags — not just `box`/`spoilerbox` — once
 * arriving with nothing left open to close, and each needs ITS OWN budget,
 * not box's.
 */
export function discardedTagRule(text: string, dialect: BBCodeDialect): NewlineRule | null {
  const match = DISCARDED_CLOSING_TAG.exec(text)
  if (!match) return null
  return newlineRule(tagToNodeKind(match[1].toLowerCase(), dialect))
}
