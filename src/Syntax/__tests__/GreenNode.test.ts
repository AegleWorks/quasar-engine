import { describe, it, expect } from 'vitest'
import { greenNode, greenLeaf } from '../GreenNode'

describe('GreenNode', () => {
  it('creates a green node with correct properties', () => {
    const leaf1 = greenLeaf('Text', 'hello ')
    const leaf2 = greenLeaf('Text', 'world')
    const node = greenNode('Paragraph', '', [leaf1, leaf2])

    expect(node.kind).toBe('Paragraph')
    expect(node.text).toBe('')
    expect(node.width).toBe(11)
    expect(node.childCount).toBe(2)
    expect(node.isLeaf).toBe(false)
    
    expect(leaf1.isLeaf).toBe(true)
    expect(leaf1.text).toBe('hello ')
    expect(leaf1.width).toBe(6)
  })

  it('is immutable', () => {
    const leaf1 = greenLeaf('Text', 'hello')
    const leaf2 = greenLeaf('Text', 'world')
    const input = [leaf1]
    const node = greenNode('Paragraph', '', input)
    
    // Children should be a copy, not the same reference as input
    expect(node.children).not.toBe(input)
    // But should contain the same elements
    expect(node.children.length).toBe(1)
    expect(node.children[0]).toBe(leaf1)
  })
})
