/**
 * DocumentEngine — BoxDrawer
 *
 * Drawer-style open/close animation for the `<details>` elements that
 * HTMLRenderer emits for `[box]` and `[spoilerbox]`. The box grows downwards
 * and progressively uncovers its content, which stays anchored under the
 * summary instead of popping in all at once.
 *
 * This lives in Quasar rather than in a consumer because Quasar is what emits
 * the `<details>` in the first place — the same reason `morphHTML` lives here.
 * Any host that renders Quasar output gets the behaviour by binding it once.
 *
 * Why not CSS: while a `<details>` is closed its content is not rendered, so
 * there is no height to interpolate between. `::details-content` combined with
 * `interpolate-size: allow-keywords` would solve it, but it is Chromium-only in
 * practice and hosts running on WebKit would silently lose the animation.
 * Measuring the real height and driving it with the Web Animations API works on
 * every engine.
 *
 * Heights are measured, not computed from summary + padding + borders, because
 * that arithmetic breaks as soon as a theme puts margins on the summary or the
 * boxes are nested. Toggling `open` and reading the rect yields the exact
 * height the element will settle at, whatever the stylesheet does.
 */

export interface BoxDrawerOptions {
  /** Length of a full open or close, in milliseconds. Partial travel is scaled down. */
  durationMs?: number
  /** CSS easing function. */
  easing?: string
}

/** Time for the full collapsed↔expanded travel; shorter distances scale down. */
const DEFAULT_DURATION_MS = 400
/** Floor so an interruption near the end still reads as motion, not a snap. */
const MIN_DURATION_MS = 120
/** easeOutCubic — fast to start, settles softly, no overshoot. */
const DEFAULT_EASING = 'cubic-bezier(0.33, 1, 0.68, 1)'

interface DrawerState {
  animation: Animation
  /** Where the box is heading, which is what a new click has to reverse. */
  opening: boolean
  /**
   * Inline `overflow` from before the FIRST animation of a chain. Carried
   * across interruptions so a reversal restores the author's value and not the
   * `hidden` that the previous animation had just installed.
   */
  restoreOverflow: string
}

/** In-flight state per element; a WeakMap so morphed-away nodes are freed. */
const running = new WeakMap<HTMLDetailsElement, DrawerState>()

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Animate one `<details>` to its opposite state, reversing cleanly when it is
 * already mid-animation.
 *
 * Exported so hosts that toggle boxes programmatically (a keyboard command, an
 * "expand all" action) go through the same animation as a click.
 */
export function toggleBoxWithDrawer(
  details: HTMLDetailsElement,
  options: BoxDrawerOptions = {}
): void {
  if (typeof details.animate !== 'function' || prefersReducedMotion()) {
    details.open = !details.open
    return
  }

  // Height as painted right now — read BEFORE cancelling, so an interrupted
  // animation resumes from where the eye last saw it instead of snapping.
  const from = details.getBoundingClientRect().height

  const previous = running.get(details)
  const restoreOverflow = previous ? previous.restoreOverflow : details.style.overflow

  // Direction comes from the running animation's intent, never from
  // `details.open`: a closing box is kept open so its content stays visible, so
  // reading the attribute would report "open" and close it a second time,
  // making a mid-close click impossible to reverse.
  const opening = previous ? !previous.opening : !details.open

  previous?.animation.cancel()

  // Both extremes are needed to scale the duration by the distance actually
  // travelled. `open` is left true either way so the content stays visible
  // while the box grows or shrinks over it.
  let collapsed: number
  let expanded: number
  if (details.open) {
    expanded = details.getBoundingClientRect().height
    details.open = false
    collapsed = details.getBoundingClientRect().height
    details.open = true
  } else {
    collapsed = details.getBoundingClientRect().height
    details.open = true
    expanded = details.getBoundingClientRect().height
  }

  const to = opening ? expanded : collapsed
  details.style.overflow = 'hidden'

  // A reversal 90% of the way open only has 10% left to travel; running the
  // full duration over it would crawl.
  const fullTravel = expanded - collapsed
  const ratio = fullTravel > 0 ? Math.min(Math.abs(to - from) / fullTravel, 1) : 1
  const duration = Math.max(
    (options.durationMs ?? DEFAULT_DURATION_MS) * ratio,
    MIN_DURATION_MS
  )

  const animation = details.animate(
    { height: [`${from}px`, `${to}px`] },
    { duration, easing: options.easing ?? DEFAULT_EASING }
  )
  running.set(details, { animation, opening, restoreOverflow })

  /**
   * `finish` and `cancel` are dispatched asynchronously, so by the time either
   * lands a newer toggle may already own the element. Without this guard the
   * outgoing animation strips the incoming one's `overflow: hidden` mid-flight
   * — content spilling out of a small box — or applies its own `open` and
   * freezes the box shut.
   */
  const settle = (finished: boolean) => {
    if (running.get(details)?.animation !== animation) return
    running.delete(details)
    if (finished) details.open = opening
    details.style.overflow = restoreOverflow
  }

  animation.addEventListener('finish', () => settle(true))
  animation.addEventListener('cancel', () => settle(false))
}

/**
 * Intercept the native toggle of every box inside `root`.
 *
 * The listener is delegated rather than attached per box: hosts typically feed
 * the preview through `morphHTML` on every keystroke, and per-element listeners
 * would be torn down and re-attached continuously.
 *
 * @param root - container holding the rendered BBCode
 * @returns disposer that removes the listener
 */
export function bindBoxDrawer(
  root: HTMLElement,
  options: BoxDrawerOptions = {}
): () => void {
  const handleClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null
    const summary = target?.closest('summary')
    if (!summary) return

    const details = summary.parentElement
    if (!(details instanceof HTMLDetailsElement)) return
    if (!root.contains(details)) return

    // Enter/Space on the summary also arrive here as a click, so the keyboard
    // is covered without a separate handler.
    e.preventDefault()
    toggleBoxWithDrawer(details, options)
  }

  root.addEventListener('click', handleClick)
  return () => root.removeEventListener('click', handleClick)
}
