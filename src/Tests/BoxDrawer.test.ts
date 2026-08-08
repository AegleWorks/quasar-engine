import { describe, it, expect } from 'vitest'

import { bindBoxDrawer, toggleBoxWithDrawer } from '../Visuals/BoxDrawer'

/**
 * jsdom has neither layout nor the Web Animations API, so both are stubbed.
 *
 * The stub deliberately keeps `cancel()` from firing its event synchronously:
 * real animation events are dispatched on a later frame, and every bug this
 * suite covers comes from a superseded animation's event landing *after* the
 * next one has already taken over.
 */

const COLLAPSED = 40
const EXPANDED = 200

interface FakeAnimation {
  keyframes: { height: [string, string] }
  duration: number
  cancelled: boolean
  cancel: () => void
  addEventListener: (type: string, cb: () => void) => void
  fire: (type: 'finish' | 'cancel') => void
}

function makeBox() {
  const host = document.createElement('div')
  host.innerHTML = '<details><summary>title</summary><p>content</p></details>'
  const details = host.querySelector('details') as HTMLDetailsElement

  /** One-shot override standing in for the height a running animation paints. */
  let painted: number | null = null

  details.getBoundingClientRect = () => {
    if (painted !== null) {
      const height = painted
      painted = null
      return { height } as DOMRect
    }
    return { height: details.open ? EXPANDED : COLLAPSED } as DOMRect
  }

  const anims: FakeAnimation[] = []
  details.animate = ((keyframes: any, options: any) => {
    const listeners: Record<string, Array<() => void>> = {}
    const anim: FakeAnimation = {
      keyframes,
      duration: options.duration,
      cancelled: false,
      cancel: () => { anim.cancelled = true },
      addEventListener: (type, cb) => { (listeners[type] ||= []).push(cb) },
      fire: (type) => { (listeners[type] || []).forEach(cb => cb()) },
    }
    anims.push(anim)
    return anim as unknown as Animation
  }) as typeof details.animate

  return {
    host,
    details,
    anims,
    /** Simulate an interruption: the next height read reports mid-flight. */
    setPaintedHeight: (h: number) => { painted = h },
    /** Drive a toggle all the way to its resting state. */
    settle: () => anims[anims.length - 1].fire('finish'),
  }
}

describe('BoxDrawer', () => {
  it('opens from the collapsed height to the expanded one', () => {
    const box = makeBox()

    toggleBoxWithDrawer(box.details)

    expect(box.anims[0].keyframes.height).toEqual([`${COLLAPSED}px`, `${EXPANDED}px`])
    expect(box.details.style.overflow).toBe('hidden')
    // Stays open during the animation so the content is there to be uncovered.
    expect(box.details.open).toBe(true)

    box.settle()
    expect(box.details.open).toBe(true)
    expect(box.details.style.overflow).toBe('')
  })

  it('keeps the content mounted while closing, then closes at the end', () => {
    const box = makeBox()
    toggleBoxWithDrawer(box.details)
    box.settle()

    toggleBoxWithDrawer(box.details)

    expect(box.anims[1].keyframes.height).toEqual([`${EXPANDED}px`, `${COLLAPSED}px`])
    expect(box.details.open).toBe(true)

    box.settle()
    expect(box.details.open).toBe(false)
  })

  it('resumes from the painted height instead of snapping', () => {
    const box = makeBox()
    toggleBoxWithDrawer(box.details)

    box.setPaintedHeight(120)
    toggleBoxWithDrawer(box.details)

    expect(box.anims[0].cancelled).toBe(true)
    expect(box.anims[1].keyframes.height).toEqual(['120px', `${COLLAPSED}px`])
  })

  it('reverses a close back into an open', () => {
    const box = makeBox()
    toggleBoxWithDrawer(box.details)
    box.settle()

    toggleBoxWithDrawer(box.details) // closing
    box.setPaintedHeight(150)
    toggleBoxWithDrawer(box.details) // reversed mid-close

    // Direction comes from the running intent; reading `open` here would say
    // "open" — the box is held open while it closes — and close it again.
    expect(box.anims[2].keyframes.height).toEqual(['150px', `${EXPANDED}px`])

    box.settle()
    expect(box.details.open).toBe(true)
  })

  it('ignores a superseded animation\'s late cancel', () => {
    const box = makeBox()
    toggleBoxWithDrawer(box.details)
    box.setPaintedHeight(120)
    toggleBoxWithDrawer(box.details)

    box.anims[0].fire('cancel')

    // Without the ownership guard the outgoing animation strips the incoming
    // one's clipping and the content spills out of a small box.
    expect(box.details.style.overflow).toBe('hidden')
  })

  it('ignores a superseded animation\'s late finish', () => {
    const box = makeBox()
    toggleBoxWithDrawer(box.details)
    box.settle()

    toggleBoxWithDrawer(box.details) // closing
    box.setPaintedHeight(150)
    toggleBoxWithDrawer(box.details) // reversed to opening

    box.anims[1].fire('finish')

    // The close's `open = false` landing late would freeze the box shut.
    expect(box.details.open).toBe(true)
    expect(box.details.style.overflow).toBe('hidden')
  })

  it('scales the duration by the distance left to travel', () => {
    const box = makeBox()

    toggleBoxWithDrawer(box.details)
    expect(box.anims[0].duration).toBe(400)

    // Interrupted 10px above collapsed: a sliver of travel, floored so it still
    // reads as motion rather than a snap.
    box.setPaintedHeight(COLLAPSED + 10)
    toggleBoxWithDrawer(box.details)
    expect(box.anims[1].duration).toBe(120)
  })

  it('restores the author\'s overflow across a chain of interruptions', () => {
    const box = makeBox()
    box.details.style.overflow = 'auto'

    toggleBoxWithDrawer(box.details)
    box.setPaintedHeight(120)
    toggleBoxWithDrawer(box.details)
    box.settle()

    expect(box.details.style.overflow).toBe('auto')
  })

  it('falls back to a plain toggle without the animation API', () => {
    const box = makeBox()
    delete (box.details as Partial<HTMLDetailsElement>).animate

    toggleBoxWithDrawer(box.details)

    expect(box.details.open).toBe(true)
    expect(box.details.style.overflow).toBe('')
  })

  it('binds and unbinds a delegated summary handler', () => {
    const box = makeBox()
    const dispose = bindBoxDrawer(box.host)
    const summary = box.details.querySelector('summary')!

    const first = new MouseEvent('click', { bubbles: true, cancelable: true })
    summary.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true)
    expect(box.anims).toHaveLength(1)

    dispose()

    summary.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(box.anims).toHaveLength(1)
  })

  it('leaves clicks outside a summary alone', () => {
    const box = makeBox()
    bindBoxDrawer(box.host)

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    box.details.querySelector('p')!.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(box.anims).toHaveLength(0)
  })
})
