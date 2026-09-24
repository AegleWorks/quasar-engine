/**
 * DocumentEngine — osuPairing
 *
 * Decides, for `pairing: 'osu'` (see `ParseOptions.pairing`), which `open`/
 * `close` tokens from `scanBBCode()` osu! itself would turn into real tags —
 * and demotes every other one to a `text` token, unchanged in position,
 * BEFORE `parseTokensToGreen` ever sees them. Source offsets never move: a
 * demoted token keeps its exact `start`/`end`, so node ranges in the
 * resulting tree still line up with the editor's shared model.
 *
 * This is NOT a re-implementation of osu!'s structural nesting (auto-close,
 * `discarded_tag`, `error` in strict mode, paragraph grouping, …) — all of
 * that keeps running unmodified in `parseTokensToGreen` on whatever tokens
 * survive this filter. This module answers exactly one question per
 * occurrence: would osu!'s own `BBCodeForDB::generate()` have sealed this
 * particular `[tag]`/`[/tag]` with its uid marker, or left it as literal
 * text? Implemented from OBSERVED behaviour (harness-measured — see
 * `packages/quasar/src/Tests/OsuBehaviour.test.ts`) and cross-checked
 * against the shape of osu-web's own regex passes; no osu-web source is
 * copied here (AGPL).
 *
 * ─── Why osu!'s sealing looks nothing like a parser ──────────────────────
 *
 * osu! never builds a tree. `BBCodeForDB::generate()` runs ~20 regex passes
 * over the raw text, one pass per tag (or tag FAMILY — `b`/`i`/`strike`/`s`/
 * `u`/`spoiler` are five INDEPENDENT passes, not one shared rule, so
 * `[s]a[strike]b[/s]` pairs only the `s`), each pass sealing what it can with
 * a per-tag regex and leaving everything else as plain text for the next
 * pass — or for no pass at all. `BBCodeFromDB::toHTML()` later trusts every
 * seal at face value and just swaps markers for HTML; it does no pairing of
 * its own (box/spoilerbox nesting "works" there only because matched HTML
 * elements nest correctly on their own).
 *
 * That produces five distinct sealing STRATEGIES, mapped below to the exact
 * osu! tag names that use each one (never Quasar's kind, and never a
 * Quasar-only spelling — see the case-sensitivity and alias notes below):
 *
 * 1. **lazy** — `b i u s strike spoiler notice centre left right color size
 *    heading audio profile email url youtube imagemap`. Leftmost opener pairs
 *    with the NEAREST following same-name closer; scanning then resumes right
 *    after that closer, so anything between them — including another opener
 *    of the SAME name — is swallowed as plain content and can never itself
 *    become a tag. A different tag name inside is untouched: it gets its own,
 *    fully independent pass. No closer anywhere → the opener alone goes
 *    literal (the specific occurrence, not the tag family — a LATER opener of
 *    the same name gets its own fair try). Two axes vary per tag: whether `.`
 *    crosses a newline (`b/i/u/s/strike/spoiler/notice/centre/left/right/
 *    color/size/imagemap` do; `heading/audio/profile/email/url/youtube` do
 *    not — a pairing that would have to cross a `\n` fails outright, even if
 *    a same-line closer would have worked), and whether empty content is
 *    allowed (all do except `profile/email/url/youtube/imagemap`, which
 *    require at least one character). `color`/`size` additionally require
 *    their `=value` to look right (`#rrggbb` or letters only; digits only) —
 *    a bad value never seals, exactly like a missing closer.
 * 2. **rawBlock** — `code c`. Quasar's OWN lexer already treats both as raw
 *    blocks (`BBCODE_RAW_TAGS`): content between a raw opener and the next
 *    literal `[/tag]` is never tokenised as nested tags at all, which already
 *    reproduces osu!'s content-protecting escape for free. This module only
 *    has to decide the pair itself: unclosed → the opener goes literal;
 *    `c` additionally requires the content to have no newline (`code` is
 *    dotall, `c` is not).
 * 3. **alwaysSeal** — `box spoilerbox`. Every syntactically valid occurrence
 *    seals UNCONDITIONALLY — no closer needed, no nesting check, not even a
 *    look at what (if anything) it pairs with. `[box=title]` requires a
 *    non-empty `=value`; bare `[box]` is not osu! syntax at all and never
 *    seals. `[spoilerbox]` is the opposite: bare only, any `=value` on it
 *    never seals. Every `[/box]` and `[/spoilerbox]` always seals. Nesting
 *    that then reads correctly in HTML is an accident of well-formed
 *    markup, not a pairing rule — Quasar's own structural parser (which
 *    already nests these) is left completely alone for this family.
 * 4. **countLimited** — `quote list`. Independent of nesting: count every
 *    syntactically valid opener and every closer across the WHOLE document,
 *    take `limit = min(openCount, closeCount)`, and seal the first `limit`
 *    of EACH — in document order, regardless of which would "belong" to
 *    which. A `[quote]` opener is valid bare or with a double-quoted value
 *    (`[quote="Author"]`); an unquoted `[quote=Author]` never matches osu!'s
 *    regex and is never even counted. `[*]`/`[/*]` (list items) are a
 *    separate, unconditional str_replace in real osu! — always sealed,
 *    regardless of being inside a sealed `[list]` at all — so this module
 *    never touches `*` tokens.
 * 5. **img** — its own shape: `(?<url>[^[]+)` is a GREEDY run of
 *    non-`[` characters, so the very next `[`-starting token after an
 *    `[img]` opener must literally be its `[/img]`, or the whole occurrence
 *    fails (no backtracking finds a later `[/img]` — a `[` of any kind, tag
 *    or not, blocks it). Content may include newlines (`[^[]` allows them)
 *    but must be non-empty.
 *
 * ─── Content protection (pass order) ─────────────────────────────────────
 *
 * `imagemap` and `code` are the only two passes that ESCAPE what they seal
 * (`extraEscapes` in osu!'s own source), and both run before every other
 * pass, so nothing inside a SEALED `imagemap` or `code` can ever become a
 * tag under any other family either — not just its own. `code`'s protection
 * is free (Quasar's lexer already isolates it, see `rawBlock` above).
 * `imagemap` is not a Quasar raw block, so this module reproduces it
 * explicitly: once an `imagemap` pair seals, every `open`/`close` token
 * strictly between them — any tag name — is forced literal too, before any
 * other family gets to look at them. An UNSEALED `imagemap` (no closer, or
 * empty) protects nothing, exactly like `code`.
 *
 * ─── Case sensitivity and Quasar-only aliases ─────────────────────────────
 *
 * None of osu!'s regexes carry the `/i` flag: `[B]x[/B]` is never sealed —
 * checked against the harness, not assumed. Every occurrence here is
 * gated on exact-lowercase source text (the lexer itself lowercases
 * `token.tag`, so this module re-slices `source` at the token's own
 * position to see what was actually typed). Two of Quasar's tag spellings
 * are convenience aliases with NO osu! counterpart at all — `center`
 * (osu! only recognises the British `centre`) and `colour` (osu! only
 * recognises `color`) — and are therefore never sealed under `pairing:
 * 'osu'`, unconditionally, the same as a case mismatch.
 *
 * ─── What is deliberately out of scope ────────────────────────────────────
 *
 * `email`/`url`/`youtube` bare-form values are treated as any non-empty,
 * single-line content (allowEmpty:false, dotall:false) WITHOUT osu!'s exact
 * URL/e-mail value regex — a bare `[url]not a url[/url]` seals here but
 * would not in real osu!. This trades a rare edge case for not shipping a
 * third, hand-rolled URL/e-mail matcher next to the two the app already has.
 * Tags Quasar knows that osu! has no concept of at all (miliastry-only:
 * `font`, `gradient`, `tables`, `align`, `wnotice`, `boxw`, …) are not in the
 * table below and are never touched by this module — they keep pairing by
 * Quasar's own normal structural rules, exactly as the miliastry dialect
 * always has.
 *
 * ─── Two fixed lexer-level gaps ──────────────────────────────────────────
 *
 * Both were disclosed divergences until they were measured against osu-web's
 * real pipeline (BBCodeForDB → BBCodeFromDB → HTMLPurifier) and fixed to
 * match. Neither is a change to THIS module — both live where the actual
 * divergence was: the lexer for the first, `parseTokensToGreen` for the
 * second. `pairing: 'osu'` is what turns either one on; the default
 * `'quasar'` pairing is byte-identical to before.
 *
 * 1. **Unclosed `code`/`c` no longer swallows the rest of the document.**
 *    Real osu! leaves an unclosed `[code]`/`[c]` unprotected, so a tag typed
 *    after it seals normally (`[code]x\n[b]y[/b]` → `[code]x<br /><strong>y
 *    </strong>`, measured). Quasar's LEXER used to treat `code`/`c` as raw
 *    blocks UNCONDITIONALLY (`BBCODE_RAW_TAGS` in `Lexer/BBCodeLexer.ts`): an
 *    unclosed one swallowed the REST OF THE DOCUMENT into one opaque text
 *    token before this module (or `parseTokensToGreen`) ever saw it, so
 *    nothing after it could ever tokenise as a tag at all — under EITHER
 *    pairing mode. `scanBBCode` now takes a `pairing` option: under `'osu'`
 *    it only isolates the raw block (protecting its content from normal
 *    tokenising) when a closer actually exists AND — for `c`, which is
 *    non-dotall in osu! — reaching it does not cross a newline; otherwise
 *    the opener is left as an ordinary `open` token and lexing continues
 *    normally, and `sealRawBlock` below demotes that unsealed opener to
 *    literal text exactly as it always has, the same way every other
 *    lazy-family tag gets demoted. The default `'quasar'` pairing does not
 *    pass this option and keeps swallowing the rest of the document, exactly
 *    as before.
 * 2. **An orphan `[/box]`/`[/spoilerbox]` now renders nothing and swallows
 *    newlines like a matched one.** osu!'s `strtr` pass seals EVERY
 *    `[/box]`/`[/spoilerbox]`, orphan or not (see the `alwaysSeal` family
 *    above — this module already never demotes their tokens), and its
 *    renderer's `\n*[/box]\n?` regex eats the newlines around it before
 *    HTMLPurifier silently drops the resulting unmatched closing div
 *    (measured: `"hola\n\n[/box]\n\nmundo"` → `hola<br />mundo`). This is
 *    NOT something a token-level filter can express — there is no `open`
 *    token to pair it with. `parseTokensToGreen`'s orphan-close branch
 *    (Parser.ts) now special-cases `pairing: 'osu'` box/spoilerbox orphans:
 *    instead of the literal `text` leaf every other orphan closer gets, it
 *    emits a `discarded_box_close` leaf (`Types/core.ts`), which
 *    `HTMLRenderer`/`BBCodeExporter` render as invisible — like
 *    `discarded_tag` — and which carries the same newline budget as a
 *    MATCHED box/spoilerbox close (`HTMLRenderer.NEWLINE_RULES`).
 *
 * ─── `sealLazy` forces a never-matched closer to text too ─────────────────
 *
 * `preg_replace` only ever transforms a matched `\[tag\](.*?)\[/tag\]` SPAN;
 * a `[/tag]` that never ended up inside one — no unconsumed opener was ever
 * searching for it — is untouched text in real osu!, exactly like a bad-case
 * closer already was. `sealLazy` now tracks which close INDEX each opener's
 * nearest-match search actually consumed and forces every OTHER close token
 * of that tag in its final sweep, not just the case-mismatched ones (it used
 * to leave those live, relying on whatever consumed them downstream to
 * decide — fine under the old, name-matching tree-closing rule, but WRONG
 * once div-count closing (below) stopped checking names at all: measured
 * with `docs/ai/NyuPenyu.from-intent.bbcode`, an extra, unconsumed
 * `[/notice]` used to close a `centre` div it should never have touched).
 *
 * ─── Div-count CLOSING is a separate module ────────────────────────────────
 *
 * This module answers "does this open/close pair become a real tag at all"
 * — never how the resulting tags NEST. osu! does not nest by name either:
 * `box`/`spoilerbox` push TWO anonymous `<div>`s (wrapper, then body),
 * `notice`/`centre`/`left`/`right` push one, and HTMLPurifier closes each
 * `</div>` against the innermost one still open, by POSITION, regardless of
 * which BBCode tag produced it. That is `Parser.ts`'s `closeDivUnits`
 * (`pairing: 'osu'` only) — see its own doc comment and
 * `Tests/OsuDivClosing.test.ts` for the measured cases (a half-closed box's
 * `box_tail`, two 1-unit tags crossing, an excess closer finding only part
 * of what it needs). Kept separate from this module on purpose: sealing
 * (this file) runs on the TOKEN stream before the tree exists; closing nests
 * whatever tokens survive it, at tree-build time.
 */

