import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import {
  RASTERIZABLE_TAGS,
  collectRasterNodes,
  hashRasterNode,
  describeRasterNode,
} from '../Raster/rasterTags'

describe('raster tags — osu!-native cards', () => {
  it('exposes five rasterizable tags', () => {
    expect([...RASTERIZABLE_TAGS]).toEqual(['profilecard', 'beatmap', 'progress', 'divider', 'score'])
  })

  it('parses, renders and round-trips each tag', () => {
    const sources = [
      '[profilecard user=hxovc rank=#12,345 pp=9,876 country=MX]hola[/profilecard]',
      '[beatmap artist=Camellia title=Ghost diff=Expert mapper=Pro sr=6.21 status=ranked][/beatmap]',
      '[progress=72 label="Level" level=102][/progress]',
      '[divider=Top Plays]',
      '[score grade=S artist=Camellia title=Ghost diff=Expert mapper=Pro mods=HDHR acc=98.5 combo=1234x/1500x pp=456]',
    ]
    for (const source of sources) {
      const model = new BBCodeDocumentModel({ source, autoAnalyze: false })
      expect(model.redRoot).toBeTruthy()
      const nodes = collectRasterNodes(model.redRoot!)
      expect(nodes).toHaveLength(1)
      const html = new HTMLRenderer({ dialect: 'miliastry' }).render(model.redRoot!)
      expect(html).toContain('bb-')
      const exported = new BBCodeExporter(model.tagRegistry, 'miliastry').export(model.redRoot!)
      expect(exported).toBe(source)
      expect(hashRasterNode(nodes[0], source)).toMatch(/^raster-/)
      expect(describeRasterNode(nodes[0]).length).toBeGreaterThan(0)
    }
  })

  it('degrades to plain content on osu target (safe fallback before raster)', () => {
    const model = new BBCodeDocumentModel({
      source: '[progress=72]texto[/progress]',
      autoAnalyze: false,
    })
    const exported = new BBCodeExporter(model.tagRegistry, 'osu').export(model.redRoot!)
    expect(exported).not.toContain('[progress')
    expect(exported).toContain('texto')
  })
})
