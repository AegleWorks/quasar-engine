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
 *    c/color/size/imagemap` do; `heading/audio/profile/email/url/youtube` do
 *    not — a pairing that would have to cross a `\n` fails outright, even if
 *    a same-line closer would have worked), and whether empty content is
 *    allowed (all do except `profile/email/url/youtube/imagemap`, which
 *    require at least one character). `color`/`size`/`profile` additionally
 *    require their `=value` to look right (`#rrggbb` or letters only; digits
 *    only; digits only) — a bad value never seals, exactly like a missing
 *    closer. `c` is a lazy tag like the rest (see below): osu!'s own pass
 *    only wraps its body, it does not escape it.
 * 2. **rawBlock** — `code` alone. Quasar's OWN lexer already treats a
 *    `[code]` body as a raw block (`BBCODE_RAW_TAGS`): content between the
 *    opener and the next literal `[/code]` is never tokenised as nested tags
 *    at all, which reproduces osu!'s content-protecting escape for free.
 *    This module only has to decide the pair itself: unclosed → the opener
 *    goes literal. (`c` USED to live here too, because the lexer treated it
 *    as raw; it does not any more — see the next section.)
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
 * `c` protects NOTHING. `parseInlineSimple` runs near the END of osu!'s pass
 * order (after every block pass, after `parseMultilineSimple`) and, unlike
 * `parseCode`, escapes nothing: it just rewrites `[c]`/`[/c]` into markers,
 * so whatever tag is typed inside a sealed `[c]` stays a tag for the passes
 * around it — the blocks that already ran, and the ones still to come. That
 * is why `[c]` must reach this module with its body TOKENISED (the lexer no
 * longer isolates it under `pairing: 'osu'`) and why its family is `lazy`:
 * only the PAIR is this module's business, exactly like `[b]`'s.
 *
 * ─── La forma del tag: atributo inesperado = texto ───────────────────────
 *
 * Cada regex de osu! escribe su tag tal cual (`#\[b](.*?)\[/b\]#`,
 * `#\[centre](.*?)\[/centre\]#`, `#\[code]…`), así que un atributo que ese
 * pase no contempla hace que NO coincida: `[b=x]a[/b]`, `[heading=2]a[/heading]`,
 * `[centre=x]`, `[c ]`, `[code=x]`, `[youtube=x]`, `[img round]` se publican
 * escritos, etiquetas incluidas (medido, `.cache/c-code-attrs`, 12 de 15
 * casos; los tres que no son `[url = x]`, `[email=]` y `[size =50]`, que
 * tienen su propia regla). De ahí las comprobaciones `unexpected-value`:
 * la familia `lazy` exige la forma desnuda cuando no tiene `valuePattern`,
 * y lo mismo `rawBlock` (`code`), `img`, y el camino de los rótulos
 * (`sealLazyWithTitle`). Las familias que SÍ llevan valor — `color`, `size`,
 * `profile`, `url`, `email`, `box`, `quote`, `list` — ya tenían su propio
 * patrón, y `profile` lo ganó aquí (`=digits`).
 *
 * The same escaping also COLLAPSES the body to one line: `extraEscapes` turns
 * every `\n` into `&#10;`, so a later single-line pass sees the whole sealed
 * map as line-local. A `[heading]` wrapping a multi-line imagemap therefore
 * seals — measured: `[heading][imagemap]\n…\n[/imagemap][/heading]` publishes
 * `<h2></h2>` followed by the map, because HTMLPurifier lifts the `<div>` out
 * of the `<h2>` after `BBCodeFromDB` produced them nested. No other escaping
 * pass can change line-ness: `code` keeps its `prespaces`/`postspaces`
 * newlines outside the escaped group, and the remaining families are
 * non-dotall, so their bodies never held one.
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
 * ─── The url/email closure: the value is part of the sealing rule ─────────
 *
 * `parseUrl`/`parseEmail` only ever rewrite a tag whose value (or, in the
 * bare form, whose BODY) matches their own URL/e-mail regex. Everything else
 * — `[url]not a url[/url]`, `[url=pepe]T[/url]`, `[url=]T[/url]`,
 * `[url=mailto:a@b.com]T[/url]` — is left untouched by the storage pass, so
 * it never gains the `:uid` suffix, and the render pass never converts it:
 * the tag is published AS WRITTEN. That is why these two families carry
 * `valuePattern` + `bareContentPattern` (see those fields) instead of the
 * plain `LAZY_SINGLELINE_NONEMPTY` the older code used: a value that osu!
 * would not convert cannot seal here either.
 *
 * Measured, case by case, in `.cache/url-close` (50 cases through the real
 * harness); the two that drove each rule are C31 (`[url=www.x]` written) and
 * C39 (`[url=X][/url]T[/url]` linking with the first closer inside the text).
 *
 * `youtube` is different and stays `LAZY_SINGLELINE_NONEMPTY`: its own
 * pattern has an EMPTY alternative, so any single-line content converts.
 * Tags Quasar knows that osu! has no concept of at all (miliastry-only:
 * `font`, `gradient`, `tables`, `align`, `wnotice`, `boxw`, …) are not in the
 * table below and are never touched by this module — they keep pairing by
 * Quasar's own normal structural rules, exactly as the miliastry dialect
 * always has.
 *
 * ─── Fixed lexer-level gaps ──────────────────────────────────────────────
 *
 * Each was a disclosed divergence until it was measured against osu-web's
 * real pipeline (BBCodeForDB → BBCodeFromDB → HTMLPurifier) and fixed to
 * match. None is a change to THIS module's sealing passes — they live where
 * the actual divergence was: the lexer for the first and the third,
 * `parseTokensToGreen` for the second. `pairing: 'osu'` is what turns them
 * on; the default `'quasar'` pairing is byte-identical to before.
 *
 * The `c` move (from `rawBlock` to `lazy`) belongs to this list too: the
 * lexer and the family table had to change together, because the sealing rule
 * and the tokenisation are two halves of the same decision.
 *
 * 3. **`[url=`/`[email=` end their attribute at the FIRST `]`.** osu!'s
 *    value regex is a lazy `.+?\]`, so brackets inside the value do not
 *    balance: `[url=https://x[/url]T[/url]` publishes the href
 *    `https://x[/url]` with the text `T`, and `[url=https://x[i:1]T[/url]`
 *    publishes the href `https://x[i:1` (`.cache/url-close`, C03/C18/C30).
 *    The lexer's balanced scan rejected both and left them written. Only the
 *    exact `[url=`/`[email=` spelling: `[url = x]` is not a tag for osu! at
 *    all, so its brackets keep balancing and the run stays plain text.
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
 *    it only isolates a raw block (protecting its content from normal
 *    tokenising) when osu!'s own pass would seal that occurrence; otherwise
 *    the opener is left as an ordinary `open` token and lexing continues
 *    normally, and the sealing family demotes it to literal text exactly as
 *    it always has. The default `'quasar'` pairing does not pass this option
 *    and keeps swallowing the rest of the document, exactly as before. Two
 *    occurrences matter here: an unclosed `[code]` (no closer anywhere) and,
 *    for `c`, any opener that is not part of a sealed pair at all — `c` is
 *    not a raw block under `'osu'` in the first place (see the `rawBlock`
 *    and `c` sections above), so its body always tokenises normally.
 *    `[code]` adds one more: its body is `.+?`, so a body-less
 *    `[code][/code]` does not seal either — the lexer skips that adjacent
 *    closer and isolates up to the first one that leaves a character of
 *    body, or leaves the opener alone when there is none (`.cache/c-code2`,
 *    e01–e07).
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
  /**
   * Tested against the raw source between the opener and its closer, for the
   * BARE form (`[url]https://…[/url]`). osu! runs the SAME value regex on that
   * content, so a bare `[url]not a url[/url]` never becomes a link — measured
   * (`.cache/url-close`, C10/C21/C36/C45). Its presence also marks the tag as
   * one whose bare spelling must be literally `[tag]`: `[url = x]` is not
   * `\[url\]` for osu! and stays written (C38).
   */
  bareContentPattern?: RegExp
}