import type { BBCodeToken } from '../Lexer/BBCodeLexer'

// ─── Per-tag sealing strategy ────────────────────────────────────────────

interface LazyFamily {
  kind: 'lazy'
  /** Does `.` in osu!'s regex cross a newline? */
  dotall: boolean
  /** Is empty content (`.{0}`) a valid match? */
  allowEmpty: boolean
  /** Tested against the `=value` text (without the leading `=`), if present. */
  valuePattern?: RegExp
}

interface RawBlockFamily {
  kind: 'rawBlock'
  dotall: boolean
}

interface AlwaysSealFamily {
  kind: 'alwaysSeal'
  /** Whether a valid OPENER requires, or forbids, an `=value`. */
  value: 'required' | 'forbidden'
}

interface CountLimitedFamily {
  kind: 'countLimited'
  /** Is this specific opener's `attrs` (e.g. `=Author`, `=&quot;Author&quot;` in
   *  source terms `="Author"`, or `''` for bare) one osu! would count at all? */
  openerValid: (attrs: string) => boolean
}

interface ImgFamily {
  kind: 'img'
}

interface NeverSealFamily {
  kind: 'neverSeal'
}

type Family = LazyFamily | RawBlockFamily | AlwaysSealFamily | CountLimitedFamily | ImgFamily | NeverSealFamily

