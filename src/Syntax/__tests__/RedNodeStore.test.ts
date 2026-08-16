import { describe, it, expect } from 'vitest'
import { greenLeaf } from '../GreenNode'
import { RedNodeStore } from '../RedNodeStore'

/**
 * Forge a deterministic FNV-32 collision for a test green node.
 *
 * `GreenNode._hash` is a lazy getter over `_hashCache` (computed once, then
 * memoized). The store keys purely on `green._hash`, so forcing two
 * structurally DIFFERENT greens to the same cached hash is a faithful
 * simulation of a real 32-bit hash collision — the store cannot and should
 * not distinguish how the collision arose.
 */
function forceHash(green: ReturnType<typeof greenLeaf>, hash: number): void {
  ;(green as unknown as { _hashCache: number })._hashCache = hash
}

describe('RedNodeStore', () => {
  it('canonicalizes: same green reference reuses the same RedNode', () => {
    const store = new RedNodeStore()
    const green = greenLeaf('Text', 'hello')

    const first = store.getOrCreate(green)
    const second = store.getOrCreate(green)

    expect(second).toBe(first)
    expect(store.size).toBe(1)
    expect(store.stats.hits).toBe(1)
    expect(store.stats.misses).toBe(1)
    expect(store.stats.collisions).toBe(0)
  })

  it('treats a hash collision as neither a hit nor an overwrite', () => {
    const store = new RedNodeStore()

    // Two genuinely different structures that share a hash.
    const greenA = greenLeaf('Text', 'alpha')
    const greenB = greenLeaf('Text', 'bravo')
    expect(greenA).not.toBe(greenB)
    expect(greenA.text).not.toBe(greenB.text)

    const COLLISION_HASH = 0xdeadbeef
    forceHash(greenA, COLLISION_HASH)
    forceHash(greenB, COLLISION_HASH)
    expect(greenA._hash).toBe(greenB._hash)

    const canonicalA = store.getOrCreate(greenA)
    expect(store.stats.misses).toBe(1)

    // The colliding green must NOT be answered with A's canonical...
    const fromB = store.getOrCreate(greenB)
    expect(fromB).not.toBe(canonicalA)
    // ...and the returned node must wrap B, never A.
    expect(fromB.green).toBe(greenB)

    // The registered entry under the hash is still A — never overwritten.
    expect(store.getByHash(COLLISION_HASH.toString())).toBe(canonicalA)
    expect(store.stats.collisions).toBe(1)
    expect(store.size).toBe(1)

    // A still canonicalizes normally after the collision.
    expect(store.getOrCreate(greenA)).toBe(canonicalA)
    expect(store.stats.hits).toBe(1)
  })

  it('does not register the colliding green (no canonicalization for it)', () => {
    const store = new RedNodeStore()

    const greenA = greenLeaf('Tag', 'same-hash-a')
    const greenB = greenLeaf('Tag', 'same-hash-b')
    forceHash(greenA, 42)
    forceHash(greenB, 42)

    store.getOrCreate(greenA)
    const b1 = store.getOrCreate(greenB)
    const b2 = store.getOrCreate(greenB)

    // v1 semantic: a colliding subtree is rebuilt on each request rather than
    // risk returning the wrong canonical.
    expect(b1).not.toBe(b2)
    expect(b1.green).toBe(greenB)
    expect(b2.green).toBe(greenB)
    expect(store.stats.collisions).toBe(2)
    expect(store.size).toBe(1)
  })

  it('resets collision stats on clear', () => {
    const store = new RedNodeStore()
    const greenA = greenLeaf('Text', 'x')
    const greenB = greenLeaf('Text', 'y')
    forceHash(greenA, 7)
    forceHash(greenB, 7)

    store.getOrCreate(greenA)
    store.getOrCreate(greenB)
    expect(store.stats.collisions).toBe(1)

    store.clear()
    expect(store.size).toBe(0)
    expect(store.stats.hits).toBe(0)
    expect(store.stats.misses).toBe(0)
    expect(store.stats.collisions).toBe(0)
  })
})