interface RawBlockFamily {
  kind: 'rawBlock'
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
/**
 * El `.+?` de `parseUrl`, en las DOS formas del tag: el `=atributo` y el
 * cuerpo de un `[url]…[/url]` desnudo. Exige el esquema (`http`, `https` o
 * `ftp`, en minúsculas: osu! no lleva `/i`) y al menos un carácter detrás; sin
 * `/s`, un salto lo corta. Todo lo demás (`[url=pepe]`, `[url=]`,
 * `[url=//x]`, `[url=mailto:…]`) queda ESCRITO en la página.
 */
const OSU_URL_VALUE_RE = /^(?:https?|ftp):\/\/[^\n]+$/
/** `parseEmail`'s `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z-]+`, literal. */
const OSU_EMAIL_VALUE_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z-]+$/
/**
 * `[profile=123]`: only the numeric id is a valid value — osu!'s
 * `parseProfile` spells it `(?:=(?<id>[0-9]+))?`, so `[profile=x]peppy` never
 * matches the pass and stays written (measured: `.cache/c-code-attrs`).
 */
const OSU_PROFILE_VALUE_RE = /^\d+$/
/**
 * Y su forma DESNUDA (`[profile]peppy[/profile]`) sí es válida: el grupo del
 * id es opcional y el del nombre es `.+?` — cualquier contenido, pero no
 * vacío (eso lo cubre `allowEmpty: false`). Lo que la presencia de este
 * patrón añade es la ortografía: `[profile = x]` no es el `[profile]` de osu!
 * y queda escrito, igual que en `url`/`email`.
 */
const OSU_PROFILE_BARE_RE = /^[\s\S]*$/

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
  profile: { kind: 'lazy', dotall: false, allowEmpty: false, valuePattern: OSU_PROFILE_VALUE_RE, bareContentPattern: OSU_PROFILE_BARE_RE },
  email: { kind: 'lazy', dotall: false, allowEmpty: false, valuePattern: OSU_EMAIL_VALUE_RE, bareContentPattern: OSU_EMAIL_VALUE_RE },
  url: { kind: 'lazy', dotall: false, allowEmpty: false, valuePattern: OSU_URL_VALUE_RE, bareContentPattern: OSU_URL_VALUE_RE },
  youtube: LAZY_SINGLELINE_NONEMPTY,
  imagemap: { kind: 'lazy', dotall: true, allowEmpty: false },
  // `c` is NOT a raw block in this mode: osu!'s pass only WRAPS its body in
  // the `:uid` markers — it escapes nothing — so a tag typed inside a sealed
  // `[c]` keeps being a tag for every other pass. Its own rule is exactly
  // `#\[c](.*?)\[/c\]#`: lazy, non-dotall, empty allowed, and spelled bare
  // (any `=value` on it never seals). See the module doc's `rawBlock` entry.
  c: LAZY_SINGLELINE,
  code: { kind: 'rawBlock' },
  img: { kind: 'img' },
  box: { kind: 'alwaysSeal', value: 'required' },
  spoilerbox: { kind: 'alwaysSeal', value: 'forbidden' },
  quote: { kind: 'countLimited', openerValid: quoteOpenerValid },
  list: { kind: 'countLimited', openerValid: listOpenerValid },
  // Quasar-only spellings osu! never recognises at all (see module doc).
  center: NEVER_SEAL,
  colour: NEVER_SEAL,
}

// ─── Trace (opt-in) ───────────────────────────────────────────────────────

/**
 * Qué pasó con un token en el sellado: se quedó como etiqueta real (`seal`),
 * se degradó a texto literal (`literal`), o no lo toca ninguna pasada de osu!
 * (`untouched` — un `*`, un tag sólo de miliastry).
 */
export type OsuPairingAction = 'seal' | 'literal' | 'untouched'

/**
 * Una decisión REAL de {@link applyOsuPairing}, no una reconstrucción.
 *
 * Se emite una por cada token `open`/`close`, en orden de token —no en orden
 * de pasada—, así que dos ejecuciones sobre la misma fuente dan exactamente
 * los mismos pasos. `detail` lleva lo que esa pasada miró para decidir (el
 * cierre emparejado, los conteos del presupuesto, el valor del atributo…).
 *
 * Lo que este módulo NO sabe —el bloque o el `<li>` en el que caerá el token—
 * no aparece aquí: esa pertenencia la decide `Parser.ts` al construir el
 * árbol, y ahí es donde hay que instrumentarla (ver `Tests/OsuPairingTrace`).
 */
export interface OsuPairingStep {
  /** Índice en el array de tokens que se pasó. */
  token: number
  start: number
  end: number
  kind: 'open' | 'close'
  tag: string
  /** La pasada que tomó la decisión: `lazy:b`, `imagemap`, `countLimited:list`… */
  pass: string
  action: OsuPairingAction
  reason: string
  detail?: Readonly<Record<string, unknown>>
}

export interface OsuPairingOptions {
  /**
   * Se llama una vez por token `open`/`close`, al final del sellado y en orden
   * de token. Sin esto no se reserva ningún registro de traza: el escaneo
   * completo de 8.761 páginas sigue pagando lo mismo.
   */
  onDecision?: (step: OsuPairingStep) => void
  /**
   * Colector opcional de las listas selladas que `parseList` de osu! dejó
   * cruzando un cierre de caja: la regla de título `[list:uid](.+?)(<li>|</ol>)`
   * captura el HTML del bloque ya cerrado y el `<ol>` nuevo nace en el primer
   * ítem de la lista siguiente. El árbol no puede mover esa captura, pero sí
   * sintetizar el cuerpo de la cabeza dentro del primer ítem de la portadora.
   * Clave: `start` del token `open` de la lista PORTADORA.
   */
  listCarriers?: Map<number, OsuListCarrier>
  /**
   * Cabeza sin lista portadora: el primer `[*]` que corta su título (más allá
   * del cierre del bloque) abre el cuerpo sintético. Clave: `start` de ese
   * `[*]`.
   */
  listHeadItems?: Map<number, OsuListCarrier>
  /**
   * Colector opcional de los tags de bloque que un TÍTULO lleva escritos y que
   * osu! selló de verdad, con la clave en `start` del token `open` de la caja
   * que los contiene y los eventos EN ORDEN de documento.
   *
   * El árbol necesita esta lista, no el texto del título: osu! sólo convierte
   * en `<div>`/`</div>` el tramo que su `preg_replace` emparejó, así que un tag
   * sobrante en el mismo título es texto literal (no cierra ni abre nada) y un
   * cierre sólo desplaza al real si compite con él por el mismo presupuesto.
   * El colector se rellena sólo si el llamante lo pasa.
   */
  titleEvents?: Map<number, OsuTitleEvent[]>
}

/**
 * Una lista sellada que la regla de título de `parseList` capturó a través de
 * un cierre de bloque. Ver `OsuPairingOptions.listCarriers`.
 */
export interface OsuListCarrier {
  /** Offset del `[list]` sellado que quedó auto-cerrado dentro del bloque. */
  headStart: number
  /** Si la cabeza era ordenada (`[list=1]`/`[list=a]`). */
  ordered: boolean
}

/** Un `[tag]`/`[/tag]` de bloque que un título selló — ver `titleEvents`. */
export interface OsuTitleEvent {
  /** Offset absoluto del tag en la fuente. Sólo ordena los eventos. */
  pos: number
  /** `true` para `[tag]` (abre), `false` para `[/tag]` (cierra). */
  open: boolean
  /** El tag de bloque de la familia div: `centre`, `notice`, `left`, … */
  tag: string
}

