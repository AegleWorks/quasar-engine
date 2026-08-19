import { $getRoot, $isElementNode, $isTextNode, LexicalNode, ElementNode } from 'lexical'

function getBBCodeFormatOpen(format: number): string {
  let tags = ''
  if (format & 1) tags += '[b]'
  if (format & 2) tags += '[i]'
  if (format & 8) tags += '[u]'
  if (format & 4) tags += '[s]'
  if (format & 16) tags += '[code]'
  return tags
}

function getBBCodeFormatClose(format: number): string {
  let tags = ''
  if (format & 16) tags += '[/code]'
  if (format & 4) tags += '[/s]'
  if (format & 8) tags += '[/u]'
  if (format & 2) tags += '[/i]'
  if (format & 1) tags += '[/b]'
  return tags
}

export function $generateBBCodeFromLexical(): string {
  const root = $getRoot()
  let bbcode = ''

  function processTextNodes(nodes: LexicalNode[]) {
    // Coalesce adjacent text nodes with the EXACT same format and style
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if ($isTextNode(node)) {
        let format = node.getFormat()
        let style = node.getStyle()
        
        let text = node.getTextContent()
        
        // Look ahead to coalesce
        while (i + 1 < nodes.length) {
          const nextNode = nodes[i+1]
          if ($isTextNode(nextNode) && nextNode.getFormat() === format && nextNode.getStyle() === style) {
            text += nextNode.getTextContent()
            i++ // Skip the coalesced node
          } else {
            break
          }
        }

        bbcode += getBBCodeFormatOpen(format)
        const colorMatch = style.match(/color:\s*([^;]+)/)
        if (colorMatch) {
           bbcode += `[color=${colorMatch[1].trim()}]`
        }
        bbcode += text
        if (colorMatch) {
           bbcode += `[/color]`
        }
        bbcode += getBBCodeFormatClose(format)
      } else {
        traverse(node)
      }
    }
  }

  function traverse(node: LexicalNode) {
    if ($isElementNode(node)) {
      const type = node.getType()
      const isParagraph = type === 'paragraph'
      const isHeading = type === 'heading'
      const isQuote = type === 'quote'
      const isList = type === 'list'
      const isListItem = type === 'listitem'
      const isLink = type === 'link'

      if (isHeading) {
         const tag = (node as any).getTag?.() || 'h1'
         const level = tag.replace('h', '')
         bbcode += `[h${level}]`
      } else if (isQuote) {
         bbcode += `[quote]`
      } else if (isList) {
         const listType = (node as any).getListType?.() === 'number' ? '1' : ''
         bbcode += listType ? `[list=1]\n` : `[list]\n`
      } else if (isListItem) {
         bbcode += `[*] `
      } else if (isLink) {
         const url = (node as any).getURL?.() || ''
         bbcode += `[url=${url}]`
      }

      const children = node.getChildren()
      processTextNodes(children)

      if (isHeading) {
         const tag = (node as any).getTag?.() || 'h1'
         const level = tag.replace('h', '')
         bbcode += `[/h${level}]\n`
      } else if (isQuote) {
         bbcode += `[/quote]\n`
      } else if (isList) {
         bbcode += `[/list]\n`
      } else if (isListItem) {
         bbcode += `\n`
      } else if (isLink) {
         bbcode += `[/url]`
      } else if (isParagraph) {
         bbcode += `\n`
      }
    }
  }

  processTextNodes(root.getChildren())

  // Trim trailing extra newline added by the last paragraph
  return bbcode.replace(/\n$/, '')
}
