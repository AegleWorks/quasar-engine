import { describe, it, expect } from 'vitest';
import { MilHibriDocumentModel } from '../MilHibri/MilHibriDocumentModel';
import { MarkdownDocumentModel } from '../Markdown/MarkdownDocumentModel';
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel';
import { HTMLRenderer } from '../Visitors/HTMLRenderer';
import { BBCodeExporter } from '../Visitors/BBCodeExporter';
import { MarkdownExporter } from '../Visitors/MarkdownExporter';

describe('MilHibri & Hybrid Markdown End-to-End Suite', () => {
  const htmlRenderer = new HTMLRenderer();
  const lyneHtmlRenderer = new HTMLRenderer({ dialect: 'lyne', theme: 'lyne' });
  const bbExporterOsu = new BBCodeExporter(undefined, 'osu');
  const bbExporterLyne = new BBCodeExporter(undefined, 'lyne');
  const mdExporter = new MarkdownExporter();

  describe('1. Full Lyne Cyberpunk Dialect in MilHibri', () => {
    it('parses and renders neon, shimmer, glitch, and custom color effects', () => {
      const source = `[centre]
[neon=#2EE6E2][size=160]⚡ NEURAL CORE ⚡[/size][/neon]
[wave][shimmer]SECTOR 09 INTERFACE[/shimmer][/wave]
[glitch]CRITICAL OVERRIDE[/glitch]
[/centre]`;

      const doc = MilHibriDocumentModel.fromSource(source);
      const html = lyneHtmlRenderer.render(doc.redRoot!);

      expect(html).toContain('bb-neon');
      expect(html).toContain('bb-shimmer');
      expect(html).toContain('bb-glitch');
      expect(html).toContain('⚡ NEURAL CORE ⚡');
      expect(html).toContain('SECTOR 09 INTERFACE');
      expect(html).toContain('CRITICAL OVERRIDE');

      const exportedBB = bbExporterLyne.export(doc.redRoot!);
      expect(exportedBB).toContain('[effect=neon:#2EE6E2]');
      expect(exportedBB).toContain('[effect=shimmer]');
      expect(exportedBB).toContain('[anim=glitch]');
    });

    it('parses and renders Lyne structural layout: columns, card, glass, neon-box', () => {
      const source = `[columns=2]
[card]
[b]CARD A[/b]
Content inside card A
[/card]
[glass]
[b]GLASS B[/b]
Content inside glass B
[/glass]
[/columns]

[neon-box=#2EE6E2]
[centre]Mainframe Active[/centre]
[/neon-box]`;

      const doc = MilHibriDocumentModel.fromSource(source);
      const html = lyneHtmlRenderer.render(doc.redRoot!);

      expect(html).toContain('bb-columns');
      expect(html).toContain('bb-card');
      expect(html).toContain('bb-glass');
      expect(html).toContain('bb-neon-box');
      expect(html).toContain('CARD A');
      expect(html).toContain('GLASS B');

      const bb = bbExporterLyne.export(doc.redRoot!);
      expect(bb).toContain('[columns=2]');
      expect(bb).toContain('[container=card]');
      expect(bb).toContain('[container=glass]');
      expect(bb).toContain('[container=neon-box:#2EE6E2]');
    });

    it('parses and renders Lyne data tables: [tables], [row], [th], [col]', () => {
      const source = `[tables=striped,borders]
[row][th]SERVICE[/th][th]STATUS[/th][/row]
[row][col]Gateway[/col][col][glow=#2EE6E2]ONLINE[/glow][/col][/row]
[row][col]Database[/col][col][fire]OVERHEATED[/fire][/col][/row]
[/tables]`;

      const doc = MilHibriDocumentModel.fromSource(source);
      const html = lyneHtmlRenderer.render(doc.redRoot!);

      expect(html).toContain('<table');
      expect(html).toContain('SERVICE');
      expect(html).toContain('ONLINE');
      expect(html).toContain('OVERHEATED');

      const bb = bbExporterLyne.export(doc.redRoot!);
      expect(bb).toContain('[tables=striped,borders]');
      expect(bb).toContain('[row]');
      expect(bb).toContain('[th]SERVICE[/th]');
    });
  });

  describe('2. Verbatim & Literal Content Matching osu! BBCode', () => {
    it('preserves code block and inline code content verbatim without tag execution', () => {
      const source = `[code]
[b]this is literal[/b]
*not markdown italic*
<div style="danger">raw</div>
[/code]

[c][color=#fff]not color[/color][/c]`;

      const doc = MilHibriDocumentModel.fromSource(source);
      const html = htmlRenderer.render(doc.redRoot!);

      expect(html).toContain('[b]this is literal[/b]');
      expect(html).toContain('*not markdown italic*');
      expect(html).toContain('[color=#fff]not color[/color]');
      expect(html).not.toContain('<strong>this is literal</strong>');

      const exportedBB = bbExporterOsu.export(doc.redRoot!);
      expect(exportedBB).toContain('[code][b]this is literal[/b]');
      expect(exportedBB).toContain('[c][color=#fff]not color[/color][/c]');
    });

    it('preserves [raw], [noparse], and [plain] verbatim behavior', () => {
      const source = `[raw][b]Keep Raw[/b] and **not bold**[/raw]
[noparse][i]Keep Noparse[/i][/noparse]`;

      const doc = MilHibriDocumentModel.fromSource(source);
      const html = lyneHtmlRenderer.render(doc.redRoot!);

      expect(html).toContain('bb-raw');
      expect(html).toContain('[b]Keep Raw[/b]');
      expect(html).toContain('[i]Keep Noparse[/i]');
    });
  });

  describe('3. Seamless Interoperability: Markdown + BBCode Hybrid Mix', () => {
    it('seamlessly mixes Markdown syntax with osu! and Lyne BBCode tags', () => {
      const source = `-> # Centered Heading <-

::: details Mission Briefing
- **Agent**: [profile]Aegis-7[/profile]
- ++Weapon++: [neon=#68FFF8]Plasma Blade[/neon]
- [u]Target[/u]: [map=10492]CHRONO DISRUPTOR[/map]
- Level: [size=140]16.5★[/size] {#ff0055}
:::

> **Commander wrote:**
> Initiate the sequence immediately.
`;

      const doc = MilHibriDocumentModel.fromSource(source);
      const html = lyneHtmlRenderer.render(doc.redRoot!);

      expect(html).toContain('Centered Heading');
      expect(html).toContain('Mission Briefing');
      expect(html).toContain('Commander wrote:');
      expect(html).toContain('Initiate the sequence immediately.');

      const bb = bbExporterLyne.export(doc.redRoot!);
      expect(bb).toContain('[centre]');
      expect(bb).toContain('[box=Mission Briefing]');
      expect(bb).toContain('[quote="Commander"]');

      const md = mdExporter.export(doc.redRoot!);
      expect(md).toContain('::: details Mission Briefing');
      expect(md).toContain('> **Commander**');
    });

    it('correctly disambiguates Markdown links from potential BBCode tags', () => {
      const source = `Click [Beatmap](https://osu.ppy.sh/b/123) or [Profile](https://osu.ppy.sh/u/456) now.`;
      const doc = MilHibriDocumentModel.fromSource(source);
      const html = htmlRenderer.render(doc.redRoot!);

      expect(html).toContain('href="https://osu.ppy.sh/b/123"');
      expect(html).toContain('href="https://osu.ppy.sh/u/456"');
      expect(html).toContain('>Beatmap<');
      expect(html).toContain('>Profile<');
    });
  });

  describe('4. Incremental Updates & Performance Benchmark', () => {
    it('applies fast incremental text updates without memory leaks or degradation', () => {
      const doc = MilHibriDocumentModel.fromSource('# Initial Document\n- Item 1\n- Item 2');
      expect(doc.redRoot?.childCount).toBe(2);

      const t0 = performance.now();
      for (let i = 0; i < 50; i++) {
        doc.applyTextUpdate(`# Document Mutation ${i}\n- Item 1\n- Item ${i}\n[neon=#2EE6E2]Active[/neon]`);
      }
      const duration = performance.now() - t0;
      expect(duration).toBeLessThan(500); // 50 full parses in < 500ms (< 10ms per parse)

      const finalHtml = lyneHtmlRenderer.render(doc.redRoot!);
      expect(finalHtml).toContain('Document Mutation 49');
      expect(finalHtml).toContain('Item 49');
      expect(finalHtml).toContain('Active');
    });
  });
});
