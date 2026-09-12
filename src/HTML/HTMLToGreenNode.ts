import { GreenNode, greenNode, greenLeaf } from '../Syntax/GreenNode';
import { RedNode } from '../Syntax/RedNode';
import type { NodeKind } from '../Types/core';
import { isBlockKind } from '../BBCode/BBCodeToGreenNode';

/**
 * The colour exactly as the author wrote it in the `style` attribute.
 *
 * `el.style.color` goes through CSSOM, which re-spells the value: `#FFE6F0`
 * comes back lowercased. Re-serialising a block then rewrote every hex in it,
 * a change the author never made.
 */
function rawStyleValue(el: HTMLElement, prop: string): string {
  const attr = el.getAttribute('style')
  if (!attr) return ''
  const match = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(attr)
  return match ? match[1].trim() : ''
}

function normalizeColorToHex(color: string): string {
  if (!color) return color;
  const trimmed = color.trim();
  // Se respeta la caja que escribió el autor: pasarlo a minúsculas convertía
  // `[color=#FF00AA]` en `[color=#ff00aa]` en cada ida y vuelta por el lienzo.
  if (trimmed.startsWith('#')) return trimmed;

  const rgbMatch = trimmed.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10).toString(16).padStart(2, '0');
    const g = parseInt(rgbMatch[2], 10).toString(16).padStart(2, '0');
    const b = parseInt(rgbMatch[3], 10).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`.toLowerCase();
  }

  return trimmed;
}

/**
 * `textContent`, except that a `<br>` reads back as the newline it was rendered
 * from. A multi-line box title is painted with `<br />`, which has no text of
 * its own, so plain `textContent` glued its lines together.
 */
function textWithLineBreaks(el: Element): string {
  let text = '';
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) text += child.nodeValue ?? '';
    else if (child.nodeName.toLowerCase() === 'br') text += '\n';
    else if (child.nodeType === 1) text += textWithLineBreaks(child as Element);
  }
  return text;
}

function domToGreenTree(root: HTMLElement): GreenNode {
  let currentOffset = 0;

  function convert(node: globalThis.Node): GreenNode {
    const start = currentOffset;
    const children: GreenNode[] = [];
    let kind: string = 'document';
    let text = '';
    
    if (node.nodeType === 3) { // Text Node
      text = node.nodeValue || '';
      
      // Convert pure whitespace text nodes into spacing/empty_line directly
      if (text.trim() === '') {
        const parentTag = node.parentNode ? node.parentNode.nodeName.toLowerCase() : '';
        if (['ul', 'ol', 'table', 'tbody', 'tr'].includes(parentTag)) {
          return [] as any; // Ignore structural whitespace
        }

        const newlines = (text.match(/\n/g) || []).length;
        if (newlines >= 2) {
          kind = 'empty_line';
          text = '\n\n';
          currentOffset += 2;
        } else if (newlines === 1) {
          kind = 'spacing';
          text = '\n';
          currentOffset += 1;
        } else {
          kind = 'text'; // Fallback for 0 newlines
        }
      } else {
        kind = 'text';
        currentOffset += text.length;
      }
    } else if (node.nodeType === 1) { // Element Node
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      
      switch (tag) {
        case 'b':
        case 'strong': {
          // El renderer envuelve las entidades en `<strong><a>`; sin mirar la
          // marca volvían desazucaradas como `[b][url=…]…[/url][/b]`.
          const entity = el.getAttribute('data-entity');
          if (entity === 'profile' || entity === 'guild' || entity === 'map') {
            kind = entity;
            const label = el.textContent || '';
            if (label) {
              children.push(greenLeaf('text', label));
              currentOffset += label.length;
            }
            // `[profile=5458323]ElMick33[/profile]` lleva el id en el atributo y
            // el nombre en el contenido; sin el primero volvía como `[profile]`.
            const valor = el.getAttribute('data-entity-value') || '';
            return greenNode(kind, valor ? `=${valor}` : '', children);
          }
          kind = 'bold';
          break;
        }
        case 'i':
        case 'em': kind = 'italic'; break;
        case 'u': kind = 'underline'; break;
        case 's':
        case 'strike':
        case 'del': kind = 'strikethrough'; break;
        case 'a': {
          const rawHref = el.getAttribute('href') || '';
          if (rawHref.startsWith('mailto:')) {
            // `[email]` guarda la dirección en el hijo de texto y sólo el prefijo
            // en el atributo; el exporter reconstruye el resto.
            kind = 'email';
            text = '=mailto:';
          } else {
            kind = 'url';
            text = `=${rawHref}`;
          }
          break;
        }
        case 'img': {
          // El parser de BBCode deja la URL en un hijo de texto y el modificador
          // en el atributo. Copiando esa forma el exporter la vuelve a emitir;
          // cuando la URL vivía sólo en `text` salía `[img][/img]`.
          kind = 'image';
          const imgAttr = el.getAttribute('data-img-attr') || '';
          text = imgAttr ? `=${imgAttr}` : '';
          const imgSrc = el.getAttribute('src') || '';
          if (imgSrc) {
            children.push(greenLeaf('text', imgSrc));
            currentOffset += imgSrc.length;
          }
          break;
        }
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          kind = 'heading';
          // Un `[heading]` pelado se pinta como h2 por convención del renderer;
          // devolverlo como `[heading=2]` reescribía el source del autor.
          text = el.hasAttribute('data-bare-level') ? '' : `=${parseInt(tag.charAt(1))}`;
          break;
        case 'font':
          if (el.getAttribute('color')) {
            kind = 'color';
            text = `=${normalizeColorToHex(el.getAttribute('color') || '')}`;
          } else if (el.getAttribute('size')) {
            kind = 'font_size';
            text = `=${el.getAttribute('size') || ''}`;
          } else {
            kind = 'group';
          }
          break;
        case 'br':
          kind = 'spacing'; 
          text = '\n';
          currentOffset += 1;
          break;
        case 'div':
        case 'p': {
          // Un aviso de medio vacío vuelve a ser su etiqueta, no la frase que
          // el renderer puso en su sitio. El atributo lleva el nombre BBCode;
          // aquí hace falta el `NodeKind`, que no siempre coincide.
          const vacio = el.getAttribute('data-bb-empty');
          if (vacio) {
            const KIND_DE_TAG: Record<string, string> = { img: 'image', youtube: 'video', imagemap: 'imagemap' };
            return greenNode(KIND_DE_TAG[vacio] ?? vacio, '', []);
          }
          if (el.classList.contains('notice')) kind = 'notice';
          else if (el.classList.contains('bb-empty-line') || el.classList.contains('bbcode-para')) {
            const hasText = (el.textContent || '').replace(/\u200B/g, '').trim().length > 0;
            kind = hasText ? 'paragraph' : 'empty_line';
          }
          else if (el.classList.contains('bbcode-sp')) kind = 'spacing';
          else if (el.classList.contains('bbcode-imagemap') || el.classList.contains('imagemap-container')) {
            kind = 'imagemap';
            const img = el.querySelector('img');
            if (img) children.push(greenLeaf('text', img.getAttribute('src') || ''));
            children.push(greenLeaf('spacing', ''));
            
            const areas = el.querySelectorAll('.bbcode-imap-area, .imagemap-area');
            areas.forEach((a, idx) => {
               const href = a.getAttribute('href') || '';
               const title = a.getAttribute('title') || '';
               const style = (a as HTMLElement).style;
               const x = parseFloat(style.left || '0');
               const y = parseFloat(style.top || '0');
               const w = parseFloat(style.width || '0');
               const h = parseFloat(style.height || '0');
               
               const line = `${x} ${y} ${w} ${h} ${href} ${title}`.trim();
               children.push(greenLeaf('text', line));
               if (idx < areas.length - 1) {
                 children.push(greenLeaf('spacing', ''));
               }
            });
          }
          else if (el.classList.contains('lx-audio')) {
            kind = 'audio';
            const audioSrc = el.getAttribute('data-src') || el.querySelector('audio')?.getAttribute('src') || '';
            if (audioSrc) {
              children.push(greenLeaf('text', audioSrc));
              currentOffset += audioSrc.length;
            }
          }
          else if (el.style.textAlign === 'center') kind = 'center';
          else if (el.style.textAlign === 'right') kind = 'right';
          else if (el.style.textAlign === 'left') kind = 'left';
          else kind = 'group';
          break;
        }
        case 'span':
          if (el.classList.contains('bb-empty-line')) {
            const hasText = (el.textContent || '').replace(/\u200B/g, '').trim().length > 0;
            kind = hasText ? 'paragraph' : 'empty_line';
          }
          else if (el.classList.contains('spoiler')) kind = 'spoiler';
          else if (el.classList.contains('aesthetic')) kind = 'aesthetic';
          else if (el.style.color) { kind = 'color'; text = `=${normalizeColorToHex(rawStyleValue(el, 'color') || el.style.color)}`; }
          else if (el.style.fontSize) { kind = 'font_size'; text = `=${(rawStyleValue(el, 'font-size') || el.style.fontSize).replace('%', '')}`; }
          else if (el.classList.contains('bb-text') || el.classList.contains('bb-paragraph')) {
            kind = 'bb_text_wrapper'; 
          }
          else kind = 'group';
          break;
        case 'iframe':
          if (el.classList.contains('bb-youtube') || el.hasAttribute('data-youtube')) {
            // El parser produce `video`, no `youtube`, y con el id en un hijo de
            // texto. Emitir otra forma hacía que el exporter no encontrara el tag.
            kind = 'video';
            const videoId = el.getAttribute('data-youtube')
              || (el as HTMLIFrameElement).src.split('/embed/')[1]?.split('?')[0]
              || '';
            if (videoId) {
              children.push(greenLeaf('text', videoId));
              currentOffset += videoId.length;
            }
          } else {
            kind = 'group';
          }
          break;
        case 'audio': {
          kind = 'audio';
          const audioSrc = el.getAttribute('src') || '';
          if (audioSrc) {
            children.push(greenLeaf('text', audioSrc));
            currentOffset += audioSrc.length;
          }
          break;
        }
        case 'details': {
          kind = el.classList.contains('box') ? 'box' : 'spoilerbox';
          // `data-bare-title` dice que el texto del summary lo puso el renderer.
          // Leerlo como título del autor devolvía `[box=Box]` desde un `[box]`.
          if (!el.hasAttribute('data-bare-title')) {
            const summary = el.querySelector('summary');
            if (summary) text = `=${textWithLineBreaks(summary)}`;
          }
          break;
        }
        case 'section':
          kind = 'group';
          break;
        case 'ul':
        case 'ol':
          kind = 'list';
          text = tag === 'ol' ? '=1' : '';
          break;
        case 'li':
          kind = 'list_item';
          break;
        case 'blockquote':
          kind = 'quote';
          const firstElem = el.firstElementChild as HTMLElement;
          if (firstElem && firstElem.tagName.toLowerCase() === 'div') {
            const strong = firstElem.querySelector('strong');
            if (strong && strong.textContent && strong.textContent.endsWith(' wrote:')) {
              const author = strong.textContent.slice(0, -7);
              // Clave `source`: es la que lee `BBCodeExporter.getTagAttributes`,
              // que además vuelve a poner las comillas de `[quote="Nombre Largo"]`.
              text = `=${author}`;
              (firstElem as any).__quasar_extracted = true;
            }
          }
          break;
        case 'pre':
          kind = 'code';
          // Extract raw text as a child text node (DocumentEngine expects code content in children)
          let codeText = el.textContent || '';
          const padAttr = el.getAttribute('data-code-pad');
          if (padAttr) {
            try {
              const [lead, trail] = (JSON.parse(padAttr) as string).split('\u0000');
              codeText = `${lead}${codeText}${trail}`;
            } catch {
              // Atributo corrupto: mejor el contenido pelado que perder el bloque.
            }
          }
          children.push(greenLeaf('text', codeText));
          currentOffset += codeText.length;
          break;
        case 'code':
          kind = el.classList.contains('inline') ? 'inline_code' : 'group';
          break;
        default:
          kind = 'group';
          break;
      }

      // Convert children recursively unless it's a raw block like pre or imagemap
      if (tag !== 'pre' && !(tag === 'div' && (el.classList.contains('bbcode-imagemap') || el.classList.contains('imagemap-container')))) {
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];
          if ((child as any).__quasar_extracted) continue;
          // Skip summary if we already extracted it for details
          if (tag === 'details' && child.nodeName.toLowerCase() === 'summary') continue;
          const parsedChild = convert(child);
          if (Array.isArray(parsedChild)) {
             children.push(...parsedChild);
          } else {
             children.push(parsedChild);
          }
        }
      }
    }

    const end = currentOffset;
    if (kind === 'bb_text_wrapper') {
       // Just return the children array to be flattened by the parent
       return children as any; 
    }
    return greenNode(kind as string, text, children);
  }

  const rootChildren: GreenNode[] = [];
  for (let i = 0; i < root.childNodes.length; i++) {
    const parsed = convert(root.childNodes[i]);
    if (Array.isArray(parsed)) {
      rootChildren.push(...parsed);
    } else {
      rootChildren.push(parsed);
    }
  }

  // Normalize root inline nodes into paragraphs to match BBCode Parser behavior
  const normalizedRoot: GreenNode[] = [];
  let currentParagraph: GreenNode[] = [];

  /**
   * Separa dos nodos de raíz con un solo salto.
   *
   * Nunca inventa una línea en blanco: una línea vacía del documento sólo
   * existe si el autor la escribió, y el lienzo no puede añadir ninguna por su
   * cuenta al traducir de vuelta.
   */
  const pushSeparator = () => {
    if (normalizedRoot.length === 0) return;
    const prev = normalizedRoot[normalizedRoot.length - 1];
    if (prev.kind === 'empty_line' || prev.kind === 'spacing') return;
    normalizedRoot.push(greenLeaf('spacing', '\n'));
  };

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      pushSeparator();
      normalizedRoot.push(greenNode('paragraph', '', currentParagraph));
      currentParagraph = [];
    }
  };

  for (const child of rootChildren) {
    if (child.kind === 'text' && child.text.trim() === '') {
      // Un espacio suelto entre dos tags inline (`[s]a[/s] [spoiler]b[/spoiler]`)
      // es contenido del autor y se conserva; el resto es sangría del HTML.
      const isInlineGap = !child.text.includes('\n') && currentParagraph.length > 0;
      if (!isInlineGap) continue;
      currentParagraph.push(child);
      continue;
    }

    if (isBlockKind(child.kind as NodeKind) || child.kind === 'empty_line' || child.kind === 'paragraph') {
      flushParagraph();
      if (child.kind !== 'empty_line' && child.kind !== 'spacing') {
        pushSeparator();
      }
      normalizedRoot.push(child);
    } else {
      currentParagraph.push(child);
    }
  }
  flushParagraph();

  return greenNode('document', '', normalizedRoot);
}

export function htmlStringToGreenTree(html: string): GreenNode {
  if (typeof DOMParser === 'undefined') {
    // If run on server, just wrap as text (or we could use a server-side DOM lib)
    return greenLeaf('text', html);
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  return domToGreenTree(doc.body);
}

export function greenToRedNode(green: GreenNode, parent?: RedNode | null): RedNode {
  // Extract metadata based on HTML tag footprints
  let metadata: Record<string, unknown> = {};
  if (green.kind === 'heading' && green.text.startsWith('=')) {
    metadata = { level: parseInt(green.text.slice(1)) || 1 };
  } else if ((green.kind === 'url' || green.kind === 'email') && green.text.startsWith('=')) {
    metadata = { href: green.text.slice(1) };
  } else if (green.kind === 'color' && green.text.startsWith('=')) {
    metadata = { color: green.text.slice(1) };
  } else if (green.kind === 'font_size' && green.text.startsWith('=')) {
    metadata = { size: green.text.slice(1) };
  } else if (green.kind === 'quote' && green.text.startsWith('=')) {
    metadata = { source: green.text.slice(1) };
  } else if ((green.kind === 'box' || green.kind === 'spoilerbox') && green.text.startsWith('=')) {
    metadata = { title: green.text.slice(1) };
  } else if (green.kind === 'image') {
    const src = green.children.map(c => (c as GreenNode).text || '').join('');
    metadata = green.text.startsWith('=')
      ? { src, imgAttr: green.text.slice(1) }
      : { src };
  } else if (green.kind === 'video' || green.kind === 'audio') {
    const value = green.children.map(c => (c as GreenNode).text || '').join('');
    metadata = green.kind === 'video' ? { videoId: value } : { src: value };
  } else if (green.kind === 'profile' || green.kind === 'guild' || green.kind === 'map') {
    const key = green.kind === 'profile' ? 'username' : green.kind === 'guild' ? 'tag' : 'id';
    metadata = { [key]: green.text.startsWith('=') ? green.text.slice(1) : '' };
  } else if (green.kind === 'list') {
    metadata = { ordered: green.text === '=1' };
  }

  const red = new RedNode(green, {
    parent: parent ?? null,
    kind: (green.kind as NodeKind) || 'text',
    metadata
  });

  const greenChildren = green.children as GreenNode[];
  if (greenChildren.length > 0) {
    const kids: RedNode[] = new Array(greenChildren.length);
    for (let i = 0; i < greenChildren.length; i++) {
      kids[i] = greenToRedNode(greenChildren[i], red);
    }
    red.initChildren(kids);
  }

  return red;
}
