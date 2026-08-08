import { describe, it, expect } from 'vitest'
import { TagRegistry } from '../Model/TagRegistry'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { processStudioAST } from '@miliastry/quasar-studio'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import fs from 'fs'

describe('URL IMG bug', () => {
  it('should render URL with IMG inside correctly', () => {
    const text = '[notice][centre][url=https://osekai.net/profiles?user=11624101][img]https://osekai.net/profiles/img/banner.svg?id=11624101[/img][/url][/centre][/notice]'

    const registry = new TagRegistry()
    const htmlRenderer = new HTMLRenderer({ registry })
    const exporter = new BBCodeExporter(registry)

    const { redRoot } = processStudioAST(text, [], {})
    const html = htmlRenderer.render(redRoot)
    const exported = exporter.export(redRoot)

    console.log('HTML:\n', html)
    console.log('Exported BBCode:\n', exported)
  })
})
