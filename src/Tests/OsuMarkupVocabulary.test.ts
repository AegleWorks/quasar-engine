import { describe, it, expect } from 'vitest'
import { BBCodeDocumentModel } from '../BBCode/BBCodeDocumentModel'
import { HTMLRenderer } from '../Visitors/HTMLRenderer'

/**
 * osu! estiliza box, spoilerbox, notice, imagemap, youtube, los alineados y
 * los perfiles POR NOMBRE DE CLASE. Inyectado en una userpage real, el HTML de
 * Quasar salía sin estilo porque emitía su propio vocabulario. Estas pruebas
 * fijan el vocabulario de osu bajo `dialect: 'osu'` — y, tan importante como
 * eso, que ningún otro dialecto se contagie.
 */
function render(source: string, dialect: 'osu' | 'miliastry' = 'osu'): string {
  const root = new BBCodeDocumentModel({ source }).redRoot!
  return new HTMLRenderer({ dialect }).render(root).replace(/ data-node-id="[^"]*"/g, '')
}

describe('osu markup vocabulary', () => {
  describe('[centre] / [left] / [right]', () => {
    it('usa la grafía británica en la clase de centrado', () => {
      expect(render('[centre]hi[/centre]')).toContain('<div class="bbcode__align-centre">')
    })

    it('cubre left y right con la misma familia de clases', () => {
      expect(render('[left]a[/left]')).toContain('<div class="bbcode__align-left">')
      expect(render('[right]a[/right]')).toContain('<div class="bbcode__align-right">')
    })

    it('no emite text-align inline bajo osu', () => {
      expect(render('[centre]hi[/centre]')).not.toContain('text-align')
    })
  })

  describe('[box] y [spoilerbox]', () => {
    it('emite la estructura completa de bbcode-spoilerbox', () => {
      const html = render('[box=Title]content[/box]')
      expect(html).toBe(
        '<div class="js-spoilerbox bbcode-spoilerbox">' +
        '<a class="js-spoilerbox__link bbcode-spoilerbox__link" href="#">' +
        '<span class="bbcode-spoilerbox__link-icon"></span>' +
        '<span class="bbcode-spoilerbox__link-text">Title</span></a>' +
        '<div class="js-spoilerbox__body bbcode-spoilerbox__body">content</div></div>',
      )
    })

    it('rotula SPOILER en mayúsculas cuando no hay título propio', () => {
      const html = render('[spoilerbox]hidden[/spoilerbox]')
      expect(html).toContain('<span class="bbcode-spoilerbox__link-text">SPOILER</span>')
      expect(html).not.toContain('Spoiler<')
    })

    it('deja el BBCode del título ya renderizado dentro del link-text', () => {
      const html = render('[box=[b]bold[/b] title]x[/box]')
      expect(html).toContain('<span class="bbcode-spoilerbox__link-text"><strong>bold</strong> title</span>')
    })

    it('recorta los saltos pegados a la apertura y al cierre del cuerpo', () => {
      const html = render('[box=T]\ninner\n[/box]')
      expect(html).toContain('bbcode-spoilerbox__body">inner</div>')
    })

    it('anida sin perder ninguna de las dos estructuras', () => {
      const html = render('[box=out]\n[box=in]\nC\n[/box]\nD\n[/box]')
      expect(html.match(/js-spoilerbox bbcode-spoilerbox/g)).toHaveLength(2)
      expect(html.match(/js-spoilerbox__body/g)).toHaveLength(2)
    })
  })

  describe('[notice]', () => {
    it('es un div .well a secas', () => {
      expect(render('[notice]\nThis is a notice\n[/notice]')).toBe('<div class="well">This is a notice</div>')
    })
  })

  describe('[imagemap]', () => {
    const source = [
      '[imagemap]',
      'https://assets.ppy.sh/x.jpg',
      '0 6.9 20 30 https://osu.ppy.sh link 1',
      '8 8 8 8 #',
      '9 9 9 9 # some title',
      '[/imagemap]',
    ].join('\n')

    it('usa el contenedor y la imagen perezosa de osu', () => {
      const html = render(source)
      expect(html).toContain('<div class="imagemap">')
      expect(html).toContain('<img class="imagemap__image" loading="lazy" src="https://assets.ppy.sh/x.jpg" alt="">')
      expect(html).not.toContain('imagemap-container')
    })

    it('emite un `a` por área, con las coordenadas en porcentaje', () => {
      expect(render(source)).toContain(
        '<a class="imagemap__link" href="https://osu.ppy.sh" style="left:0%;top:6.9%;width:20%;height:30%;" title="link 1"></a>',
      )
    })

    it('degrada un destino `#` a span, con la misma clase', () => {
      const html = render(source)
      expect(html).toContain('<span class="imagemap__link" style="left:8%;top:8%;width:8%;height:8%;" title=""></span>')
      expect(html).toContain('<span class="imagemap__link" style="left:9%;top:9%;width:9%;height:9%;" title="some title"></span>')
    })
  })

  describe('[youtube]', () => {
    it('pone las clases en el iframe mismo y `?rel=0` en el src', () => {
      const html = render('[youtube]https://youtu.be/YOeKD8ig3eM[/youtube]')
      expect(html).toContain('class="u-embed-wide u-embed-wide--bbcode"')
      expect(html).toContain('src="https://www.youtube.com/embed/YOeKD8ig3eM?rel=0"')
      expect(html).toContain('allowfullscreen')
      expect(html).not.toContain('bb-youtube')
    })
  })

  describe('[profile]', () => {
    it('es un `a.user-name.js-usercard`, sin `strong` alrededor', () => {
      const html = render('[profile]peppy[/profile]')
      expect(html).toContain('class="user-name js-usercard"')
      expect(html).not.toContain('<strong')
    })

    it('marca el id numérico tal cual cuando el tag lo trae', () => {
      const html = render('[profile=1]hello[/profile]')
      expect(html).toContain('data-user-id="1"')
      expect(html).toContain('href="https://osu.ppy.sh/users/1"')
    })

    it('cae a `@` + texto crudo, url-encoded, cuando no hay id', () => {
      const html = render('[profile]hello[/profile]')
      expect(html).toContain('data-user-id="@hello"')
      expect(html).toContain('href="https://osu.ppy.sh/users/%40hello"')
    })
  })

  describe('el dialecto por defecto no se contagia', () => {
    it('miliastry conserva `details` y `.notice`', () => {
      expect(render('[box=T]c[/box]', 'miliastry')).toContain('<details')
      expect(render('[box=T]c[/box]', 'miliastry')).not.toContain('bbcode-spoilerbox')
      expect(render('[notice]n[/notice]', 'miliastry')).toContain('class="notice"')
      expect(render('[notice]n[/notice]', 'miliastry')).not.toContain('class="well"')
    })

    it('miliastry conserva el resto del vocabulario propio', () => {
      expect(render('[centre]hi[/centre]', 'miliastry')).toContain('style="text-align:center;"')
      expect(render('[spoilerbox]x[/spoilerbox]', 'miliastry')).toContain('Spoiler')
      expect(render('[youtube]YOeKD8ig3eM[/youtube]', 'miliastry')).toContain('class="bb-youtube"')
      expect(render('[profile]peppy[/profile]', 'miliastry')).toContain('<strong')
      const imagemap = render('[imagemap]\nhttps://a.b/c.png\n0 0 5 5 https://x.y\n[/imagemap]', 'miliastry')
      expect(imagemap).toContain('imagemap-container')
      expect(imagemap).not.toContain('imagemap__image')
    })
  })
})
