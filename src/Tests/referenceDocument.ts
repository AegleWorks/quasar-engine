/**
 * The reference document the heavier suites parse.
 *
 * This replaces two `.milia` fixtures that used to sit next to `src/` and were
 * read with `fs.readFileSync`. They were never committed, so the moment they
 * were gone seven tests failed with `ENOENT` and nothing in the repository
 * could bring them back. A fixture a test cannot survive without belongs in the
 * repository, and the cheapest way to guarantee that is to make it code.
 *
 * Honest limitation: the originals were real posts from the wild, ~12 KB each.
 * This is a reconstruction. It reproduces the *shapes* that made those files
 * worth parsing — the ones listed below — but it cannot reproduce the surprise
 * of real user input. Anything found in a real document that this misses should
 * be added here rather than kept in an untracked file.
 *
 * What it deliberately contains:
 *
 *  - Deep nesting, and tags closed out of order by ordinary authors
 *  - Braille blanks (`⠀`) used as layout padding, which the exporter must not
 *    invent or drop
 *  - CRLF alongside LF, and runs of blank lines
 *  - Bracketed prose that is *not* a tag — `[90 misses]`, `[Gateron]` — which
 *    the parser renders literally and the validators must stay quiet about
 *  - Non-ASCII text and emoji, so offsets are exercised beyond one byte
 *  - Attribute values that themselves contain markup (`[box=[b]t[/b]]`)
 *  - Long stretches of plain text, so a gradient has characters to colour
 *
 * It must stay **valid**: `SemanticValidators` asserts zero errors and zero
 * warnings on it, on the grounds that a checker crying wolf on an ordinary
 * document is worse than a silent one. Adding a deprecated tag here would break
 * that on purpose, so don't.
 */

const SECTION_PAD = '⠀'.repeat(8)

export const REFERENCE_DOCUMENT = [
  '[centre]',
  `${SECTION_PAD}[size=150][b]perfil de ejemplo[/b][/size]${SECTION_PAD}`,
  '[/centre]',
  '',
  '[box=[b]sobre mí[/b]]',
  'Llevo jugando desde 2017 y sigo fallando los mismos patrones.',
  'Mi mejor racha this season fue un [90 misses] limpio — sí, limpio.',
  'Teclado [Gateron] rojo, tableta pequeña, mucha paciencia. 🎵',
  '[/box]',
  '',
  '[centre]',
  // Author colours must stay OUTSIDE `REFERENCE_GRADIENT_COLORS`: the HTML
  // suite proves a gradient's stops are absent without a gradient layer, and a
  // collision here would make that assertion unprovable.
  '[color=#7aa2f7]━━━━━━━━━━━━━━━━━━━━━━━━━━━━[/color]',
  '[/centre]',
  '',
  '[b]Cosas que me gustan[/b]',
  '[list]',
  '[*]Mapas de stream largos, aunque no los pase',
  '[*]Skins minimalistas con hitsounds fuertes',
  '[*]Los mapas de [i]Sotarks[/i] cuando está inspirado',
  '[/list]',
  '',
  // Deliberate CRLF island: the lexer folds line endings and the partition
  // invariant has to keep covering both bytes of a `\r\n`.
  'Una sección con saltos de Windows:\r\nsegunda línea\r\ntercera línea',
  '',
  '',
  '',
  '[quote]',
  '"El ritmo no se piensa, se siente." — alguien en el chat, 3 AM',
  '[/quote]',
  '',
  '[b][i]Texto anidado[/i] que cierra en otro orden[/b]',
  '',
  'Un enlace normal: [url=https://osu.ppy.sh]mi perfil[/url]',
  'Y otro suelto: [url]https://osu.ppy.sh/beatmapsets[/url]',
  '',
  '[centre]',
  `${SECTION_PAD}[color=#9ece6a]gracias por leer[/color]${SECTION_PAD}`,
  '',
  'Texto largo para que un degradado tenga suficientes caracteres que colorear ',
  'y el render produzca un nodo por carácter sin quedarse corto en la prueba: ',
  'áéíóú ñ ü € — signos que ocupan más de un byte y mueven los offsets.',
  '[/centre]',
  '',
  `${SECTION_PAD}`,
].join('\n')

/**
 * The same document under a Studio gradient layer.
 *
 * The second fixture was the first one after the visual builder had run over
 * it, so the two differed in exactly this: colour spans wrapped around
 * individual characters. Kept as a separate export because several suites parse
 * both and a difference between them is the point.
 */
export const REFERENCE_DOCUMENT_WITH_GRADIENT = [
  '[centre]',
  '[color=#e8b04b]p[/color][color=#e8ae4b]e[/color][color=#e7ad4b]r[/color]',
  '[color=#e7aa4b]f[/color][color=#e7a84b]i[/color][color=#e6a64b]l[/color]',
  '[/centre]',
  '',
  REFERENCE_DOCUMENT,
].join('\n')

/** The gradient stops the Studio layer tests colour with. */
export const REFERENCE_GRADIENT_COLORS =
  '#e8b04b,#e8ae4b,#e7ad4b,#e7aa4b,#e7a84b,#e6a64b,#e6a14c,#e59f4c,#e4994c,'
  + '#e3914c,#e28b4d,#e1854d,#e07c4d,#df754d,#de6f4e,#dd684e,#dc614e,#db5b4f,#da564f'

/** The Studio layer shape those suites feed to `processStudioAST`. */
export const REFERENCE_GRADIENT_LAYER = {
  id: 'grad',
  type: 'gradient',
  enabled: true,
  value: 100,
  properties: { color1: '#ff0000', color2: '#0000ff' },
  colors: REFERENCE_GRADIENT_COLORS,
  opacity: 1.0,
  easing: 'linear',
}