const LAZY_MULTILINE: LazyFamily = { kind: 'lazy', dotall: true, allowEmpty: true }
const LAZY_SINGLELINE: LazyFamily = { kind: 'lazy', dotall: false, allowEmpty: true }
const LAZY_SINGLELINE_NONEMPTY: LazyFamily = { kind: 'lazy', dotall: false, allowEmpty: false }
const NEVER_SEAL: NeverSealFamily = { kind: 'neverSeal' }

/** `#rrggbb` or letters-only — osu!'s `parseColour`. */
const OSU_COLOR_VALUE_RE = /^(?:#[0-9a-fA-F]{6}|[a-zA-Z]+)$/
/** Digits only — osu!'s `parseSize`. */
const OSU_SIZE_VALUE_RE = /^\d+$/

function quoteOpenerValid(attrs: string): boolean {
  // Bare `[quote]`, or `[quote="…"]` with LITERAL double quotes around a
  // non-empty value. osu! matches this against text already run through
  // `htmlentities()`, so only a real `"` in the BBCode source produces the
  // `&quot;…&quot;` its regex requires — an unquoted `[quote=Author]` never
  // matches at all and is not even counted.
  if (attrs === '') return true
  return attrs.length >= 4 && attrs.startsWith('="') && attrs.endsWith('"')
}

function listOpenerValid(attrs: string): boolean {
  // Bare `[list]`, or `[list=anything]` (osu!'s `list` pattern is
  // `=.+?` — lazy but unconstrained, unlike quote's literal-quote requirement).
  if (attrs === '') return true
  return attrs.length > 1 && attrs.startsWith('=')
}

/** Exact osu! tag names this module knows about, keyed EXACTLY as osu!'s own
 *  regexes spell them — never a Quasar-only alias (see module doc). */
const OSU_FAMILY: Readonly<Record<string, Family>> = {
  b: LAZY_MULTILINE,
  i: LAZY_MULTILINE,
  strike: LAZY_MULTILINE,
  s: LAZY_MULTILINE,
  u: LAZY_MULTILINE,
  spoiler: LAZY_MULTILINE,
  notice: LAZY_MULTILINE,
  centre: LAZY_MULTILINE,
  left: LAZY_MULTILINE,
  right: LAZY_MULTILINE,
  color: { kind: 'lazy', dotall: true, allowEmpty: true, valuePattern: OSU_COLOR_VALUE_RE },
  size: { kind: 'lazy', dotall: true, allowEmpty: true, valuePattern: OSU_SIZE_VALUE_RE },
  heading: LAZY_SINGLELINE,
  audio: LAZY_SINGLELINE,
  profile: LAZY_SINGLELINE_NONEMPTY,
  email: LAZY_SINGLELINE_NONEMPTY,
  url: LAZY_SINGLELINE_NONEMPTY,
  youtube: LAZY_SINGLELINE_NONEMPTY,
  imagemap: { kind: 'lazy', dotall: true, allowEmpty: false },
  c: { kind: 'rawBlock', dotall: false },
  code: { kind: 'rawBlock', dotall: true },
  img: { kind: 'img' },
  box: { kind: 'alwaysSeal', value: 'required' },
  spoilerbox: { kind: 'alwaysSeal', value: 'forbidden' },
  quote: { kind: 'countLimited', openerValid: quoteOpenerValid },
  list: { kind: 'countLimited', openerValid: listOpenerValid },
  // Quasar-only spellings osu! never recognises at all (see module doc).
  center: NEVER_SEAL,
  colour: NEVER_SEAL,
}

// ─── Filter ───────────────────────────────────────────────────────────────

/**
 * Returns a NEW token array where every `open`/`close` token osu! would not
 * seal has been demoted to an equivalent `text` token (same `start`/`end`,
 * `value` = the exact source slice). Tokens for tags with no entry in
 * {@link OSU_FAMILY} (miliastry-only tags, `*`, `empty_line`) are returned
 * completely untouched, so they keep pairing by Quasar's normal structural
 * rules. `text`/`newline` tokens are always untouched.
 */
export function applyOsuPairing(tokens: readonly BBCodeToken[], source: string): BBCodeToken[] {
  const n = tokens.length
  const forced = new Array<boolean>(n).fill(false)
  const caseOk = new Array<boolean>(n).fill(false)

  for (let i = 0; i < n; i++) {
    const t = tokens[i]
    if (t.kind === 'open') {
      caseOk[i] = source.slice(t.start + 1, t.start + 1 + t.tag.length) === t.tag
    } else if (t.kind === 'close') {
      caseOk[i] = source.slice(t.start + 2, t.start + 2 + t.tag.length) === t.tag
    }
  }

  // `center`/`colour`: unconditionally literal, both open and close.
  for (let i = 0; i < n; i++) {
    const t = tokens[i]
    if ((t.kind === 'open' || t.kind === 'close') && OSU_FAMILY[t.tag]?.kind === 'neverSeal') {
      forced[i] = true
    }
  }

  // `imagemap` MUST run first: it protects its own interior from every other
  // family, exactly mirroring osu!'s pass order (imagemap, then code, then
  // everything else — code's protection is already free, see module doc).
  sealImagemapProtecting(tokens, source, caseOk, forced)

  for (const tag of Object.keys(OSU_FAMILY)) {
    const family = OSU_FAMILY[tag]
    switch (family.kind) {
      case 'lazy':
        if (tag === 'imagemap') continue // already handled above
        sealLazy(tag, family, tokens, source, caseOk, forced)
        break
      case 'rawBlock':
        sealRawBlock(tag, family.dotall, tokens, source, caseOk, forced)
        break
      case 'alwaysSeal':
        sealAlwaysSeal(tag, family.value, caseOk, forced, tokens)
        break
      case 'countLimited':
        sealCountLimited(tag, family.openerValid, tokens, caseOk, forced)
        break
      case 'img':
        sealImg(tokens, caseOk, forced)
        break
      case 'neverSeal':
        break // handled above, unconditionally
    }
  }

  return materialize(tokens, source, forced)
}

function materialize(tokens: readonly BBCodeToken[], source: string, forced: boolean[]): BBCodeToken[] {
  const out: BBCodeToken[] = new Array(tokens.length)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    out[i] = forced[i]
      ? { kind: 'text', value: source.slice(t.start, t.end), start: t.start, end: t.end }
      : t
  }
  return out
}

