import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { firstDifference, phpTrim, previewHTML, unwrapOsuHtml, visibleLines } from './support/visibleLines'

/**
 * Quasar's osu! preview against what osu! actually publishes.
 *
 * `docs/ai/goldens/<gallery>/<page>.osu.html` is osu-web's own output for the matching
 * `docs/ai/<gallery>/<page>.bbcode`, produced by the Docker harness
 * (`~/Main Bridge/osu-harness/regenerate-goldens.sh`). The suite needs neither Docker nor the
 * harness, only those files, and skips wherever the corpus is absent.
 *
 * The two HTMLs are not compared as strings: the preview carries editor scaffolding
 * (`bb-paragraph`, `bb-empty-line`, hidden newline carriers) that osu! does not. Both are
 * reduced to what a reader sees: lines of text, each character with its inline style, under
 * the alignment/container it sits in. Line breaks follow CSS: `<br>` always ends a line, a
 * block boundary ends one only if it has content.
 *
 * Divergences are a ratchet, not a wish list: every page whose preview still differs from
 * osu! is named in `OsuGoldens.known.json`. A page that diverges and is not listed fails the
 * suite (a regression); a listed page that now matches also fails (shrink the list).
 * `UPDATE_OSU_GOLDEN_KNOWN=1` rewrites the list from the current results.
 */

const DOCS = join(__dirname, '../../../../docs/ai')
const KNOWN_FILE = join(__dirname, 'OsuGoldens.known.json')
const GALLERIES = ['gallery', 'gallery-osu', 'osu-cases']

// ── Corpus ─────────────────────────────────────────────────────────

interface Page { name: string; source: string; golden: string }

function pages(): Page[] {
  const out: Page[] = []
  for (const gallery of GALLERIES) {
    const dir = join(DOCS, gallery)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter(f => f.endsWith('.bbcode')).sort()) {
      const goldenPath = join(DOCS, 'goldens', gallery, file.replace(/\.bbcode$/, '.osu.html'))
      if (!existsSync(goldenPath)) continue
      out.push({
        name: `${gallery}/${file}`,
        source: phpTrim(readFileSync(join(dir, file), 'utf8')),
        golden: readFileSync(goldenPath, 'utf8'),
      })
    }
  }
  return out
}

const PAGES = pages()
const diffs = new Map<string, string>()
for (const p of PAGES) {
  const preview = visibleLines(previewHTML(p.source))
  const osu = visibleLines(unwrapOsuHtml(p.golden))
  if (preview.join('\n') !== osu.join('\n')) diffs.set(p.name, firstDifference(preview, osu))
}

if (process.env.UPDATE_OSU_GOLDEN_KNOWN === '1') {
  writeFileSync(KNOWN_FILE, JSON.stringify([...diffs.keys()], null, 2) + '\n')
}
// OSU_GOLDEN_DUMP=<file> writes the first difference of every diverging page, to see what is left.
if (process.env.OSU_GOLDEN_DUMP) {
  writeFileSync(process.env.OSU_GOLDEN_DUMP, [...diffs].map(([n, d]) => `## ${n}\n${d}`).join('\n\n') + '\n')
}
const known: string[] = existsSync(KNOWN_FILE) ? JSON.parse(readFileSync(KNOWN_FILE, 'utf8')) : []

describe.skipIf(PAGES.length === 0)('osu! goldens — the preview equals what osu! publishes', () => {
  it.each(PAGES.map(p => p.name))('%s', name => {
    const diff = diffs.get(name)
    if (diff && !known.includes(name)) expect.fail(`${name} no longer matches osu! at ${diff}`)
    if (!diff && known.includes(name)) expect.fail(`${name} now matches osu!; remove it from OsuGoldens.known.json`)
  })
})