/**
 * El estado que comparten todas las pasadas: los tokens degradados y, sólo si
 * hay traza, la decisión de cada uno.
 *
 * `literal` es el único camino para degradar un token: así no se puede añadir
 * una pasada nueva que se olvide de dejarlo escrito en la traza.
 */
class Decisions {
  readonly forced: Uint8Array
  private readonly tokens: readonly BBCodeToken[]
  private readonly recorded: (OsuPairingStep | null)[] | null
  /** True once any token has been demoted; lets `materialize` skip the copy. */
  anyForced = false

  constructor(tokens: readonly BBCodeToken[], tracing: boolean) {
    this.tokens = tokens
    // `Uint8Array`, not `Array(n).fill(false)`: two zeroed buffers instead of
    // two holey arrays plus a fill pass, and a hundredth of the memory to
    // collect. Both are only ever read as booleans.
    this.forced = new Uint8Array(tokens.length)
    this.recorded = tracing ? new Array<OsuPairingStep | null>(tokens.length).fill(null) : null
  }

  /** Degrada el token a texto literal (una sola vez: la primera decisión gana). */
  literal(i: number, pass: string, reason: string, detail?: Readonly<Record<string, unknown>>): void {
    this.forced[i] = 1
    this.anyForced = true
    this.record(i, pass, 'literal', reason, detail)
  }

  /** Deja constancia de que el token se queda como etiqueta real. */
  sealed(i: number, pass: string, reason: string, detail?: Readonly<Record<string, unknown>>): void {
    this.record(i, pass, 'seal', reason, detail)
  }

  private record(i: number, pass: string, action: OsuPairingAction, reason: string, detail?: Readonly<Record<string, unknown>>): void {
    const recorded = this.recorded
    if (!recorded || recorded[i]) return
    const t = this.tokens[i]
    if (t.kind !== 'open' && t.kind !== 'close') return
    recorded[i] = detail
      ? { token: i, start: t.start, end: t.end, kind: t.kind, tag: t.tag, pass, action, reason, detail }
      : { token: i, start: t.start, end: t.end, kind: t.kind, tag: t.tag, pass, action, reason }
  }

  /** Emite la decisión de cada token en orden de documento. */
  flush(onDecision: (step: OsuPairingStep) => void): void {
    const recorded = this.recorded
    if (!recorded) return
    for (let i = 0; i < recorded.length; i++) {
      const t = this.tokens[i]
      if (t.kind !== 'open' && t.kind !== 'close') continue
      onDecision(recorded[i] ?? {
        token: i, start: t.start, end: t.end, kind: t.kind, tag: t.tag,
        pass: '—', action: 'untouched', reason: 'not-an-osu-tag',
      })
    }
  }
}

// ─── Block tags inside a box title ────────────────────────────────────────

/**
 * Los `[tag]`/`[/tag]` de bloque escritos DENTRO de un título de `[box=…]`, con
 * su offset absoluto en la fuente y el `start` del token que los contiene.
 *
 * osu! no parsea el título: su pasada del bloque inserta el texto en crudo
 * dentro del `link-text` y las pasadas de familia corren sobre el HTML
 * COMPLETO, así que un tag ahí dentro empareja como cualquier otro — su
 * `</div>`/`<div>` cae dentro del rótulo. Medido con el harness:
 *
 *   `[centre][box=T[/centre]]body[/box]` publica
 *   `<div class="well"><div box><a…>T</a></div><div body>body</div></div>`
 *   — el `[centre]` abre porque su cierre existe, dentro del título.
 *
 * Sólo los tags de `DIV_UNITS` (`Parser.ts`): son los que emiten `<div>` y los
 * únicos que un cierre puede reencauzar por conteo. Se excluye `center`, que
 * osu! no reconoce, y los de formato (`b`, `size`…), cuyo cierre en un título
 * no parte bloques (otra regla, medida aparte).
 */
const TITLE_UNIT_TAGS: readonly string[] = ['box', 'spoilerbox', 'notice', 'centre', 'left', 'right']

/** Regex de un cierre de `TITLE_UNIT_TAGS`, sin `/i`: osu! no sella mayúsculas. */
const TITLE_CLOSER_RE = /\[\/(box|spoilerbox|notice|centre|left|right)\]/g

/**
 * Aperturas de bloque que osu! reconoce DESNUDAS dentro de un título y que
 * abren un `<div>`: el mismo presupuesto que los cierres de arriba. `box`/`boxw`
 * quedan fuera a propósito — sin `=` no son un tag para osu! (`BBCodeForDB::parseBox`
 * exige `\[box=(…)\]`) —, y `spoilerbox` también, porque su div lleva rótulo
 * propio y no está medido: ninguna de las 7 páginas del corpus lo usa.
 */
const TITLE_OPENER_RE = /\[(centre|left|right|notice)\]/g

interface TitleTag {
  /** Offset absoluto del `[`. */
  pos: number
  /** Índice del token `open` de la caja cuyo título lo contiene (para el flujo
   *  mezclado de `sealLazyWithTitle`). */
  ownerIndex: number
  /** `start` de ese token (la clave del colector que lee `Parser.ts`). */
  ownerStart: number
}

interface TitleTags {
  openers: TitleTag[]
  closers: TitleTag[]
}

/** Compartido por los tags sin nada en ningún título: no asigna por pasada. */
const EMPTY_TITLE_TAGS: readonly TitleTag[] = []

/**
 * Índice, por tag, de los tags de bloque escritos dentro de títulos — ver
 * `TITLE_UNIT_TAGS`/`TITLE_OPENER_RE`. Se construye una vez por
 * `applyOsuPairing` y sólo toca los tokens de caja con un `[` en el atributo:
 * en 8.761 páginas del corpus son 9 con un cierre (20 `[/centre]`, 1
 * `[/notice]`) y 7 con una apertura (15 `[centre]`, 1 `[notice]`), así que el
 * coste es anecdótico. Cada lista sale en orden de posición (los tokens de caja
 * vienen en orden de documento y dentro de un título el regex va de izquierda a
 * derecha), que es lo que asume el flujo mezclado.
 */
function indexTitleTags(tokens: readonly BBCodeToken[], source: string): Map<string, TitleTags> | null {
  // No `[box=…]` spelling means no title claims can exist. The spelling is
  // case-sensitive, as osu!'s own box pass is.
  if (!source.includes('[box=') && !source.includes('[boxw=') && !source.includes('[spoilerbox=')) return null
  let byTag: Map<string, TitleTags> | null = null
  const add = (tag: string, closer: boolean, pos: number, ownerIndex: number, ownerStart: number) => {
    byTag ??= new Map()
    let entry = byTag.get(tag)
    if (entry === undefined) {
      entry = { openers: [], closers: [] }
      byTag.set(tag, entry)
    }
    const list = closer ? entry.closers : entry.openers
    list.push({ pos, ownerIndex, ownerStart })
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind !== 'open') continue
    if (t.tag !== 'box' && t.tag !== 'boxw' && t.tag !== 'spoilerbox') continue
    const attrs = t.attrs
    if (!attrs.includes('[')) continue
    // `attrs` es la cola del token (el `]` cierra el tag), así que el texto del
    // título empieza `attrs.length` antes del final del propio token.
    const base = t.end - attrs.length
    TITLE_CLOSER_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = TITLE_CLOSER_RE.exec(attrs)) !== null) {
      add(m[1], true, base + m.index, i, t.start)
    }
    TITLE_OPENER_RE.lastIndex = 0
    while ((m = TITLE_OPENER_RE.exec(attrs)) !== null) {
      add(m[1], false, base + m.index, i, t.start)
    }
  }
  return byTag
}

// ─── Filter ───────────────────────────────────────────────────────────────