// ─── imagemap: seal + protect interior ────────────────────────────────────

function sealImagemapProtecting(
  tokens: readonly BBCodeToken[],
  source: string,
  caseOk: boolean[],
  forced: boolean[],
): void {
  let cursor = 0
  while (cursor < tokens.length) {
    let openIdx = -1
    for (let i = cursor; i < tokens.length; i++) {
      const t = tokens[i]
      if (forced[i] || t.kind !== 'open' || t.tag !== 'imagemap') continue
      if (!caseOk[i]) { forced[i] = true; continue }
      openIdx = i
      break
    }
    if (openIdx === -1) break

    let closeIdx = -1
    for (let j = openIdx + 1; j < tokens.length; j++) {
      const t = tokens[j]
      if (t.kind === 'close' && t.tag === 'imagemap' && caseOk[j]) { closeIdx = j; break }
    }
    if (closeIdx === -1) { forced[openIdx] = true; cursor = openIdx + 1; continue }

    const open = tokens[openIdx]
    const close = tokens[closeIdx]
    if (close.start === open.end) { forced[openIdx] = true; cursor = openIdx + 1; continue }

    for (let k = openIdx + 1; k < closeIdx; k++) {
      if (tokens[k].kind === 'open' || tokens[k].kind === 'close') forced[k] = true
    }
    cursor = closeIdx + 1
  }
}

