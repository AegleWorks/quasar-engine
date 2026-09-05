import { describe, it, expect } from 'vitest'
import {
  toTokenResolver,
  resolveTokenValue,
  type DocumentTokens,
  type TokenSource,
} from '../Tokens'
import {
  sanitizeColor,
  sanitizeFontSize,
  sanitizeFontFamily,
} from '../Syntax/nodeAttr'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'
import { BBCodeExporter } from '../Visitors/BBCodeExporter'
import { SemanticAnalyzer } from '../Semantic/SemanticAnalyzer'

describe('Design Tokens Resolution', () => {
  const tokens: DocumentTokens = {
    palette: {
      accent: '#ff66aa',
      primary: '#0055ff',
      bareHex: '33cc66',
      invalidColor: 'alert(1)',
      $prefixed: '#123456',
    },
    variables: {
      accent: '#ignoredBecausePaletteWins',
      titleSize: '150',
      percentageSize: '200%',
      headerFont: 'Arial, sans-serif',
      quotedFont: '"Inter"',
      cardBg: '#222222',
    },
  }

  describe('TokenResolver utilities', () => {
    it('normalizes DocumentTokens with toTokenResolver', () => {
      const resolver = toTokenResolver(tokens)
      expect(resolver).toBeDefined()
      if (!resolver) return

      // Direct lookup
      expect(resolver('accent')).toBe('#ff66aa')
      // Lookup with leading $
      expect(resolver('$accent')).toBe('#ff66aa')
      // Lookup key that was defined with leading $ in source
      expect(resolver('prefixed')).toBe('#123456')
      expect(resolver('$prefixed')).toBe('#123456')
      // Fallback to variables
      expect(resolver('titleSize')).toBe('150')
      expect(resolver('$titleSize')).toBe('150')
      // Palette precedence over variables
      expect(resolver('accent')).toBe('#ff66aa')
      // Missing token
      expect(resolver('nonExistent')).toBeUndefined()
      expect(resolver('$nonExistent')).toBeUndefined()
    })

    it('passes through custom TokenResolverFn', () => {
      const customFn = (name: string) => (name === 'custom' ? '#445566' : undefined)
      const resolver = toTokenResolver(customFn)
      expect(resolver).toBe(customFn)
      expect(resolver?.('custom')).toBe('#445566')
      expect(resolver?.('other')).toBeUndefined()
    })

    it('returns undefined when source is undefined', () => {
      expect(toTokenResolver(undefined)).toBeUndefined()
    })

    it('resolves tokens via resolveTokenValue', () => {
      const resolver = toTokenResolver(tokens)
      // Val starting with $ and present in resolver
      expect(resolveTokenValue('$accent', resolver)).toBe('#ff66aa')
      expect(resolveTokenValue('$titleSize', resolver)).toBe('150')
      // Val starting with $ but not in resolver
      expect(resolveTokenValue('$unknown', resolver)).toBe('$unknown')
      // Val not starting with $
      expect(resolveTokenValue('#ff0000', resolver)).toBe('#ff0000')
      expect(resolveTokenValue('plain-text', resolver)).toBe('plain-text')
      // Without resolver
      expect(resolveTokenValue('$accent', undefined)).toBe('$accent')
    })
  })

  describe('Attribute Sanitization with Tokens', () => {
    const resolver = toTokenResolver(tokens)

    it('sanitizes colors with resolver', () => {
      // Resolves hex color
      expect(sanitizeColor('$accent', resolver)).toBe('#ff66aa')
      // Resolves bare hex and adds #
      expect(sanitizeColor('$bareHex', resolver)).toBe('#33cc66')
      // Resolves invalid color and rejects it safely
      expect(sanitizeColor('$invalidColor', resolver)).toBeNull()
      // Preserves normal colors
      expect(sanitizeColor('#ff0000', resolver)).toBe('#ff0000')
      expect(sanitizeColor('blue', resolver)).toBe('blue')
      // Unresolved token returns null (safe CSS)
      expect(sanitizeColor('$missingColor', resolver)).toBeNull()
      // Without resolver returns null for $token
      expect(sanitizeColor('$accent')).toBeNull()
    })

    it('sanitizes font sizes with resolver', () => {
      // Resolves numeric string
      expect(sanitizeFontSize('$titleSize', resolver)).toBe('150')
      // Resolves percentage string and strips trailing %
      expect(sanitizeFontSize('$percentageSize', resolver)).toBe('200')
      // Preserves normal size
      expect(sanitizeFontSize('120', resolver)).toBe('120')
      // Unresolved token returns null
      expect(sanitizeFontSize('$missingSize', resolver)).toBeNull()
      expect(sanitizeFontSize('$titleSize')).toBeNull()
    })

    it('sanitizes font family with resolver', () => {
      // Resolves font list
      expect(sanitizeFontFamily('$headerFont', resolver)).toBe('Arial, sans-serif')
      // Strips surrounding quotes
      expect(sanitizeFontFamily('$quotedFont', resolver)).toBe('Inter')
      // Preserves normal font
      expect(sanitizeFontFamily('Verdana', resolver)).toBe('Verdana')
      // Unresolved token returns null
      expect(sanitizeFontFamily('$missingFont', resolver)).toBeNull()
      expect(sanitizeFontFamily('$headerFont')).toBeNull()
    })
  })

  describe('HTMLRenderer Live Preview with Tokens', () => {
    it('renders [color=$accent]Texto[/color] as <span style="color:#ff66aa;">Texto</span>', () => {
      const doc = new BBCodeDocumentModel({
        source: '[color=$accent]Texto[/color]',
      })
      const renderer = new HTMLRenderer({ tokens })
      const html = renderer.render(doc.root!)
      const cleanHtml = html.replace(/ data-node-id="[^"]*"/g, '')

      expect(cleanHtml).toContain('<span style="color:#ff66aa;">Texto</span>')
    })

    it('renders [size=$titleSize] and [font=$headerFont] with resolved styles', () => {
      const doc = new BBCodeDocumentModel({
        source: '[size=$titleSize]Title[/size] [font=$headerFont]Header[/font]',
      })
      const renderer = new HTMLRenderer({ tokens })
      const html = renderer.render(doc.root!)
      const cleanHtml = html.replace(/ data-node-id="[^"]*"/g, '')

      expect(cleanHtml).toContain('<span style="font-size:150%;">Title</span>')
      expect(cleanHtml).toContain('<span style="font-family:Arial, sans-serif;">Header</span>')
    })

    it('renders containers and accents with resolved token colors', () => {
      const doc = new BBCodeDocumentModel({
        source: '[box=Section:$primary]Box content[/box][notice=$accent]Notice content[/notice]',
      })
      const renderer = new HTMLRenderer({ tokens, theme: 'lyne' })
      const html = renderer.render(doc.root!)

      expect(html).toContain('--box-accent:#0055ff')
      expect(html).toContain('border-left-color:#ff66aa')
    })

    it('safely handles undefined tokens in preview without styles', () => {
      const doc = new BBCodeDocumentModel({
        source: '[color=$undefinedColor]Unstyled[/color]',
      })
      const renderer = new HTMLRenderer({ tokens })
      const html = renderer.render(doc.root!)

      // Should not have style attribute with invalid or raw $undefinedColor
      expect(html).not.toContain('style="color:$undefinedColor;"')
      expect(html).toContain('Unstyled')
    })
  })

  describe('BBCodeExporter Token Resolution', () => {
    it('expands tokens when target is "osu"', () => {
      const doc = new BBCodeDocumentModel({
        source: '[color=$accent]Colored[/color] and [size=$titleSize]Sized[/size]',
      })
      const exporter = new BBCodeExporter(undefined, 'osu', { tokens })
      const exported = exporter.export(doc.root!)

      expect(exported).toBe('[color=#ff66aa]Colored[/color] and [size=150]Sized[/size]')
    })

    it('preserves $tokens as-is when target is "miliastry" for lossless round-trip', () => {
      const source = '[color=$accent]Colored[/color] and [font=$headerFont]Font[/font] and [size=$titleSize]Sized[/size]'
      const doc = new BBCodeDocumentModel({ source })
      const exporter = new BBCodeExporter(undefined, 'miliastry', { tokens })
      const exported = exporter.export(doc.root!)

      expect(exported).toBe(source)
    })

    it('preserves $tokens as-is when target is "lyne"', () => {
      const source = '[color=$accent]Colored[/color]'
      const doc = new BBCodeDocumentModel({ source })
      const exporter = new BBCodeExporter(undefined, 'lyne', { tokens })
      const exported = exporter.export(doc.root!)

      expect(exported).toBe(source)
    })

    it('expands tokens in miliastry target when resolveTokens is explicitly true', () => {
      const doc = new BBCodeDocumentModel({
        source: '[color=$accent]Colored[/color] and [font=$headerFont]Font[/font]',
      })
      const exporter = new BBCodeExporter(undefined, 'miliastry', { tokens, resolveTokens: true })
      const exported = exporter.export(doc.root!)

      expect(exported).toBe('[color=#ff66aa]Colored[/color] and [font=Arial, sans-serif]Font[/font]')
    })

    it('preserves tokens in osu target when resolveTokens is explicitly false', () => {
      const doc = new BBCodeDocumentModel({
        source: '[color=$accent]Colored[/color]',
      })
      const exporter = new BBCodeExporter(undefined, 'osu', { tokens, resolveTokens: false })
      const exported = exporter.export(doc.root!)

      expect(exported).toBe('[color=$accent]Colored[/color]')
    })

    it('supports overriding tokens and target via export() method', () => {
      const doc = new BBCodeDocumentModel({
        source: '[color=$primary]Text[/color]',
      })
      const exporter = new BBCodeExporter()

      // Default osu without tokens keeps $primary
      const exportedDefault = exporter.export(doc.root!, 'osu')
      expect(exportedDefault).toBe('[color=$primary]Text[/color]')

      // Override with tokens
      const exportedWithTokens = exporter.export(doc.root!, 'osu', { tokens })
      expect(exportedWithTokens).toBe('[color=#0055ff]Text[/color]')

      // Switch to miliastry
      const exportedMiliastry = exporter.export(doc.root!, 'miliastry')
      expect(exportedMiliastry).toBe('[color=$primary]Text[/color]')
    })

    it('handles unresolved tokens gracefully during export', () => {
      const doc = new BBCodeDocumentModel({
        source: '[color=$missingToken]Text[/color]',
      })
      const exporter = new BBCodeExporter(undefined, 'osu', { tokens })
      const exported = exporter.export(doc.root!)

      // Unresolved token should not crash or corrupt the output
      expect(exported).toBe('[color=$missingToken]Text[/color]')
    })
  })

  describe('SemanticAnalyzer Diagnostic for Undefined Tokens', () => {
    it('emits a warning diagnostic when a token is not defined in project tokens', () => {
      const doc = new BBCodeDocumentModel({
        source: '[color=$missingColor]Text[/color]',
      })
      const analyzer = new SemanticAnalyzer({ tokens })
      const result = analyzer.analyze(doc.root!, doc.source)

      const tokenDiags = result.diagnostics.items.filter(d => d.code === 'unresolved-token')
      expect(tokenDiags).toHaveLength(1)
      expect(tokenDiags[0].severity).toBe('warning')
      expect(tokenDiags[0].message).toBe('Design token "$missingColor" is not defined in project tokens')
      expect(tokenDiags[0].range).toEqual(doc.root!.children[0].range)
    })

    it('does NOT emit a diagnostic when tokens are defined', () => {
      const doc = new BBCodeDocumentModel({
        source: '[color=$accent]Good[/color] [size=$titleSize]Sized[/size]',
      })
      const analyzer = new SemanticAnalyzer({ tokens })
      const result = analyzer.analyze(doc.root!, doc.source)

      const tokenDiags = result.diagnostics.items.filter(d => d.code === 'unresolved-token')
      expect(tokenDiags).toHaveLength(0)
    })

    it('emits diagnostics only for the undefined tokens in mixed documents', () => {
      const doc = new BBCodeDocumentModel({
        source: '[color=$accent]Good[/color] [color=$missing]Bad[/color] [size=$titleSize]Good[/size] [font=$noSuchFont]Bad[/font]',
      })
      const analyzer = new SemanticAnalyzer({ tokens })
      const result = analyzer.analyze(doc.root!, doc.source)

      const tokenDiags = result.diagnostics.items.filter(d => d.code === 'unresolved-token')
      expect(tokenDiags).toHaveLength(2)
      expect(tokenDiags.map(d => d.message)).toEqual([
        'Design token "$missing" is not defined in project tokens',
        'Design token "$noSuchFont" is not defined in project tokens',
      ])
    })

    it('does NOT emit unresolved-token diagnostics when tokens option is not provided', () => {
      const doc = new BBCodeDocumentModel({
        source: '[color=$missingColor]Text[/color]',
      })
      const analyzer = new SemanticAnalyzer()
      const result = analyzer.analyze(doc.root!, doc.source)

      const tokenDiags = result.diagnostics.items.filter(d => d.code === 'unresolved-token')
      expect(tokenDiags).toHaveLength(0)
    })

    it('supports setting tokens dynamically via setter or setTokens', () => {
      const doc = new BBCodeDocumentModel({
        source: '[color=$dynamic]Hello[/color]',
      })
      const analyzer = new SemanticAnalyzer()
      analyzer.setTokens({ palette: { dynamic: '#112233' } })
      const result = analyzer.analyze(doc.root!, doc.source)

      const tokenDiags = result.diagnostics.items.filter(d => d.code === 'unresolved-token')
      expect(tokenDiags).toHaveLength(0)
    })
  })

  describe('Round-trip and Edge Cases', () => {
    it('preserves tokens through parse and miliastry export round-trip', () => {
      const original = '[color=$accent]Hello [b]Bold[/b][/color] [box=Title:$primary]Content[/box]'
      const doc = new BBCodeDocumentModel({ source: original })
      const exporter = new BBCodeExporter(undefined, 'miliastry', { tokens })
      const roundTrip = exporter.export(doc.root!)

      expect(roundTrip).toBe(original)
    })

    it('resolves tokens inside container color suffix when target is osu', () => {
      const doc = new BBCodeDocumentModel({
        source: '[box=Title:$primary]Content[/box]',
      })
      const exporter = new BBCodeExporter(undefined, 'osu', { tokens })
      const exported = exporter.export(doc.root!)

      expect(exported).toContain('[box=Title:#0055ff]')
    })

    it('handles function-based TokenSource across all components', () => {
      const tokenFn: TokenSource = (name: string) => {
        if (name === 'brand' || name === '$brand') return '#aabbcc'
        return undefined
      }

      // Preview
      const doc = new BBCodeDocumentModel({ source: '[color=$brand]Brand[/color]' })
      const renderer = new HTMLRenderer({ tokens: tokenFn })
      expect(renderer.render(doc.root!)).toContain('style="color:#aabbcc;"')

      // Export
      const exporter = new BBCodeExporter(undefined, 'osu', { tokens: tokenFn })
      expect(exporter.export(doc.root!)).toBe('[color=#aabbcc]Brand[/color]')

      // Semantic analysis
      const analyzer = new SemanticAnalyzer({ tokens: tokenFn })
      const res = analyzer.analyze(doc.root!, doc.source)
      expect(res.diagnostics.items.filter(d => d.code === 'unresolved-token')).toHaveLength(0)
    })

    it('expands text node variables and box titles when target is osu', () => {
      const doc = new BBCodeDocumentModel({
        source: 'Welcome $headerFont to [box=Section $titleSize:$primary]Hello $accent![/box]',
      })
      const exporter = new BBCodeExporter(undefined, 'osu', { tokens })
      const exported = exporter.export(doc.root!)

      expect(exported).toBe(
        'Welcome Arial, sans-serif to [box=Section 150:#0055ff]Hello #ff66aa![/box]'
      )
    })

    it('preserves text node variables when target is miliastry for round-trip', () => {
      const original = 'Welcome $headerFont to [box=Section $titleSize:$primary]Hello $accent![/box]'
      const doc = new BBCodeDocumentModel({ source: original })
      const exporter = new BBCodeExporter(undefined, 'miliastry', { tokens })
      const exported = exporter.export(doc.root!)

      expect(exported).toBe(original)
    })

    it('renders text node variables in HTMLRenderer live preview', () => {
      const doc = new BBCodeDocumentModel({
        source: 'Welcome $headerFont!',
      })
      const renderer = new HTMLRenderer({ tokens })
      const html = renderer.render(doc.root!)

      expect(html).toContain('Welcome Arial, sans-serif!')
    })
  })
})
