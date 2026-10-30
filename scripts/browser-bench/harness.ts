import { BBCodeBatchRenderer } from '../../src/index.ts'

const OSU_CONTENT_WIDTH = 880
const CARD_PAGE_PADDING = 22
const RENDER_WIDTH = OSU_CONTENT_WIDTH + CARD_PAGE_PADDING * 2
const CARD_WIDTH = 380

interface Page { id: string; source: string; bytes: number }
interface PagesFile { median: Page; common: Page; pathological: Page; batch: Page[]; heavy: Page[] }

interface RenderResult {
  html: string
  parseMs: number
  renderMs: number
}

interface DomSample {
  renderMs: number
  detachedParseMs: number
  attachMs: number
  layoutMs: number
  frameMs: number
  htmlBytes: number
  elements: number
  scrollHeight: number
}

const renderer = new BBCodeBatchRenderer({ dialect: 'osu', theme: 'osu', pairing: 'osu' })
// El render de sólo lectura que trae el colapso de rachas de saltos.
const collapseRenderer = new BBCodeBatchRenderer({
  dialect: 'osu',
  theme: 'osu',
  pairing: 'osu',
  collapseBlankRuns: true,
})
const stage = document.getElementById('stage') as HTMLElement

const gc = (globalThis as { gc?: () => void }).gc

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function createCard(): { card: HTMLElement; frame: HTMLElement; page: HTMLElement } {
  const card = document.createElement('div')
  card.className = 'card'
  const frame = document.createElement('div')
  frame.className = 'card-frame'
  const page = document.createElement('div')
  page.className = 'card-page'
  page.style.width = `${RENDER_WIDTH}px`
  page.style.paddingLeft = `${CARD_PAGE_PADDING}px`
  page.style.paddingRight = `${CARD_PAGE_PADDING}px`
  page.style.transform = `scale(${(CARD_WIDTH - 2) / RENDER_WIDTH})`
  frame.append(page)
  card.append(frame)
  return { card, frame, page }
}

function nextFrames(count = 2): Promise<number> {
  const started = performance.now()
  return new Promise((resolve) => {
    let left = count
    const tick = () => {
      left -= 1
      if (left === 0) resolve(performance.now() - started)
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

// ── Long tasks del hilo principal ──────────────────────────────────────
const longTasks: { start: number; duration: number }[] = []
if (typeof PerformanceObserver !== 'undefined') {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration })
    }).observe({ type: 'longtask', buffered: false })
  } catch {
    // longtask no está disponible en todos los navegadores.
  }
}

function takeLongTasks(): { longTaskCount: number; longTaskMs: number; longTaskMaxMs: number } {
  const grabbed = longTasks.splice(0, longTasks.length)
  return {
    longTaskCount: grabbed.length,
    longTaskMs: grabbed.reduce((n, t) => n + t.duration, 0),
    longTaskMaxMs: grabbed.reduce((n, t) => Math.max(n, t.duration), 0),
  }
}

/** `count` páginas repartidas por TODA la distribución de tamaños. */
function spread(list: Page[], count: number): Page[] {
  const want = Math.min(count, list.length)
  const out: Page[] = []
  for (let i = 0; i < want; i++) out.push(list[Math.floor((i * list.length) / want)])
  return out
}

function countElements(html: string): number {
  // Una estimación barata: no parsea, sólo cuenta aperturas de etiqueta.
  let count = 0
  for (let at = html.indexOf('<'); at !== -1; at = html.indexOf('<', at + 1)) count++
  return count
}

function emptyDom(): void {
  stage.textContent = ''
}

async function measureDom(page: Page): Promise<DomSample> {
  emptyDom()
  await nextFrames(2)

  let started = performance.now()
  const rendered = renderer.renderDetailed(page.source) as RenderResult
  const renderMs = performance.now() - started

  const { card, frame, page: pageEl } = createCard()
  started = performance.now()
  pageEl.innerHTML = rendered.html
  const detachedParseMs = performance.now() - started

  started = performance.now()
  stage.append(card)
  const attachMs = performance.now() - started

  started = performance.now()
  frame.getBoundingClientRect()
  const layoutMs = performance.now() - started

  const frameMs = await nextFrames(2)
  return {
    renderMs,
    detachedParseMs,
    attachMs,
    layoutMs,
    frameMs,
    htmlBytes: rendered.html.length,
    elements: countElements(rendered.html),
    scrollHeight: pageEl.scrollHeight,
  }
}

/**
 * La misma medida, con dos variantes de HTML:
 *
 *   br       cada `empty_line` pasa de un div con un `<br>` dentro a un `<br>`
 *            (transformación sobre el string: no está en el renderer)
 *   collapse el renderer real con `collapseBlankRuns`: una racha de n saltos
 *            sale como su primer salto más un espaciador de `n - 1` lh
 *
 * El `scrollHeight` de las tres formas tiene que coincidir: si el colapso
 * cambia la altura, la comparación con el HTML de osu! ya no vale.
 */
