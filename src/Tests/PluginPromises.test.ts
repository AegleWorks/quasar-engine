import { describe, it, expect, afterEach } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { PluginAPI } from '../Plugins/PluginAPI'

function api(): PluginAPI {
  return new PluginAPI(new BBCodeDocumentModel({ autoAnalyze: false }))
}

function stylesFor(name: string): HTMLStyleElement[] {
  return [...document.querySelectorAll<HTMLStyleElement>(`style[data-quasar-plugin="${name}"]`)]
}

afterEach(() => {
  for (const element of [...document.querySelectorAll('style[data-quasar-plugin]')]) {
    element.remove()
  }
})

describe('PluginAPI — dependencies', () => {
  it('refuses a plugin whose dependency is not registered', () => {
    expect(() =>
      api().registerPlugin({ name: 'fancy', version: '1', dependencies: ['base'] }, {}),
    ).toThrow(/requires "base"/)
  })

  it('accepts it once the dependency is registered first', () => {
    const plugins = api()
    plugins.registerPlugin({ name: 'base', version: '1' }, {})

    expect(() =>
      plugins.registerPlugin({ name: 'fancy', version: '1', dependencies: ['base'] }, {}),
    ).not.toThrow()
  })
})

describe('PluginAPI — styles', () => {
  it('injects one style element per declared stylesheet', () => {
    const plugins = api()
    plugins.registerPlugin(
      { name: 'styled', version: '1' },
      { styles: ['.styled { color: red; }', '.styled::after { content: "✓"; }'] },
    )

    expect(stylesFor('styled')).toHaveLength(2)
    expect(stylesFor('styled')[0].textContent).toContain('color: red')
  })

  it('removes exactly its own styles on unregister', () => {
    const plugins = api()
    plugins.registerPlugin({ name: 'a', version: '1' }, { styles: ['.a {}'] })
    plugins.registerPlugin({ name: 'b', version: '1' }, { styles: ['.b {}'] })

    plugins.unregisterPlugin('a')

    expect(stylesFor('a')).toHaveLength(0)
    expect(stylesFor('b')).toHaveLength(1)
  })

  it('replaces the old styles when a plugin is registered again', () => {
    const plugins = api()
    plugins.registerPlugin({ name: 'same', version: '1' }, { styles: ['.old {}'] })
    plugins.registerPlugin({ name: 'same', version: '2' }, { styles: ['.new {}'] })

    const styles = stylesFor('same')
    expect(styles).toHaveLength(1)
    expect(styles[0].textContent).toBe('.new {}')
  })
})