/**
 * Returns a NEW token array where every `open`/`close` token osu! would not
 * seal has been demoted to an equivalent `text` token (same `start`/`end`,
 * `value` = the exact source slice). Tokens for tags with no entry in
 * {@link OSU_FAMILY} (miliastry-only tags, `*`, `empty_line`) are returned
 * completely untouched, so they keep pairing by Quasar's normal structural
 * rules. `text`/`newline` tokens are always untouched.
 *
 * `options.onDecision` es la traza opt-in: mismas decisiones, mismo orden,
 * cero coste cuando no se pide (ver {@link OsuPairingStep}).
 */
export function applyOsuPairing(
  tokens: readonly BBCodeToken[],
  source: string,
  options?: OsuPairingOptions,
): BBCodeToken[] {
  const n = tokens.length
  const d = new Decisions(tokens, options?.onDecision !== undefined)
  const caseOk = new Uint8Array(n)
  const titleTags = indexTitleTags(tokens, source)

  for (let i = 0; i < n; i++) {
    const t = tokens[i]
    if (t.kind === 'open' || t.kind === 'close') {
      const at = t.kind === 'open' ? t.start + 1 : t.start + 2
      // `startsWith` compares without allocating a substring per tag token.
      caseOk[i] = source.startsWith(t.tag, at) ? 1 : 0
      // `center`/`colour`: unconditionally literal, both open and close.
      if (OSU_FAMILY[t.tag]?.kind === 'neverSeal') d.literal(i, 'neverSeal', 'not-osu-syntax')
    }
  }

  // `imagemap` MUST run first: it protects its own interior from every other
  // family, exactly mirroring osu!'s pass order (imagemap, then code, then
  // everything else — code's protection is already free, see module doc).
  const collapsed = sealImagemapProtecting(tokens, source, caseOk, d)

  let index: TokenIndex | undefined
  for (const tag of Object.keys(OSU_FAMILY)) {
    const family = OSU_FAMILY[tag]
    switch (family.kind) {
      case 'lazy': {
        if (tag === 'imagemap') continue // already handled above
        const title = titleTags?.get(tag)
        sealLazy(
          tag, family, tokens, source, index ??= indexTokens(tokens, collapsed), caseOk, d,
          title?.closers, title?.openers, options?.titleEvents,
        )
        break
      }
      case 'rawBlock':
        sealRawBlock(tag, tokens, index ??= indexTokens(tokens, collapsed), source, caseOk, d)
        break
      case 'alwaysSeal':
        sealAlwaysSeal(tag, family.value, index ??= indexTokens(tokens, collapsed), caseOk, d, tokens)
        break
      case 'countLimited':
        sealCountLimited(
          tag, family.openerValid, tokens, index ??= indexTokens(tokens, collapsed), caseOk, d,
          tag === 'list' ? options?.listCarriers : undefined,
          tag === 'list' ? options?.listHeadItems : undefined,
        )
        break
      case 'img':
        sealImg(index ??= indexTokens(tokens, collapsed), source, caseOk, d, tokens)
        break
      case 'neverSeal':
        break // handled above, unconditionally
    }
  }

  // Los eventos de una MISMA caja llegan agrupados por tag (el bucle de arriba
  // recorre familias), pero el árbol tiene que aplicarlos en el orden en que
  // están escritos en el título: un `</div>` delante de su `<div>` cerraría
  // otra cosa. Sin colector no hay nada que ordenar.
  if (options?.titleEvents) {
    for (const events of options.titleEvents.values()) events.sort((a, b) => a.pos - b.pos)
  }

  if (options?.onDecision) d.flush(options.onDecision)
  // A clean document keeps its token objects; only the array has to be new
  // (the public contract promised a new array, not fresh tokens).
  return d.anyForced ? materialize(tokens, source, d.forced) : tokens.slice()
}

/**
 * La traza de sellado de una región de la fuente, para depurar un caso
 * concreto (una página, un `[/list]` sospechoso) sin llenar la consola del
 * scan entero.
 *
 * Devuelve un paso por token `open`/`close` que solape `[from, to)`, en orden
 * de documento. Sin rango, la página entera.
 */
export function traceOsuPairing(
  tokens: readonly BBCodeToken[],
  source: string,
  range?: { from?: number; to?: number },
): OsuPairingStep[] {
  const from = range?.from ?? 0
  const to = range?.to ?? Number.POSITIVE_INFINITY
  const out: OsuPairingStep[] = []
  applyOsuPairing(tokens, source, {
    onDecision: (step) => {
      if (step.end <= from || step.start >= to) return
      out.push(step)
    },
  })
  return out
}

function materialize(tokens: readonly BBCodeToken[], source: string, forced: Uint8Array): BBCodeToken[] {
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

/**
 * Seals every `imagemap` pair and forces its interior tags to literal text.
 *
 * Returns the newline tokens it COLLAPSED: osu!'s `parseImagemap` escapes the
 * whole captured body through `extraEscapes`, which turns every `\n` into
 * `&#10;`. The sealed map is therefore a SINGLE line for every pass that runs
 * after it, and the single-line families (`heading`, `audio`, `profile`,
 * `email`, `url`, `youtube`) can pair across its body. No other escaping pass
 * can do this: `code` keeps its surrounding newlines outside the escaped
 * group, and every other family's regex is non-dotall, so its body never held
 * a newline to begin with.
 */
function sealImagemapProtecting(
  tokens: readonly BBCodeToken[],
  source: string,
  caseOk: Uint8Array,
  d: Decisions,
): Uint8Array {
  const collapsed = new Uint8Array(tokens.length)
  // Most pages have no imagemap at all; the two full scans below are pure
  // overhead there. `imagemap` is case-sensitive in osu!'s pass, so a page
  // with only `[IMAGEMAP]` also takes the fast exit.
  if (source.indexOf('imagemap') === -1) return collapsed
  const closers: number[] = []
  for (let j = 0; j < tokens.length; j++) {
    const t = tokens[j]
    if (t.kind === 'close' && t.tag === 'imagemap' && caseOk[j]) closers.push(j)
  }
  let nextCloser = 0
  let cursor = 0
  while (cursor < tokens.length) {
    let openIdx = -1
    for (let i = cursor; i < tokens.length; i++) {
      const t = tokens[i]
      if (d.forced[i] || t.kind !== 'open' || t.tag !== 'imagemap') continue
      if (!caseOk[i]) { d.literal(i, 'imagemap', 'case'); continue }
      openIdx = i
      break
    }
    if (openIdx === -1) break

    // The nearest closer after the opener, by a pointer that only moves
    // forward (openers come in document order): see `sealLazy`.
    while (nextCloser < closers.length && closers[nextCloser] <= openIdx) nextCloser++
    const closeIdx = nextCloser < closers.length ? closers[nextCloser] : -1
    if (closeIdx === -1) { d.literal(openIdx, 'imagemap', 'no-closer'); cursor = openIdx + 1; continue }

    const open = tokens[openIdx]
    const close = tokens[closeIdx]
    if (close.start === open.end) { d.literal(openIdx, 'imagemap', 'empty'); cursor = openIdx + 1; continue }

    for (let k = openIdx + 1; k < closeIdx; k++) {
      if (tokens[k].kind === 'open' || tokens[k].kind === 'close') d.literal(k, 'imagemap', 'imagemap-body', { opener: openIdx, closer: closeIdx })
      else if (tokens[k].kind === 'newline') collapsed[k] = 1
    }
    d.sealed(openIdx, 'imagemap', 'paired', { closer: closeIdx })
    d.sealed(closeIdx, 'imagemap', 'closer-of', { opener: openIdx })
    cursor = closeIdx + 1
  }
  return collapsed
}

// ─── lazy family ────────────────────────────────────────────────────────

/**
 * Where each tag's tokens are, and how many newlines precede each token:
 * built once per pairing and shared by every lazy pass, so a pass costs the
 * occurrences of its own tag, not a scan of the whole token list per tag.
 */
interface TokenIndex {
  openers: ReadonlyMap<string, readonly number[]>
  closers: ReadonlyMap<string, readonly number[]>
  /** Open and close indices for a tag, interleaved in document order. */
  all: ReadonlyMap<string, readonly number[]>
  /** Newline tokens before index i (no pass ever demotes a newline). */
  newlinesBefore: Int32Array
}

/**
 * `collapsed` marks newline tokens a sealed `imagemap` escaped away: they still
 * exist in the source (and in the tree), but for "does this pairing cross a
 * newline" they are not there any more — see `sealImagemapProtecting`.
 */
function indexTokens(tokens: readonly BBCodeToken[], collapsed: Uint8Array): TokenIndex {
  const openers = new Map<string, number[]>()
  const closers = new Map<string, number[]>()
  const all = new Map<string, number[]>()
  const newlinesBefore = new Int32Array(tokens.length + 1)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    newlinesBefore[i + 1] = newlinesBefore[i] + (t.kind === 'newline' && !collapsed[i] ? 1 : 0)
    if (t.kind !== 'open' && t.kind !== 'close') continue
    const by = t.kind === 'open' ? openers : closers
    let list = by.get(t.tag)
    if (list) list.push(i)
    else by.set(t.tag, (list = [i]))
    const every = all.get(t.tag)
    if (every) every.push(i)
    else all.set(t.tag, [i])
  }
  return { openers, closers, all, newlinesBefore }
}