async function measureDomVariant(page: Page, mode: 'br' | 'collapse'): Promise<DomSample> {
  emptyDom()
  await nextFrames(2)

  const rendered = (mode === 'collapse' ? collapseRenderer : renderer)
    .renderDetailed(page.source) as RenderResult
  let html = rendered.html
  if (mode === 'br') {
    html = html.replaceAll('<div class="bb-empty-line"><br></div>', '<br>')
  }

  const { card, frame, page: pageEl } = createCard()
  let started = performance.now()
  pageEl.innerHTML = html
  const detachedParseMs = performance.now() - started

  started = performance.now()
  stage.append(card)
  const attachMs = performance.now() - started

  started = performance.now()
  frame.getBoundingClientRect()
  const layoutMs = performance.now() - started

  const frameMs = await nextFrames(2)
  return {
    renderMs: rendered.renderMs + rendered.parseMs,
    detachedParseMs,
    attachMs,
    layoutMs,
    frameMs,
    htmlBytes: html.length,
    elements: countElements(html),
    scrollHeight: pageEl.scrollHeight,
  }
}

async function domPipelineVariant(id: string, mode: 'br' | 'collapse', runs = 5): Promise<Record<string, number>> {
  const page = pageById(id)
  const samples: DomSample[] = []
  for (let i = 0; i < runs; i++) {
    samples.push(await measureDomVariant(page, mode))
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return summarize(samples)
}

/**
 * Una rejilla de tarjetas como la de NovaLooky: la primera patológica y el
 * resto corrientes. Con `content-visibility: auto` las tarjetas fuera de la
 * ventana no se tendrían que maquetar.
 */
async function gridPipeline(count: number, visibility: boolean, runs = 3, mode: 'plain' | 'collapse' = 'plain'): Promise<Record<string, number>> {
  const used = mode === 'collapse' ? collapseRenderer : renderer
  const sources: Page[] = [pages.pathological]
  for (let i = 1; i < count; i++) sources.push(i % 4 === 0 ? pages.common : pages.median)
  const times: number[] = []
  const frames: number[] = []
  const heights: number[] = []
  for (let run = 0; run < runs; run++) {
    emptyDom()
    await nextFrames(2)
    const rendered = sources.map(page => (used.renderDetailed(page.source) as RenderResult).html)
    const started = performance.now()
    const cards: HTMLElement[] = []
    for (let i = 0; i < count; i++) {
      const { card, frame, page: pageEl } = createCard()
      if (visibility) frame.style.contentVisibility = 'auto'
      pageEl.innerHTML = rendered[i]
      stage.append(card)
      cards.push(card)
    }
    // Fuerza layout de todo lo que el viewport considera visible.
    for (const card of cards) card.getBoundingClientRect()
    const layoutDone = performance.now() - started
    const frameMs = await nextFrames(2)
    times.push(layoutDone)
    frames.push(frameMs)
    heights.push(cards[0].querySelector('.card-page')!.scrollHeight)
  }
  return {
    cards: count,
    layoutMs: median(times),
    frameMs: median(frames),
    pathologicalScrollHeight: median(heights),
  }
}

function summarize(samples: DomSample[]): Record<string, number> {
  const pick = (key: keyof DomSample) => median(samples.map(s => s[key]))
  return {
    renderMs: pick('renderMs'),
    detachedParseMs: pick('detachedParseMs'),
    attachMs: pick('attachMs'),
    layoutMs: pick('layoutMs'),
    frameMs: pick('frameMs'),
    htmlBytes: pick('htmlBytes'),
    elements: pick('elements'),
    scrollHeight: pick('scrollHeight'),
    totalMs: pick('renderMs') + pick('detachedParseMs') + pick('attachMs') + pick('layoutMs'),
  }
}

// ── Workers ────────────────────────────────────────────────────────────

interface WorkerReply {
  id: number
  html: string
  parseMs: number
  renderMs: number
  totalMs: number
}

class WorkerPool {
  private workers: Worker[] = []
  private nextId = 1
  private pending = new Map<number, (reply: WorkerReply) => void>()
  private ready: Promise<void>

  constructor(readonly size: number) {
    this.ready = Promise.all(Array.from({ length: size }, () => this.spawn())).then(() => undefined)
  }

  private spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker('./worker.js')
      this.workers.push(worker)
      worker.onerror = (event) => reject(new Error(event.message))
      worker.onmessage = (event: MessageEvent<WorkerReply | { ready: true }>) => {
        const data = event.data
        if ('ready' in data) {
          resolve()
          return
        }
        const resolveJob = this.pending.get(data.id)
        if (resolveJob) {
          this.pending.delete(data.id)
          resolveJob(data)
        }
      }
    })
  }

  whenReady(): Promise<void> {
    return this.ready
  }

  private send(source: string): Promise<WorkerReply> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      const worker = this.workers[(id - 1) % this.workers.length]
      worker.postMessage({ id, source })
    })
  }

  /** Un trabajo por worker a la vez: cada lane manda al suyo y espera. */
  async renderAll(sources: string[]): Promise<WorkerReply[]> {
    await this.ready
    const results = new Array<WorkerReply>(sources.length)
    const lane = async (workerIndex: number): Promise<void> => {
      for (let index = workerIndex; index < sources.length; index += this.size) {
        results[index] = await this.sendTo(workerIndex, sources[index])
      }
    }
    await Promise.all(Array.from({ length: this.size }, (_, index) => lane(index)))
    return results
  }

  private sendTo(workerIndex: number, source: string): Promise<WorkerReply> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.workers[workerIndex].postMessage({ id, source })
    })
  }

  terminate(): void {
    for (const worker of this.workers) worker.terminate()
    this.workers = []
  }
}

