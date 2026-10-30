import { BBCodeBatchRenderer } from '../../src/index.ts'

interface Job {
  id: number
  source: string
}

const renderer = new BBCodeBatchRenderer({ dialect: 'osu', theme: 'osu', pairing: 'osu' })

self.onmessage = (event: MessageEvent<Job>) => {
  const { id, source } = event.data
  const started = performance.now()
  const result = renderer.renderDetailed(source)
  const totalMs = performance.now() - started
  ;(self as unknown as { postMessage: (message: unknown) => void }).postMessage({
    id,
    html: result.html,
    parseMs: result.parseMs,
    renderMs: result.renderMs,
    totalMs,
  })
}

// El driver espera a que el worker esté listo antes de medir la ida y vuelta.
;(self as unknown as { postMessage: (message: unknown) => void }).postMessage({ ready: true })