// ─── lazy family ────────────────────────────────────────────────────────

function sealLazy(
  tag: string,
  family: LazyFamily,
  tokens: readonly BBCodeToken[],
  source: string,
  caseOk: boolean[],
  forced: boolean[],
): void {
  // Indices of close tokens actually consumed as the nearest match of some
  // opener below — i.e. genuinely part of a `\[tag\](.*?)\[/tag\]` MATCH,
  // not just left un-visited by the opener-driven scan. `preg_replace` only
  // ever transforms a matched SPAN; a `[/tag]` that is not part of one is
  // never touched by this tag's pass at all and stays literal — see the
  // sweep below.
  const consumedClose = new Set<number>()

  let cursor = 0
  while (cursor < tokens.length) {
    let openIdx = -1
    for (let i = cursor; i < tokens.length; i++) {
      const t = tokens[i]
      if (forced[i] || t.kind !== 'open' || t.tag !== tag) continue
      if (!caseOk[i]) { forced[i] = true; continue }
      if (family.valuePattern) {
        const raw = t.kind === 'open' ? t.attrs : ''
        const value = raw.startsWith('=') ? raw.slice(1) : raw
        if (!family.valuePattern.test(value)) { forced[i] = true; continue }
      }
      openIdx = i
      break
    }
    if (openIdx === -1) break

    let closeIdx = -1
    let crossedNewline = false
    for (let j = openIdx + 1; j < tokens.length; j++) {
      const t = tokens[j]
      if (forced[j]) continue
      if (!family.dotall && t.kind === 'newline') crossedNewline = true
      if (t.kind === 'close' && t.tag === tag) {
        if (!caseOk[j]) continue
        if (!family.dotall && crossedNewline) break
        closeIdx = j
        break
      }
    }

    if (closeIdx === -1) { forced[openIdx] = true; cursor = openIdx + 1; continue }

    const open = tokens[openIdx]
    const close = tokens[closeIdx]
    if (!family.allowEmpty && close.start === open.end) {
      forced[openIdx] = true
      cursor = openIdx + 1
      continue
    }

    // Swallowed as content: a same-tag OPENER strictly inside can never
    // itself become a tag (osu! non-nesting). A same-tag CLOSER inside is
    // already an orphan this module now forces to text on its own — see the
    // sweep below and module doc's `lazy` section.
    for (let k = openIdx + 1; k < closeIdx; k++) {
      const t = tokens[k]
      if (t.kind === 'open' && t.tag === tag) forced[k] = true
    }
    consumedClose.add(closeIdx)
    cursor = closeIdx + 1
  }

  // Sweep: any remaining un-decided close token of this tag — wrong case, OR
  // (`pairing: 'osu'`'s div-count crossing, `Parser.ts`'s `closeDivUnits`)
  // never consumed as the nearest match of an opener above. `preg_replace`
  // only ever transforms a matched `\[tag\](.*?)\[/tag\]` SPAN; a `[/tag]`
  // outside every such span is literal text in real osu!, full stop —
  // regardless of whatever ELSE happens to be open at that point in the
  // document (measured: `docs/ai/NyuPenyu.from-intent.bbcode` has an extra,
  // unconsumed `[/notice]` sitting where a `[centre]` is still open; osu!
  // leaves it as literal text and `[centre]` stays open across it, it does
  // NOT close `centre`'s div). Forcing this here — rather than relying on
  // whatever the tree builder does with a live, unmatched `close` token —
  // keeps that decision where the actual sealing contract lives, so every
  // consumer (div-count crossing, the plain literal-text fallback, …) sees
  // the same, correct set of real tokens.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!forced[i] && t.kind === 'close' && t.tag === tag && (!caseOk[i] || !consumedClose.has(i))) {
      forced[i] = true
    }
  }
}

