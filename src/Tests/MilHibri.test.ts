import { describe, it, expect } from 'vitest';
import { MilHibriDocumentModel } from '../MilHibri/MilHibriDocumentModel';
import { BBCodeExporter } from '../Visitors/BBCodeExporter';
import { MarkdownExporter } from '../Visitors/MarkdownExporter';
import { HTMLRenderer } from '../Visitors/HTMLRenderer';

describe('MilHibri Language — Unified Hybrid Engine', () => {
  const htmlRenderer = new HTMLRenderer({ osuBehaviour: false });
  const bbExporter = new BBCodeExporter(undefined, 'osu');
  const mdExporter = new MarkdownExporter();

  it('unifies BBCode tags and Markdown formatting seamlessly', () => {
    const source = `
# Encabezado Principal

[box=Sección MilHibri:#ff0055]
Este es un texto con [color=#00e5ff]**negrita y color**[/color] y ++subrayado++.
También soporta enlaces Markdown: [Beatmap de osu!](https://osu.ppy.sh/b/12345).

-> Texto Centrado con Flechas <-

[notice]
Aviso importante con **negrita** y \`código inline\`.
[/notice]
[/box]
`;

    const doc = MilHibriDocumentModel.fromSource(source);
    expect(doc.language).toBe('milhibri');

    const html = htmlRenderer.render(doc.redRoot!);
    expect(html).toContain('Encabezado Principal');
    expect(html).toContain('Sección MilHibri');
    expect(html).toContain('style="color:#00e5ff;"');
    expect(html).toMatch(/<strong[^>]*>negrita y color<\/strong>/);
    expect(html).toMatch(/<u[^>]*>subrayado<\/u>/);
    expect(html).toContain('style="text-align:center;"');
    expect(html).toContain('class="notice"');

    const bbcode = bbExporter.export(doc.redRoot!);
    expect(bbcode).toContain('[box=Sección MilHibri:#ff0055]');
    expect(bbcode).toContain('[color=#00e5ff][b]negrita y color[/b][/color]');
    expect(bbcode).toContain('[u]subrayado[/u]');
    expect(bbcode).toContain('[centre]Texto Centrado con Flechas[/centre]');
    expect(bbcode).toContain('[notice]');

    const markdown = mdExporter.export(doc.redRoot!);
    expect(markdown).toContain('# Encabezado Principal');
    expect(markdown).toContain('::: details Sección MilHibri');
    expect(markdown).toContain('-> Texto Centrado con Flechas <-');
    expect(markdown).toContain('++subrayado++');
  });

  it('supports quotes with author and code blocks in MilHibri', () => {
    const source = `
> **peppy**
> Welcome to osu! Visit \`https://osu.ppy.sh\`

\`\`\`ts
const mode = "milhibri";
console.log(mode);
\`\`\`
`;

    const doc = MilHibriDocumentModel.fromSource(source);
    const html = htmlRenderer.render(doc.redRoot!);
    expect(html).toContain('<strong>peppy wrote:</strong>');
    expect(html).toContain('<code>const mode = &quot;milhibri&quot;;\nconsole.log(mode);</code>');

    const bb = bbExporter.export(doc.redRoot!);
    expect(bb).toContain('[quote="peppy"]');
    expect(bb).toContain('[code]const mode = "milhibri";\nconsole.log(mode);[/code]');
  });
});
