import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * Layering, enforced: what gets PUBLISHED never depends on how things LOOK.
 *
 * The exporter used to build whole `HTMLRenderer`s to ask them which newlines
 * osu! swallows, so a change to the preview could change an export (it did).
 * Those answers now come from `Semantic/osu/OsuSemanticModel`, and this test
 * keeps the edge from coming back — directly or through any chain of value
 * imports (`import type` is erased at build time and does not count).
 * See docs/10-Semantic-Model-Plan.md.
 */

const SRC = resolve(__dirname, '..')

function importGraph(): Map<string, string[]> {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'Tests' && entry.name !== '__tests__') walk(path)
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(path)
      }
    }
  }
  walk(SRC)
  const graph = new Map<string, string[]>()
  const IMPORT = /^\s*(?:import|export)\s+(type\s+)?[^'"]*?from\s+['"](\.[^'"]+)['"]/gm
  for (const file of files) {
    const targets: string[] = []
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      if (m[1]) continue
      const base = resolve(dirname(file), m[2])
      const hit = [`${base}.ts`, join(base, 'index.ts')].find(existsSync)
      if (hit) targets.push(hit)
    }
    graph.set(file, targets)
  }
  return graph
}

/** The import chain from `from` to `to`, or null when there is none. */
function chain(graph: Map<string, string[]>, from: string, to: string): string[] | null {
  const start = join(SRC, from)
  const goal = join(SRC, to)
  const previous = new Map<string, string | null>([[start, null]])
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (file === goal) {
      const path: string[] = []
      for (let at: string | null = goal; at !== null; at = previous.get(at) ?? null) path.unshift(relative(SRC, at))
      return path
    }
    for (const next of graph.get(file) ?? []) {
      if (!previous.has(next)) { previous.set(next, file); queue.push(next) }
    }
  }
  return null
}

describe('architecture — publishing never depends on presentation', () => {
  const graph = importGraph()

  it.each([
    'Visitors/BBCodeExporter.ts',
    'Edits/Rules/flattenOsuNesting.ts',
    'Semantic/osu/OsuSemanticModel.ts',
    'Semantic/osu/newlineRules.ts',
  ])('%s does not reach HTMLRenderer', (file) => {
    expect(chain(graph, file, 'Visitors/HTMLRenderer.ts')).toBeNull()
  })

  it('sees real edges (the check can fail)', () => {
    expect(chain(graph, 'Visitors/HTMLRenderer.ts', 'Semantic/osu/newlineRules.ts')).toEqual([
      'Visitors/HTMLRenderer.ts', 'Semantic/osu/OsuSemanticModel.ts', 'Semantic/osu/newlineRules.ts',
    ])
  })
})