function sealLazy(
  tag: string,
  family: LazyFamily,
  tokens: readonly BBCodeToken[],
  source: string,
  index: TokenIndex,
  caseOk: Uint8Array,
  d: Decisions,
  titleClosers?: readonly TitleTag[],
  titleOpeners?: readonly TitleTag[],
  titleSink?: Map<number, OsuTitleEvent[]>,
): void {
  const pass = `lazy:${tag}`
  const openers = index.openers.get(tag) ?? []
  const closers = index.closers.get(tag) ?? []
  // Most documents use a fraction of the family table; do not allocate the
  // consumed-close Set or sweep for a tag that never appears.
  if (openers.length === 0 && closers.length === 0) return

  /**
   * El texto entre el nombre y el `]`, tal y como está escrito — no la copia
   * recortada del token: osu! distingue `[url]` de `[url ]`, y en su `=valor`
   * los espacios cuentan (el recorte del lexer se los comería).
   */
  const rawAttrs = (open: Extract<BBCodeToken, { kind: 'open' }>): string =>
    source.slice(open.start + 1 + open.tag.length, open.end - 1)

  // Un tag escrito dentro de un TÍTULO entra en el MISMO presupuesto que los
  // reales: osu! corre su pasada sobre el texto, donde el título está en
  // crudo, así que para él no hay diferencia. Con títulos el camino es el
  // otro `sealLazyWithTitle` — ver ahí por qué el orden importa. Sin ellos
  // (8.752 de 8.761 páginas del corpus) no se roza nada de aquí abajo.
  if (family.dotall && ((titleClosers !== undefined && titleClosers.length > 0) ||
      (titleOpeners !== undefined && titleOpeners.length > 0))) {
    sealLazyWithTitle(
      tag, family, tokens, source, caseOk, d, openers, closers,
      titleOpeners ?? EMPTY_TITLE_TAGS, titleClosers ?? EMPTY_TITLE_TAGS, titleSink,
    )
    return
  }

  // Indices of close tokens actually consumed as the nearest match of some
  // opener below — i.e. genuinely part of a `\[tag\](.*?)\[/tag\]` MATCH,
  // not just left un-visited by the opener-driven scan. `preg_replace` only
  // ever transforms a matched SPAN; a `[/tag]` that is not part of one is
  // never touched by this tag's pass at all and stays literal — see the
  // sweep below.
  const consumedClose = new Set<number>()

  // Openers are met in document order and nothing below demotes a closer
  // before the sweep, so "the nearest closer after this opener" is a pointer
  // that only moves forward. Scanning ahead for it from every opener instead
  // made n unclosed openers cost n² — 10 s for 64 000 `[b]`.
  let nextOpener = 0
  let nextCloser = 0
  while (nextOpener < openers.length) {
    const openIdx = openers[nextOpener++]
    if (d.forced[openIdx]) continue
    const t = tokens[openIdx] as Extract<BBCodeToken, { kind: 'open' }>
    if (!caseOk[openIdx]) { d.literal(openIdx, pass, 'case'); continue }

    // `=valor` o forma desnuda. El valor se prueba sólo cuando hay `=`:
    // `[url]https://x[/url]` lleva la URL en el CUERPO, y ahí la prueba es
    // `bareContentPattern` (más abajo, con el cierre ya conocido).
    const attrs = rawAttrs(t)
    const valued = attrs.startsWith('=')
    if (family.valuePattern !== undefined) {
      if (valued) {
        if (!family.valuePattern.test(attrs.slice(1))) { d.literal(openIdx, pass, 'bad-value', { value: attrs.slice(1) }); continue }
      } else if (family.bareContentPattern === undefined && !family.valuePattern.test(attrs)) {
        // Sin forma desnuda en osu! (`[color]`, `[size]`): el tag queda escrito.
        d.literal(openIdx, pass, 'bad-value', { value: attrs }); continue
      }
    }
    if (family.bareContentPattern !== undefined && !valued && attrs !== '') {
      // `[url = x]` no es el `[url]` de osu! (ni un `[url=`): queda escrito.
      d.literal(openIdx, pass, 'bad-value', { value: attrs }); continue
    }
    if (family.valuePattern === undefined && family.bareContentPattern === undefined && attrs !== '') {
      // osu! no tiene pase para esta forma: su regex escribe el tag DESNUDO
      // (`#\[b](.*?)\[/b\]#`), así que `[b=x]a[/b]` no coincide y lo publica
      // tal cual — igual que `[heading=2]`, `[centre=x]`, `[c ]` o
      // `[youtube=x]`. Medido caso a caso en `.cache/c-code-attrs`.
      d.literal(openIdx, pass, 'unexpected-value', { value: attrs }); continue
    }

    while (
      nextCloser < closers.length &&
      (closers[nextCloser] <= openIdx || d.forced[closers[nextCloser]] || !caseOk[closers[nextCloser]])
    ) nextCloser++
    let closeIdx = nextCloser < closers.length ? closers[nextCloser] : -1
    // Without `/s` the lazy `.*?` stops at the first newline: a closer past
    // one is out of this opener's reach.
    let blockedByNewline = false
    const outOfReach = (): boolean => {
      if (family.dotall || index.newlinesBefore[closeIdx] <= index.newlinesBefore[openIdx + 1]) return false
      closeIdx = -1
      blockedByNewline = true
      return true
    }
    if (closeIdx !== -1) outOfReach()

    // Un cierre PEGADO al apertura deja el contenido vacío, y el `.*?`/`.+?`
    // perezoso de osu! no lo acepta: la búsqueda sigue hacia delante y ese
    // `[/tag]` acaba DENTRO del tag como texto. Medido (`.cache/url-close`,
    // C39): `[url=https://x][/url]T[/url]` publica un enlace al `x` cuyo texto
    // es `[/url]T`, y el cierre descartado sale escrito.
    while (closeIdx !== -1 && !family.allowEmpty && (tokens[closeIdx] as { start: number }).start === t.end) {
      d.literal(closeIdx, pass, 'empty-content-closer', { opener: openIdx })
      nextCloser++
      while (nextCloser < closers.length && (d.forced[closers[nextCloser]] || !caseOk[closers[nextCloser]])) nextCloser++
      closeIdx = nextCloser < closers.length ? closers[nextCloser] : -1
      blockedByNewline = false
      if (closeIdx !== -1) outOfReach()
    }

    if (closeIdx === -1) {
      d.literal(openIdx, pass, blockedByNewline ? 'newline' : 'no-closer')
      continue
    }

    if (family.bareContentPattern !== undefined && !valued &&
        !family.bareContentPattern.test(source.slice(t.end, (tokens[closeIdx] as { start: number }).start))) {
      d.literal(openIdx, pass, 'bad-content', { content: source.slice(t.end, (tokens[closeIdx] as { start: number }).start) })
      continue
    }

    // Swallowed as content: a same-tag OPENER strictly inside can never
    // itself become a tag (osu! non-nesting). A same-tag CLOSER inside is
    // already an orphan this module now forces to text on its own — see the
    // sweep below and module doc's `lazy` section.
    while (nextOpener < openers.length && openers[nextOpener] < closeIdx) {
      const swallowed = openers[nextOpener++]
      d.literal(swallowed, pass, 'nested-opener', { swallowedBy: openIdx })
    }
    consumedClose.add(closeIdx)
    d.sealed(openIdx, pass, 'paired', { closer: closeIdx })
    d.sealed(closeIdx, pass, 'closer-of', { opener: openIdx })
    nextCloser++
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
  for (const i of closers) {
    if (d.forced[i]) continue
    if (!caseOk[i]) d.literal(i, pass, 'case')
    else if (!consumedClose.has(i)) d.literal(i, pass, 'unconsumed-closer')
  }
}

/**
 * `sealLazy` para una página con tags de bloque dentro de un título — ver
 * `TITLE_UNIT_TAGS`, `TITLE_OPENER_RE` e `indexTitleTags`. Sólo se entra aquí
 * cuando el tag tiene alguno (9 páginas del corpus con un cierre, 7 con una
 * apertura).
 *
 * El presupuesto es UNO solo, en orden de documento: osu! corre `preg_replace`
 * (`\[tag](.*?)\[/tag]`, perezoso y con `/s`) sobre el texto y el título está
 * en crudo, así que un tag dentro de un `[box=…]` compite con los reales por el
 * mismo hueco y gana el más CERCANO hacia adelante. Tres consecuencias medidas
 * con el harness, todas en este fichero:
 *
 * - un apertura cuyo cierre más cercano está en un título POSTERIOR sí abre
 *   (antes se quedaba literal: `[centre][box=T[/centre]]body[/box]` publicaba
 *   `[centre]` como texto donde osu! abre el centro y parte la caja);
 * - el cierre real que el de título desplaza sólo sirve al siguiente apertura
 *   y, si no queda ninguno, la barrida lo publica LITERAL — osu! hace lo
 *   mismo (`[centre][box=T[/centre]]body[/box][/centre]` termina con un
 *   `[/centre]` visible). Ese `</div>`/texto suelto lo coloca el árbol
 *   (`Parser.ts`), no este módulo;
 * - una APERTURA dentro del título también compite: si su cierre está fuera de
 *   él, su `<div>` se abre ahí y el cuerpo de la caja cae DENTRO
 *   (`box-title-opener-sealed.bbcode`), así que el árbol abre un nodo por ella
 *   (evento `open` de `titleEvents`).
 *
 * Un par que nace y muere dentro del MISMO título es el caso normal y no
 * produce evento alguno: osu! abre y cierra ese `<div>` dentro del rótulo, sin
 * tocar ni el wrapper ni el cuerpo.
 *
 * `family.dotall` es siempre cierto aquí: los únicos tags indexados son los
 * div de `TITLE_UNIT_TAGS`/`TITLE_OPENER_RE`, todos `LAZY_MULTILINE`, así que el
 * chequeo de salto de línea no aplica (una familia de una sola línea
 * necesitaría contar nuevas líneas contra un offset absoluto, no un token).
 */
function sealLazyWithTitle(
  tag: string,
  family: LazyFamily,
  tokens: readonly BBCodeToken[],
  source: string,
  caseOk: Uint8Array,
  d: Decisions,
  openers: readonly number[],
  closers: readonly number[],
  titleOpeners: readonly TitleTag[],
  titleClosers: readonly TitleTag[],
  titleSink: Map<number, OsuTitleEvent[]> | undefined,
): void {
  const pass = `lazy:${tag}`

  // Flujos únicos, en orden de documento: cada entrada es un tag real (índice
  // de token) o uno de título (con el token de la caja que lo contiene), y cada
  // uno lleva su offset para comparar posiciones. Las dos listas de cada lado
  // ya vienen ordenadas por posición, así que la mezcla es lineal.
  const opPos: number[] = []
  const opTok: number[] = []
  const opOwner: (TitleTag | null)[] = []
  const clPos: number[] = []
  const clTok: number[] = []
  const clOwner: (TitleTag | null)[] = []
  {
    let a = 0
    let b = 0
    while (a < openers.length || b < titleOpeners.length) {
      const realPos = a < openers.length ? (tokens[openers[a]] as { start: number }).start : Number.POSITIVE_INFINITY
      const titlePos = b < titleOpeners.length ? titleOpeners[b].pos : Number.POSITIVE_INFINITY
      if (realPos <= titlePos) {
        opPos.push(realPos); opTok.push(openers[a]); opOwner.push(null); a++
      } else {
        opPos.push(titlePos); opTok.push(-1); opOwner.push(titleOpeners[b]); b++
      }
    }
    a = 0
    b = 0
    while (a < closers.length || b < titleClosers.length) {
      const realPos = a < closers.length ? (tokens[closers[a]] as { start: number }).start : Number.POSITIVE_INFINITY
      const titlePos = b < titleClosers.length ? titleClosers[b].pos : Number.POSITIVE_INFINITY
      if (realPos <= titlePos) {
        clPos.push(realPos); clTok.push(closers[a]); clOwner.push(null); a++
      } else {
        clPos.push(titlePos); clTok.push(-1); clOwner.push(titleClosers[b]); b++
      }
    }
  }

  /**
   * Deja constancia de que un tag de un título se selló de verdad. La clave es
   * el `start` del token de la caja: es lo que tiene a mano el árbol al
   * construir (`Parser.ts`), no su índice.
   */
  const record = (owner: TitleTag, open: boolean, pos: number): void => {
    if (titleSink === undefined) return
    const events = titleSink.get(owner.ownerStart)
    if (events === undefined) titleSink.set(owner.ownerStart, [{ pos, open, tag }])
    else events.push({ pos, open, tag })
  }

  const consumedClose = new Set<number>()
  let nextOpener = 0
  let nextCloser = 0
  while (nextOpener < opPos.length) {
    const openPos = opPos[nextOpener]
    const openIdx = opTok[nextOpener]
    const openOwner = opOwner[nextOpener]
    nextOpener++
    if (openIdx !== -1) {
      if (d.forced[openIdx]) continue
      const t = tokens[openIdx] as Extract<BBCodeToken, { kind: 'open' }>
      if (!caseOk[openIdx]) { d.literal(openIdx, pass, 'case'); continue }
      const raw = source.slice(t.start + 1 + t.tag.length, t.end - 1)
      if (family.valuePattern) {
        const value = raw.startsWith('=') ? raw.slice(1) : raw
        if (!family.valuePattern.test(value)) { d.literal(openIdx, pass, 'bad-value', { value }); continue }
      } else if (family.bareContentPattern === undefined && raw !== '') {
        // Misma forma desnuda que en `sealLazy`: un `[centre=x]` escrito
        // dentro del rótulo de una caja tampoco sella en osu!.
        d.literal(openIdx, pass, 'unexpected-value', { value: raw }); continue
      }
    }

    // El cierre más cercano que siga disponible. Un cierre real ya forzado a
    // texto o con mal caso se salta para siempre, igual que arriba.
    let hit = -1
    while (nextCloser < clPos.length) {
      if (clPos[nextCloser] <= openPos) { nextCloser++; continue }
      const closeTok = clTok[nextCloser]
      if (closeTok !== -1 && (d.forced[closeTok] || !caseOk[closeTok])) { nextCloser++; continue }
      hit = nextCloser
      break
    }
    if (hit === -1) {
      // Una apertura de título sin cierre sencillamente no se sella: osu! la
      // deja escrita en el rótulo y el árbol no abre nada por ella.
      if (openIdx !== -1) d.literal(openIdx, pass, 'no-closer')
      continue
    }

    const closeTok = clTok[hit]
    // `allowEmpty` sólo puede fallar con un cierre real: el de un título vive
    // dentro del `[box=…]`, así que su offset queda siempre tras el `]` del
    // apertura (imposible que coincidan exactamente).
    if (openIdx !== -1 && closeTok !== -1 && !family.allowEmpty &&
        (tokens[closeTok] as { start: number }).start === (tokens[openIdx] as { end: number }).end) {
      d.literal(openIdx, pass, 'empty')
      // El cierre vacío no se consume: el siguiente apertura puede usarlo.
      nextCloser++
      continue
    }

    // Contenido tragado: un apertura del mismo tag estrictamente dentro del
    // tramo no llega a ser etiqueta (osu! no anida). Una de título tampoco: el
    // texto se queda en el rótulo, sin nodo.
    const limit = clPos[hit]
    while (nextOpener < opPos.length && opPos[nextOpener] < limit) {
      const swallowed = opTok[nextOpener++]
      if (swallowed !== -1) d.literal(swallowed, pass, 'nested-opener', { swallowedBy: openIdx })
    }

    const closeTitle = clOwner[hit]
    // Un par que nace y muere dentro del MISMO título vive entero en el rótulo:
    // no abre nada fuera de él ni gasta unidades de la caja.
    if (openOwner !== null && closeTitle !== null && closeTitle.ownerIndex === openOwner.ownerIndex) {
      nextCloser++
      continue
    }

    if (closeTitle !== null) {
      record(closeTitle, false, clPos[hit])
    } else {
      consumedClose.add(closeTok)
      d.sealed(closeTok, pass, 'closer-of', { opener: openIdx !== -1 ? openIdx : openPos })
    }

    if (openOwner !== null) {
      record(openOwner, true, openPos)
    } else {
      d.sealed(openIdx, pass, closeTitle !== null ? 'title-closer' : 'paired',
        closeTitle !== null ? { titleCloser: clPos[hit] } : { closer: closeTok })
    }
    nextCloser++
  }

  // Misma barrida que `sealLazy`: un cierre real que ningún apertura consumió
  // es texto literal en osu!.
  for (const i of closers) {
    if (d.forced[i]) continue
    if (!caseOk[i]) d.literal(i, pass, 'case')
    else if (!consumedClose.has(i)) d.literal(i, pass, 'unconsumed-closer')
  }
}

// ─── rawBlock family (code, c) ────────────────────────────────────────────

function sealRawBlock(
  tag: string,
  tokens: readonly BBCodeToken[],
  index: TokenIndex,
  source: string,
  caseOk: Uint8Array,
  d: Decisions,
): void {
  const pass = `raw:${tag}`
  const openers = index.openers.get(tag) ?? []
  for (const i of openers) {
    if (d.forced[i]) continue
    const t = tokens[i] as Extract<BBCodeToken, { kind: 'open' }>
    if (!caseOk[i]) { d.literal(i, pass, 'case'); continue }

    // El regex de osu! escribe el tag DESNUDO (`#\[code](?<prespaces>\n*)…`),
    // así que un `[code=x]` no sella: se publica como texto, etiquetas
    // incluidas. Medido (`.cache/c-code-attrs`, a08).
    const attrs = source.slice(t.start + 1 + tag.length, t.end - 1)
    if (attrs !== '') { d.literal(i, pass, 'unexpected-value', { value: attrs }); continue }

    // The lexer's raw-block handling always emits: open, [text?], close —
    // contiguous — or just `open` (no closer anywhere, so nothing was
    // isolated). A non-contiguous `open` therefore means the pair never
    // sealed for osu! either.
    let j = i + 1
    if (j < tokens.length && tokens[j].kind === 'text' && tokens[j].start === t.end) j++
    const closeTok = j < tokens.length ? tokens[j] : null
    const isContiguousClose =
      closeTok !== null && closeTok.kind === 'close' && closeTok.tag === tag &&
      closeTok.start === (j > i + 1 ? tokens[j - 1].end : t.end)

    if (!isContiguousClose) { d.literal(i, pass, 'no-closer'); continue }
    const closeIdx = j
    if (!caseOk[closeIdx]) {
      d.literal(i, pass, 'case')
      d.literal(closeIdx, pass, 'case')
      continue
    }
    // Cuerpo `.+?`: un `[code][/code]` sin un solo carácter tampoco sella —
    // osu! publica las dos etiquetas escritas. Los saltos SÍ cuentan como
    // cuerpo: `[code]\n[/code]` sella (`prespaces`/`postspaces` son `\n*`,
    // pero el `.` lleva `/s` y recoge el salto que a aquellos les sobre).
    // Sólo se llega aquí cuando NINGÚN cierre posterior servía: un cuerpo
    // vacío con otro `[/code]` más adelante lo resolvió el lexer (véase el
    // escaneo perezoso en `Lexer/BBCodeLexer.ts`, `.cache/c-code2` e01–e07).
    if (j === i + 1) {
      d.literal(i, pass, 'empty')
      d.literal(closeIdx, pass, 'empty')
      continue
    }
    d.sealed(i, pass, 'paired', { closer: closeIdx })
    d.sealed(closeIdx, pass, 'closer-of', { opener: i })
  }
}

// ─── alwaysSeal family (box, spoilerbox) ──────────────────────────────────

function sealAlwaysSeal(
  tag: string,
  value: 'required' | 'forbidden',
  index: TokenIndex,
  caseOk: Uint8Array,
  d: Decisions,
  tokens: readonly BBCodeToken[],
): void {
  const pass = `alwaysSeal:${tag}`
  const indices = index.all.get(tag) ?? []
  for (const i of indices) {
    const t = tokens[i]
    if (!caseOk[i]) { d.literal(i, pass, 'case'); continue }
    if (t.kind === 'open') {
      // `[box=]` seals: osu! asks only that the `=` be there, and an empty
      // title is a box whose label is empty. Testing `length > 1` demanded a
      // character after the `=`, so 800+ pages of the corpus had their
      // `[box=]` printed as literal text while osu! opened the box.
      const hasValue = t.attrs.startsWith('=')
      if (value === 'required' && !hasValue) { d.literal(i, pass, 'missing-value'); continue }
      if (value === 'forbidden' && t.attrs !== '') { d.literal(i, pass, 'unexpected-value'); continue }
      d.sealed(i, pass, 'unconditional', { hasValue: t.attrs !== '' })
      continue
    }
    // close tokens: always seal once case matches — osu!'s `strtr` marks
    // every `[/box]`/`[/spoilerbox]` unconditionally.
    d.sealed(i, pass, 'unconditional-close')
  }
}

// ─── countLimited family (quote, list) ────────────────────────────────────

function sealCountLimited(
  tag: string,
  openerValid: (attrs: string) => boolean,
  tokens: readonly BBCodeToken[],
  index: TokenIndex,
  caseOk: Uint8Array,
  d: Decisions,
  listCarriers?: Map<number, OsuListCarrier>,
  listHeadItems?: Map<number, OsuListCarrier>,
): void {
  const pass = `countLimited:${tag}`
  const openers: number[] = []
  const closers: number[] = []
  for (const i of index.all.get(tag) ?? []) {
    if (d.forced[i]) continue
    const t = tokens[i]
    if (t.kind === 'open') {
      if (!caseOk[i]) d.literal(i, pass, 'case')
      else if (!openerValid(t.attrs)) d.literal(i, pass, 'bad-opener')
      else openers.push(i)
    } else if (caseOk[i]) closers.push(i)
    else d.literal(i, pass, 'case')
  }
  const limit = Math.min(openers.length, closers.length)
  // Presupuesto: el mismo objeto para todos los tokens de la pasada.
  const counts = { openers: openers.length, closers: closers.length, limit }
  for (let k = 0; k < openers.length; k++) {
    if (k < limit) d.sealed(openers[k], pass, 'within-limit', counts)
    else d.literal(openers[k], pass, 'over-limit', counts)
  }
  for (let k = 0; k < closers.length; k++) {
    if (k < limit) d.sealed(closers[k], pass, 'within-limit', counts)
    else d.literal(closers[k], pass, 'over-limit', counts)
  }
  if ((listCarriers !== undefined || listHeadItems !== undefined) && tag === 'list' && limit > 0) {
    findListCarriers(tokens, caseOk, openers.slice(0, limit), listCarriers, listHeadItems)
  }
}

/**
 * Detecta las listas que `parseList` deja cruzando un cierre de caja y anota,
 * para cada portadora, qué cabeza lleva dentro.
 *
 * La condición sale del propio texto de osu!: `parseBox` corre antes que
 * `parseList`, así que la regla de título `[list:uid](.+?)(<li>|</ol>)` ve el
 * `</div>` del box en medio de su captura. Si entre la apertura y el primer
 * `<li>` (o `</ol>`) hay un `</div>` que cierra el box que la contiene, la
 * captura cruza: el `<ol>` nuevo nace en el primer ítem de la lista siguiente,
 * que es la portadora. No se tocan listas anidadas dentro de la cabeza antes
 * del cierre (ahí la captura para en el `<li>` de la anidada, no en el de la
 * siguiente) ni listas sin ítem.
 */
function findListCarriers(
  tokens: readonly BBCodeToken[],
  caseOk: Uint8Array,
  sealedOpeners: readonly number[],
  sink: Map<number, OsuListCarrier> | undefined,
  itemSink: Map<number, OsuListCarrier> | undefined,
): void {
  const n = tokens.length
  // Profundidad de cajas SELLADAS antes de cada token. `[box]` desnudo no
  // emite `<div>`; `[box=...]` y `[spoilerbox]` desnudo sí. El `[/box]` de un
  // `[box]` desnudo es sellado igual (strtr), pero sin apertura que cerrar.
  const depth = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) {
    const t = tokens[i]
    let d = depth[i]
    if (caseOk[i]) {
      if (t.kind === 'open') {
        if ((t.tag === 'box' && t.attrs.startsWith('=')) || (t.tag === 'spoilerbox' && t.attrs === '')) d++
      } else if (t.kind === 'close' && (t.tag === 'box' || t.tag === 'spoilerbox')) {
        if (d > 0) d--
      }
    }
    depth[i + 1] = d
  }

  const sealed = new Set(sealedOpeners)
  for (const o of sealedOpeners) {
    const open = tokens[o]
    if (open.kind !== 'open') continue
    const atDepth = depth[o]
    if (atDepth === 0) continue

    let boundary = -1
    let firstItem = -1
    let firstClose = -1
    let nestedBefore = -1
    const carriers: number[] = []
    for (let i = o + 1; i < n; i++) {
      const t = tokens[i]
      if (firstClose === -1 && t.kind === 'close' && t.tag === 'list' && caseOk[i]) firstClose = i
      if (boundary === -1) {
        if (t.kind === 'close' && caseOk[i] &&
            (t.tag === 'box' || t.tag === 'spoilerbox') && depth[i + 1] < atDepth) {
          boundary = i
          continue
        }
        if (t.kind === 'open' && t.tag === '*' && firstItem === -1) {
          // El primer ítem llega antes del cierre de la caja: la captura para
          // en él y no hay cruce.
          firstItem = i
          break
        }
        if (t.kind === 'open' && t.tag === 'list' && sealed.has(i)) {
          // Una lista sellada ANIDADA dentro de la cabeza antes del cierre: su
          // propio `<li>` corta el título antes, no la portadora.
          nestedBefore = i
          break
        }
        continue
      }
      // Después de la frontera: el primer `[*]` corta el título; las listas
      // selladas de en medio son candidatas a portadoras.
      if (t.kind === 'open' && t.tag === '*') {
        firstItem = i
        break
      }
      if (t.kind === 'open' && t.tag === 'list' && sealed.has(i)) carriers.push(i)
      if (t.kind === 'close' && t.tag === 'list' && caseOk[i] && firstClose !== -1 && firstClose < i) break
    }

    if (nestedBefore !== -1 || boundary === -1 || firstItem === -1) continue
    // Un `</ol>` entre la frontera y el ítem corta la captura antes: el cuerpo
    // de la cabeza nace vacío, no en la lista siguiente.
    if (firstClose !== -1 && firstClose < firstItem) continue

    const attrs = open.attrs.startsWith('=') ? open.attrs.slice(1) : ''
    const carrier: OsuListCarrier = {
      headStart: open.start,
      ordered: attrs === '1' || attrs === 'a',
    }

    if (carriers.length === 1) {
      if (sink === undefined || sink.has(tokens[carriers[0]].start)) continue
      sink.set(tokens[carriers[0]].start, carrier)
    } else if (carriers.length === 0) {
      if (itemSink === undefined || itemSink.has(tokens[firstItem].start)) continue
      itemSink.set(tokens[firstItem].start, carrier)
    }
    // Más de una lista sellada antes del primer ítem: no se inventa una cadena
    // de cuerpos que osu! no publica con esa forma.
  }
}

