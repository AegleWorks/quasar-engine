import { describe, expect, it } from 'vitest'
import { BBCodeDocumentModel, type RedNode } from '../index'
import {
  nodeAttrValue,
  sanitizeColor,
  sanitizeFontFamily,
  sanitizeFontSize,
} from '../Syntax/nodeAttr'

/**
 * La semántica de atributos, fijada.
 *
 * Era privada del `HTMLRenderer`, y por eso los presets del lienzo la
 * reinventaron mal: leían `node.text` en crudo, con el `=` pegado, así que
 * `[color=#ff0000]` producía `color: "=#ff0000"` — CSS inválido, ningún color.
 * Ahora hay un solo sitio donde vive, y esto es lo que promete.
 */

function parse(source: string): RedNode {
  return new BBCodeDocumentModel({ source }).redRoot!
}

/** El primer nodo del kind pedido, a cualquier profundidad. */
function firstOfKind(root: RedNode, kind: string): RedNode {
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()!
    if (node.kind === kind) return node
    stack.push(...node.children)
  }
  throw new Error(`no hay ningún ${kind}`)
}

describe('nodeAttrValue', () => {
  it('quita el `=` de delante', () => {
    const node = firstOfKind(parse('[color=#ff0000]x[/color]'), 'color')
    expect(nodeAttrValue(node, 'color')).toBe('#ff0000')
  })

  it('quita las comillas dobles envolventes', () => {
    const node = firstOfKind(parse('[quote="Ana Ruiz"]x[/quote]'), 'quote')
    expect(nodeAttrValue(node)).toBe('Ana Ruiz')
  })

  it('quita las comillas simples envolventes', () => {
    const node = firstOfKind(parse("[quote='Ana']x[/quote]"), 'quote')
    expect(nodeAttrValue(node)).toBe('Ana')
  })

  it('sin `=` devuelve el texto tal cual (contenido de media)', () => {
    const node = firstOfKind(parse('[img]https://a/b.png[/img]'), 'image')
    expect(nodeAttrValue(node)).toBe(node.text)
  })

  it('una etiqueta sin atributo da cadena vacía', () => {
    const node = firstOfKind(parse('[b]x[/b]'), 'bold')
    expect(nodeAttrValue(node, 'color')).toBe('')
  })

  it('la metadata gana sobre el texto del documento', () => {
    // Es lo que escribe el Inspector: la propiedad ya cambió aunque el source
    // todavía no se haya reescrito.
    const node = firstOfKind(parse('[color=#ff0000]x[/color]'), 'color')
    node.metadata.color = '#00ff00'
    expect(nodeAttrValue(node, 'color')).toBe('#00ff00')
  })

  it('una metadata vacía no tapa al texto', () => {
    const node = firstOfKind(parse('[color=#ff0000]x[/color]'), 'color')
    node.metadata.color = ''
    expect(nodeAttrValue(node, 'color')).toBe('#ff0000')
  })

  it('sin `key` no mira la metadata', () => {
    const node = firstOfKind(parse('[color=#ff0000]x[/color]'), 'color')
    node.metadata.color = '#00ff00'
    expect(nodeAttrValue(node)).toBe('#ff0000')
  })
})

describe('sanitizeColor', () => {
  it.each([
    ['#f00', '#f00'],
    ['#ff0000', '#ff0000'],
    ['#ff0000aa', '#ff0000aa'],
    ['red', 'red'],
    ['rgb(255, 0, 0)', 'rgb(255, 0, 0)'],
    ['  #f00  ', '#f00'],
  ])('acepta %s', (input, expected) => {
    expect(sanitizeColor(input)).toBe(expected)
  })

  it('completa el `#` de un hex desnudo', () => {
    expect(sanitizeColor('ff0000')).toBe('#ff0000')
    expect(sanitizeColor('f00')).toBe('#f00')
  })

  it.each([
    ['', 'vacío'],
    ['red;" onmouseover="alert(1)', 'inyección por cierre de atributo'],
    ['url(javascript:alert(1))', 'url()'],
    ['#12345', 'hex de longitud inválida'],
    ['expression(alert(1))', 'expression()'],
  ])('rechaza %s (%s)', (input) => {
    expect(sanitizeColor(input)).toBeNull()
  })
})

describe('sanitizeFontSize', () => {
  it.each(['100', '150', '80.5', '  120  '])('acepta %s', (input) => {
    expect(sanitizeFontSize(input)).toBe(input.trim())
  })

  it.each(['150px', '', '-10', 'abc', '99999'])('rechaza %s', (input) => {
    expect(sanitizeFontSize(input)).toBeNull()
  })
})

describe('sanitizeFontFamily', () => {
  it.each(['Arial', 'Comic Sans MS, cursive', 'my-font_2'])('acepta %s', (input) => {
    expect(sanitizeFontFamily(input)).toBe(input)
  })

  it.each(['"Arial"', 'Arial;color:red', ''])('rechaza %s', (input) => {
    expect(sanitizeFontFamily(input)).toBeNull()
  })
})
