import { describe, it, expect } from 'vitest'
import { RedNode } from '../RedNode'
import { greenNode, greenLeaf } from '../GreenNode'

describe('RedNode', () => {
  it('creates a red node from a green node', () => {
    const green = greenLeaf('Text', 'hello')
    const red = new RedNode(green)

    expect(red.kind).toBe('Text')
    expect(red.text).toBe('hello')
    expect(red.version).toBe(1)
    expect(red.id).toBeDefined()
    expect(red.parent).toBeNull()
  })

  it('supports tree navigation', () => {
    const rootGreen = greenNode('Root', '')
    const childGreen = greenLeaf('Text', 'hello')
    
    const root = new RedNode(rootGreen)
    const child = new RedNode(childGreen)
    
    RedNode.allowMutation(() => {
      root.appendChild(child)
    })
    
    expect(child.parent).toBe(root)
    expect(root.childCount).toBe(1)
    expect(root.childAt(0)).toBe(child)
    expect(child.root).toBe(root)
    expect(child.depth).toBe(1)
    expect(root.depth).toBe(0)
  })

  it('supports mutation and bumps version', () => {
    const rootGreen = greenNode('Root', '')
    const childGreen = greenLeaf('Text', 'hello')
    
    const root = new RedNode(rootGreen)
    const child = new RedNode(childGreen)
    
    expect(root.version).toBe(1)
    
    RedNode.allowMutation(() => {
      root.appendChild(child)
    })
    expect(root.version).toBe(2)
    
    RedNode.allowMutation(() => {
      root.removeChild(child.id)
    })
    expect(root.version).toBe(3)
    expect(root.childCount).toBe(0)
    expect(child.parent).toBeNull()
  })

  it('throws an error if mutation methods are called without an active transaction or lock', () => {
    const rootGreen = greenNode('Root', '')
    const childGreen = greenLeaf('Text', 'hello')
    
    const root = new RedNode(rootGreen)
    const child = new RedNode(childGreen)
    
    expect(() => {
      root.appendChild(child)
    }).toThrow(/mutation boundary/)
    
    RedNode.allowMutation(() => {
      root.appendChild(child)
    })
    
    expect(() => {
      root.removeChild(child.id)
    }).toThrow(/mutation boundary/)
    
    expect(() => {
      root.bumpVersion()
    }).toThrow(/mutation boundary/)
  })
})