// ─── img ────────────────────────────────────────────────────────────────

function sealImg(index: TokenIndex, source: string, caseOk: Uint8Array, d: Decisions, tokens: readonly BBCodeToken[]): void {
  const pass = 'img'
  for (const i of index.openers.get('img') ?? []) {
    if (d.forced[i]) continue
    const t = tokens[i] as Extract<BBCodeToken, { kind: 'open' }>
    if (!caseOk[i]) { d.literal(i, pass, 'case'); continue }

    // `\[img:uid\]`, desnudo: `[img round]` no sella (su URL interior la
    // enlaza el autolink, como cualquier texto suelto). Medido (a12).
    const attrs = source.slice(t.start + 1 + t.tag.length, t.end - 1)
    if (attrs !== '') { d.literal(i, pass, 'unexpected-value', { value: attrs }); continue }

    let j = i + 1
    while (j < tokens.length && tokens[j].kind !== 'open' && tokens[j].kind !== 'close') j++
    const next = j < tokens.length ? tokens[j] : null
    const isImgClose = next !== null && next.kind === 'close' && next.tag === 'img'
    const nonEmpty = next !== null && next.start > t.end
    // osu!'s own regex is `\[img:uid\]([^[]+)\[/img:uid\]`: a `[` anywhere
    // inside means the image is not an image and the page shows the tag as
    // text. That is how a JSON imagemap pasted into `[img]` publishes — the
    // whole blob, literally — instead of a broken `<img src="{">`.
    const hasBracket = next !== null && source.slice(t.end, next.start).includes('[')

    if (next === null) { d.literal(i, pass, 'no-closer'); continue }
    if (!isImgClose) { d.literal(i, pass, 'next-not-closer', { next: j }); continue }
    if (!caseOk[j]) { d.literal(i, pass, 'case'); continue }
    if (!nonEmpty) { d.literal(i, pass, 'empty'); continue }
    if (hasBracket) { d.literal(i, pass, 'bracket-inside'); continue }
    d.sealed(i, pass, 'paired', { closer: j })
    d.sealed(j, pass, 'closer-of', { opener: i })
  }
}