// ── API para el driver ─────────────────────────────────────────────────

const pages: PagesFile = await (await fetch('./pages.json')).json()

async function idleFrame(): Promise<number> {
  emptyDom()
  await nextFrames(2)
  return nextFrames(2)
}

function pageById(id: string): Page {
  if (id === 'median') return pages.median
  if (id === 'common') return pages.common
  if (id === 'pathological') return pages.pathological
  const found = pages.batch.find(p => p.id === id) ?? pages.heavy.find(p => p.id === id)
  if (!found) throw new Error(`unknown page ${id}`)
  return found
}

async function domPipeline(id: string, runs = 5): Promise<Record<string, number>> {
  const page = pageById(id)
  const samples: DomSample[] = []
  for (let i = 0; i < runs; i++) {
    samples.push(await measureDom(page))
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return summarize(samples)
}

async function singleMain(id: string, runs = 7): Promise<Record<string, number>> {
  const page = pageById(id)
  const renderTimes: number[] = []
  const parseTimes: number[] = []
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    const result = renderer.renderDetailed(page.source) as RenderResult
    renderTimes.push(performance.now() - started)
    parseTimes.push(result.parseMs)
  }
  return {
    sourceBytes: page.source.length,
    htmlBytes: (renderer.renderDetailed(page.source) as RenderResult).html.length,
    wallMs: median(renderTimes),
    parseMs: median(parseTimes),
  }
}

async function singleWorker(id: string, runs = 7): Promise<Record<string, number>> {
  const page = pageById(id)
  const coldStart = performance.now()
  const pool = new WorkerPool(1)
  await pool.whenReady()
  const startupMs = performance.now() - coldStart

  const coldStart2 = performance.now()
  const cold = await pool.renderAll([page.source])
  const coldMs = performance.now() - coldStart2

  const warm: number[] = []
  const inWorker: number[] = []
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    const [reply] = await pool.renderAll([page.source])
    warm.push(performance.now() - started)
    inWorker.push(reply.totalMs)
  }
  const htmlBytes = cold[0].html.length
  pool.terminate()
  return {
    sourceBytes: page.source.length,
    htmlBytes,
    workerStartupMs: startupMs,
    coldRoundTripMs: coldMs,
    warmRoundTripMs: median(warm),
    warmWorkerMs: median(inWorker),
  }
}

async function batchMain(count: number, set: 'batch' | 'heavy' = 'batch'): Promise<Record<string, number>> {
  const sources = spread(pages[set], count).map(p => p.source)
  takeLongTasks()
  const started = performance.now()
  let bytes = 0
  for (const source of sources) bytes += (renderer.renderDetailed(source) as RenderResult).html.length
  const totalMs = performance.now() - started
  await new Promise((resolve) => setTimeout(resolve, 50))
  const long = takeLongTasks()
  return {
    pages: sources.length,
    htmlMB: bytes / 1048576,
    totalMs,
    pagesPerSecond: (sources.length / totalMs) * 1000,
    ...long,
  }
}

async function batchWorkers(count: number, size: number, set: 'batch' | 'heavy' = 'batch'): Promise<Record<string, number>> {
  const sources = spread(pages[set], count).map(p => p.source)
  takeLongTasks()
  const started = performance.now()
  const pool = new WorkerPool(size)
  await pool.whenReady()
  const startupMs = performance.now() - started
  const startedJobs = performance.now()
  const replies = await pool.renderAll(sources)
  const totalMs = performance.now() - startedJobs
  await new Promise((resolve) => setTimeout(resolve, 50))
  const long = takeLongTasks()
  pool.terminate()
  return {
    pages: sources.length,
    workers: size,
    htmlMB: replies.reduce((n, r) => n + r.html.length, 0) / 1048576,
    startupMs,
    totalMs,
    pagesPerSecond: (sources.length / totalMs) * 1000,
    ...long,
  }
}

;(window as unknown as { __bench: unknown }).__bench = {
  meta: {
    median: pages.median.id,
    common: pages.common.id,
    pathological: pages.pathological.id,
    batch: pages.batch.length,
    heavy: pages.heavy.length,
    longTaskSupported: typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes.includes('longtask'),
  },
  idleFrame,
  domPipeline,
  singleMain,
  singleWorker,
  batchMain,
  batchWorkers,
  domPipelineVariant,
  gridPipeline,
}

;(window as unknown as { __benchReady: boolean }).__benchReady = true
