import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'

describe('BBCodeExporter.export overrides apply to that call only', () => {
  it('a per-call target does not stick to the instance', () => {
    const model = new BBCodeDocumentModel({ source: '[gradient=#ff0000,#0000ff]ab[/gradient]' })
    const exporter = new BBCodeExporter(model.tagRegistry)
    const first = exporter.export(model.redRoot!)
    expect(exporter.export(model.redRoot!, 'miliastry')).not.toBe(first)
    expect(exporter.export(model.redRoot!)).toBe(first)
  })

  it('setTarget is still the persistent setter', () => {
    const model = new BBCodeDocumentModel({ source: '[gradient=#ff0000,#0000ff]ab[/gradient]' })
    const exporter = new BBCodeExporter(model.tagRegistry)
    const miliastry = exporter.export(model.redRoot!, 'miliastry')
    exporter.setTarget('miliastry')
    expect(exporter.export(model.redRoot!)).toBe(miliastry)
  })
})
