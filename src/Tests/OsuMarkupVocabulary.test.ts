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

    it('un cuerpo que casi matchea se rechaza en tiempo lineal, sin backtracking', () => {
      // La forma de osu transcrita como UN RegExp — `\s*` anidado dentro del
      // `(?:…)+` de las líneas de área — es catastrófica en un cuerpo que
      // casi matchea: `osu/14880483` (doce mapas, varios inline) dejaba el
      // render colgado para siempre. Este cuerpo tiene 400 líneas de área
      // válidas y una sola línea inválida al final: la forma entera falla, y
      // puede fallar rápido.
      const lines = ['[imagemap]', 'https://assets.ppy.sh/x.jpg']
      for (let i = 0; i < 400; i++) lines.push(`${i}.5 ${i} ${i} ${i} # zone ${i}`)
      lines.push('not an area line')
      lines.push('[/imagemap]')
      const html = render(lines.join('\n'))
      expect(html).toContain('[imagemap]')
      expect(html).not.toContain('imagemap__image')
    })

    it('acepta líneas en blanco alrededor de la URL y entre las áreas (el `\s*` de osu las cruza)', () => {
      // Medido con el harness: `[imagemap]\n\nhttps://a.b/i.png\n\n0 0 10 10 https://x Tip\n\n[/imagemap]` genera el mapa igual.
      const html = render('[imagemap]\n\nhttps://assets.ppy.sh/x.jpg\n\n0 6.9 20 30 https://osu.ppy.sh link 1\n\n[/imagemap]')
      expect(html).toContain('<div class="imagemap">')
      expect(html).toContain('imagemap__link')
    })

    it('un closer con espacios delante sigue construyendo el mapa (el `\s*` de FromDB es ASCII)', () => {
      // Medido: `[imagemap]\nhttps://a.b/i.png\n0 0 10 10 https://x Tip\n [/imagemap]`
      // publica el mapa igual. La página real que lo destapó: `osu/32162290`
      // (y `osu/15312830`), que se imprimían literales enteras.
      const html = render('[imagemap]\nhttps://assets.ppy.sh/x.jpg\n0 0 10 10 https://x Tip\n [/imagemap]')
      expect(html).toContain('<div class="imagemap">')
      expect(html).toContain('imagemap__link')
      expect(html).not.toContain('[imagemap]')
    })

    it('un closer pegado a la última área deja todo literal (la línea de área exige su `\n`)', () => {
      // Medido: `...0 0 10 10 # Tip[/imagemap]` sale como texto tal cual.
      const html = render('[imagemap]\nhttps://assets.ppy.sh/x.jpg\n0 0 10 10 # Tip[/imagemap]')
      expect(html).toContain('[imagemap]')
      expect(html).not.toContain('imagemap__image')
    })
  })

  describe('[list]', () => {
    /**
     * El caso curado `osu-cases/list-items-in-box.bbcode`: la lista no tiene
     * ítems propios (el box ocupa toda su zona de título), así que el paso de
     * lista de osu! abre el `<ol>` en el primer `<li>` — dentro del cuerpo del
     * box — y ahí los ítems son bloques. Pintados como texto suelto el lector
     * veía `ab` corrido, sin viñeta y sin salto.
     */
    const swallowed = '[list]\n[box=gd]\n[*]a\n[*]b\n[/box]\n[/list]'

    it('un ítem que se tragó un [box] sigue siendo un bloque, dentro del <ol> que osu! le abre', () => {
      const html = render(swallowed)
      expect(html).toMatch(/<ol class="unordered"><li>a/)
      expect(html).toMatch(/<ol class="unordered"><li>b/)
      expect(html).not.toContain('>ab<')
    })

    it('ese <ol> va pelado cuando la lista es ordenada — osu! escribe la clase en una sola de las dos reglas', () => {
      // Medido con el harness: `[list=1]` + ítems tragados publica
      // `<ol><li>a</li>…`, no `<ol class="unordered">`. Cualquier `[list=…]`
      // es la grafía ordenada; la clase vive en la regla del `[list]` pelado.
      const html = render('[list=1]\n[box=gd]\n[*]a\n[/box]\n[/list]')
      expect(html).toMatch(/<ol><li>a/)
      expect(html).not.toMatch(/<ol class="unordered"><li>a/)
    })

    it('sin [list] arriba no hay bloque que abrir: el <li> huérfano lo desenvuelve el purificador', () => {
      // Medido: `[box=solo]…[*]g…[/box]` publica `g` a secas (corrido con lo
      // que tenga al lado) y `sin lista: [*]h` publica `sin lista:h`.
      expect(render('[box=solo]\n[*]g\n[/box]')).not.toContain('<li>')
      expect(render('sin lista: [*]h')).not.toContain('<li>')
    })

    /** El salto que el preview marca para el editor; no es parte de la forma. */
    const shape = (html: string) => html.replace(/<span data-bb-nl hidden><\/span>/g, '')

    it('los ítems que siguen a un [box] vuelven a la lista; el box se queda sin ellos', () => {
      // Medido con el harness (`osu-cases/list-items-after-box`, `osu/11231432`):
      // `[list][*]a[box=x][*]b[*]c[/box][/list]` publica UN `<ol>` con
      // `<li>a…box SIN cuerpo</li><li>b</li><li>c</li>` — los tres hermanos.
      // El `<li>` de osu! se emite donde caiga el texto y el purificador lo saca
      // del bloque; pintarlos dentro del box los dejaba sin la viñeta y pegados.
      const html = shape(render('[list]\n[*]a\n[box=x]\n[*]b\n[*]c\n[/box]\n[/list]'))
      expect(html.match(/<(ol|ul)\b/g)).toHaveLength(1)
      expect(html).toMatch(/<li>a[\s\S]*?bbcode-spoilerbox__body"><\/div><\/div><\/li><li>b<\/li><li>c<\/li><\/ul>/)
    })

    it('el mismo rescate en una lista ordenada y en un notice', () => {
      const ordered = shape(render('[list=1]\n[*]a\n[box=x]\n[*]b\n[/box]\n[/list]'))
      expect(ordered.match(/<(ol|ul)\b/g)).toHaveLength(1)
      expect(ordered).toMatch(/<ol><li>a[\s\S]*?<\/li><li>b<\/li><\/ol>/)
      const notice = shape(render('[list]\n[*]a\n[notice]\n[*]b\n[/notice]\n[/list]'))
      expect(notice).toMatch(/<li>a[\s\S]*?<div class="well"><\/div><\/li><li>b<\/li><\/ul>/)
    })

    it('una [list] anidada corta el título: los ítems salen en la lista, no dentro del <li> del título', () => {
      // Medido con el harness (`osu-cases/list-title-nested`, d4/d6/d10/d11):
      // `[list]title[list][*]x[*]y[/list][/list]` publica el título con el texto
      // y SIN lista dentro + `<ol><li>x</li><li>y</li></ol>` con la clase de la
      // lista exterior. El `(.+?)` del paso de título termina en el primer
      // `<li>`, que es el de la anidada.
      const html = shape(render('[list]\ntitle\n[list]\n[*]x\n[*]y\n[/list]\n[/list]'))
      expect(html).toMatch(/<ul class="bbcode__list-title"><li>(<br>)?title(<br>)?<\/li><\/ul><ul><li>x<\/li><li>y<\/li><\/ul>/)
    })

    it('lo que la lista exterior deja después de la anidada se publica fuera de la lista', () => {
      // Medido (d8): `[list][list][*]x[/list][*]y[/list]` publica `y` como texto
      // suelto, fuera del `<ol>` — el cierre de la anidada ya cerró la lista.
      const html = shape(render('[list][list]\n[*]x\n[/list]\n[*]y\n[/list]'))
      expect(html).toMatch(/<\/ul><ul><li>x<\/li><\/ul>y$/)
    })

    it('la [list] anidada no pierde lo suyo: el rescate es de la lista exterior', () => {
      // osu! publica todo junto en el `<ol>` de fuera: `<ol><li>a` + `<ol><li>b`.
      const html = shape(render('[list]\n[*]a\n[list]\n[*]b\n[/list]\n[/list]'))
      expect(html).toMatch(/<ul><li>a<br><ul><li>b<\/li><\/ul><\/li><\/ul>/)
    })

    it('el dialecto por defecto no se contagia: miliastry sigue pintando el ítem como siempre', () => {
      const html = render(swallowed, 'miliastry')
      expect(html).toContain('<li>a')
      expect(html).not.toContain('class="unordered"')
      expect(html).not.toContain('bbcode__list-title')
    })

    describe('dentro de un formato sellado', () => {
      // Medido con el harness: dentro de `[b]`, `[i]` o `[u]` osu! no abre
      // lista — publica el contenido de los ítems corrido, sin `<ol>`, sin
      // `<li>` y sin `<br>` entre uno y otro (`[b][list][*]a[*]b[/list][/b]`
      // → `<strong></strong><strong>ab</strong>`). El texto de título se
      // queda con sus saltos internos; el que va contra el primer `[*]` se
      // lo come el propio `[*]`.
      it('un [list] bajo [b] sale como texto corrido, sin <ol> ni <li>', () => {
        const html = shape(render('[b][list][*]a[*]b[/list][/b]'))
        expect(html).toContain('<strong>ab</strong>')
        expect(html).not.toContain('<li')
        expect(html).not.toContain('<ul')
      })

      it('igual bajo [i] y bajo [u]', () => {
        const italic = shape(render('[i][list][*]a[*]b[/list][/i]'))
        expect(italic).toContain('<em>ab</em>')
        expect(italic).not.toContain('<li')
        const underline = shape(render('[u][list][*]a[*]b[/list][/u]'))
        expect(underline).toContain('<u>ab</u>')
        expect(underline).not.toContain('<li')
      })

      it('[s] NO aplana: la lista se publica entera dentro del <del>', () => {
        // Medido: `[s][list][*]a[*]b[/list][/s]` →
        // `<del><ol class="unordered"><li>a</li><li>b</li></ol></del>`.
        const html = render('[s][list][*]a[*]b[/list][/s]')
        expect(html).toContain('<li>a</li>')
        expect(html).toContain('<li>b</li>')
      })

      it('el formato puede estar fuera del bloque: [b][box] y [i][notice] tampoco abren lista', () => {
        const box = shape(render('[b][box=T][list]title\n[*]a[*]b[/list][/box][/b]'))
        expect(box).toContain('bbcode-spoilerbox')
        expect(box).toContain('titleab')
        expect(box).not.toContain('<li')
        expect(box).not.toContain('bbcode__list-title')
        const notice = shape(render('[i][notice]n[list][*]a[*]b[/list][/notice][/i]'))
        expect(notice).toContain('<div class="well">')
        expect(notice).toContain('well">n')
        expect(notice).toContain('<em>ab</em>')
        expect(notice).not.toContain('<li')
      })

      it('una lista anidada también se aplana, en su sitio', () => {
        const html = shape(render('[b][list][*]a[*][list][*]x[*]y[/list][/list][/b]'))
        expect(html).toContain('<strong>a</strong><strong>xy</strong>')
        expect(html).not.toContain('<li')
      })

      it('un espacio de texto al final del ítem se queda; el que va contra el siguiente [*] no', () => {
        // Medido: `[*]a [/b]` publica ese espacio en negrita (`<strong>a </strong>`),
        // mientras que `[*]a [*]b` publica `ab` — el `\s*` del `[*]` se come
        // el hueco de delante del marcador.
        expect(render('[b][list][*]a [/b][i]b[/i][/list][/b]')).toContain('<strong>a </strong>')
        expect(shape(render('[b][list][*]a [*]b[/list][/b]'))).toContain('<strong>ab</strong>')
      })
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