// ─── rawBlock family (code, c) ────────────────────────────────────────────

function sealRawBlock(
  tag: string,
  dotall: boolean,
  tokens: readonly BBCodeToken[],
  source: string,
  caseOk: boolean[],
  forced: boolean[],
): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (forced[i] || t.kind !== 'open' || t.tag !== tag) continue
    if (!caseOk[i]) { forced[i] = true; continue }

    // The lexer's raw-block handling always emits: open, [text?], close —
    // contiguous — or just `open` (unclosed, content consumed the rest of
    // the document, no close token exists at all).
    let j = i + 1
    if (j < tokens.length && tokens[j].kind === 'text' && tokens[j].start === t.end) j++
    const closeTok = j < tokens.length ? tokens[j] : null
    const isContiguousClose =
      closeTok !== null && closeTok.kind === 'close' && closeTok.tag === tag &&
      closeTok.start === (j > i + 1 ? tokens[j - 1].end : t.end)

    if (!isContiguousClose) { forced[i] = true; continue }
    const closeIdx = j
    if (!caseOk[closeIdx]) { forced[i] = true; forced[closeIdx] = true; continue }

    if (!dotall) {
      const content = source.slice(t.end, tokens[closeIdx].start)
      if (content.includes('\n')) { forced[i] = true; forced[closeIdx] = true; continue }
    }
    // else: seal, leave both tokens untouched.
  }
}

// ─── alwaysSeal family (box, spoilerbox) ──────────────────────────────────

function sealAlwaysSeal(
  tag: string,
  value: 'required' | 'forbidden',
  caseOk: boolean[],
  forced: boolean[],
  tokens: readonly BBCodeToken[],
): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind !== 'open' && t.kind !== 'close') continue
    if (t.tag !== tag) continue
    if (!caseOk[i]) { forced[i] = true; continue }
    if (t.kind === 'open') {
      const hasValue = t.attrs.length > 1 && t.attrs.startsWith('=')
      if (value === 'required' && !hasValue) forced[i] = true
      if (value === 'forbidden' && t.attrs !== '') forced[i] = true
    }
    // close tokens: always seal once case matches — osu!'s `strtr` marks
    // every `[/box]`/`[/spoilerbox]` unconditionally.
  }
}

// ─── countLimited family (quote, list) ────────────────────────────────────

function sealCountLimited(
  tag: string,
  openerValid: (attrs: string) => boolean,
  tokens: readonly BBCodeToken[],
  caseOk: boolean[],
  forced: boolean[],
): void {
  const openers: number[] = []
  const closers: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (forced[i]) continue
    if (t.kind === 'open' && t.tag === tag) {
      if (caseOk[i] && openerValid(t.attrs)) openers.push(i)
      else forced[i] = true
    } else if (t.kind === 'close' && t.tag === tag) {
      if (caseOk[i]) closers.push(i)
      else forced[i] = true
    }
  }
  const limit = Math.min(openers.length, closers.length)
  for (let k = limit; k < openers.length; k++) forced[openers[k]] = true
  for (let k = limit; k < closers.length; k++) forced[closers[k]] = true
}

// ─── img ────────────────────────────────────────────────────────────────

function sealImg(tokens: readonly BBCodeToken[], caseOk: boolean[], forced: boolean[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (forced[i] || t.kind !== 'open' || t.tag !== 'img') continue
    if (!caseOk[i]) { forced[i] = true; continue }

    let j = i + 1
    while (j < tokens.length && tokens[j].kind !== 'open' && tokens[j].kind !== 'close') j++
    const next = j < tokens.length ? tokens[j] : null
    const isImgClose = next !== null && next.kind === 'close' && next.tag === 'img'
    const nonEmpty = next !== null && next.start > t.end

    if (isImgClose && caseOk[j] && nonEmpty) continue // seal
    forced[i] = true
  }
}
