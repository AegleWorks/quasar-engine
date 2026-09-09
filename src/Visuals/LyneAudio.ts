/**
 * Quasar Document Engine — Visuals / LyneAudio.ts
 *
 * Interactive runtime for Quasar's Lyne / SYNE custom audio player (.lx-audio).
 * Supports both scoped root binding (bindLyneAudio) and global document delegation.
 */

export function bindLyneAudio(
  root: HTMLElement = (typeof document !== 'undefined' ? document.documentElement : (undefined as any))
): () => void {
  if (!root || typeof root.addEventListener !== 'function') {
    return () => {}
  }

  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) return '–:––'
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s < 10 ? '0' : ''}${s}`
  }

  const PLAY_SVG = '<svg viewBox="0 0 16 16"><path d="M3 1.5 14 8 3 14.5z"/></svg>'
  const PAUSE_SVG = '<svg viewBox="0 0 16 16"><path d="M3 2h3.6v12H3zM9.4 2H13v12H9.4z"/></svg>'
  const RETRY_SVG = '<svg viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 0 6 6h-2a4 4 0 1 1-4-4v3l5-4-5-4z"/></svg>'
  const VOL_LOW_SVG = '<svg viewBox="0 0 16 16"><path d="M10.707 11.182A4.5 4.5 0 0 0 12.025 8a4.5 4.5 0 0 0-1.318-3.182L10 5.525A3.5 3.5 0 0 1 11.025 8 3.5 3.5 0 0 1 10 10.475zM6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06"/></svg>'
  const VOL_HIGH_SVG = '<svg viewBox="0 0 16 16"><path d="M11.536 14.01A8.47 8.47 0 0 0 14.026 8a8.47 8.47 0 0 0-2.49-6.01l-.708.707A7.48 7.48 0 0 1 13.025 8c0 2.071-.84 3.946-2.197 5.303z"/><path d="M10.121 12.596A6.48 6.48 0 0 0 12.025 8a6.48 6.48 0 0 0-1.904-4.596l-.707.707A5.48 5.48 0 0 1 11.025 8a5.48 5.48 0 0 1-1.61 3.89z"/><path d="M8.707 11.182A4.5 4.5 0 0 0 10.025 8a4.5 4.5 0 0 0-1.318-3.182L8 5.525A3.5 3.5 0 0 1 9.025 8 3.5 3.5 0 0 1 8 10.475zM6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06"/></svg>'
  const VOL_MUTE_SVG = '<svg viewBox="0 0 16 16"><path d="M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06m7.137 2.096a.5.5 0 0 1 0 .708L12.207 8l1.647 1.646a.5.5 0 0 1-.708.708L11.5 8.707l-1.646 1.647a.5.5 0 0 1-.708-.708L10.793 8 9.146 6.354a.5.5 0 1 1 .708-.708L11.5 7.293l1.646-1.647a.5.5 0 0 1 .708 0"/></svg>'

  const DEFAULT_VOLUME = 0.2

  const applyDefaultVolume = (audio: HTMLAudioElement) => {
    if (audio && audio.dataset.volSet !== 'true') {
      audio.volume = DEFAULT_VOLUME
      audio.dataset.volSet = 'true'
    }
  }

  const updateVolUI = (player: HTMLElement, vol: number) => {
    const btn = player.querySelector<HTMLButtonElement>('.lx-vol-btn')
    const slider = player.querySelector<HTMLInputElement>('.lx-vol-slider')
    if (slider) {
      if (Math.abs(parseFloat(slider.value) - vol) > 0.005) {
        slider.value = String(vol)
      }
      const pct = (vol * 100).toFixed(1)
      slider.style.background = `linear-gradient(to right, var(--color-accent, #2EE6E2) ${pct}%, var(--color-inset-well, #080D20) ${pct}%)`
    }
    if (btn) {
      if (vol <= 0.001) {
        btn.innerHTML = VOL_MUTE_SVG
        btn.setAttribute('aria-label', 'Unmute')
      } else if (vol > 0.5) {
        btn.innerHTML = VOL_HIGH_SVG
        btn.setAttribute('aria-label', 'Mute')
      } else {
        btn.innerHTML = VOL_LOW_SVG
        btn.setAttribute('aria-label', 'Mute')
      }
    }
  }

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (!target) return

    // 1. Play / Pause button
    const btn = target.closest<HTMLButtonElement>('.lx-btn')
    if (btn) {
      const player = btn.closest<HTMLElement>('.lx-audio')
      const audio = player?.querySelector<HTMLAudioElement>('audio')
      if (audio && player) {
        e.preventDefault()
        e.stopPropagation()

        if (player.classList.contains('is-error')) {
          player.classList.remove('is-error')
          player.classList.add('is-loading')
          audio.load()
          const p = audio.play()
          if (p !== undefined) {
            p.catch((err) => {
              console.warn('[LyneAudio] retry playback failed:', err)
              player.classList.remove('is-loading')
              player.classList.add('is-error')
            })
          }
        } else if (audio.paused) {
          // Pause any other playing audio on the page
          const doc = root.ownerDocument || document
          doc.querySelectorAll<HTMLElement>('.lx-audio.is-playing').forEach((other) => {
            if (other !== player) {
              const otherAudio = other.querySelector<HTMLAudioElement>('audio')
              if (otherAudio && !otherAudio.paused) {
                otherAudio.pause()
              }
            }
          })

          player.classList.add('is-loading')
          const p = audio.play()
          if (p !== undefined) {
            p.then(() => {
              player.classList.remove('is-loading')
            }).catch((err) => {
              console.warn('[LyneAudio] play failed:', err)
              player.classList.remove('is-loading')
              player.classList.add('is-error')
            })
          }
        } else {
          audio.pause()
        }
      }
      return
    }

    // 2. Track seeking
    const track = target.closest<HTMLElement>('.lx-track')
    if (track) {
      const player = track.closest<HTMLElement>('.lx-audio')
      const audio = player?.querySelector<HTMLAudioElement>('audio')
      if (audio) {
        e.preventDefault()
        e.stopPropagation()
        const rect = track.getBoundingClientRect()
        const pct = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
        if (audio.duration && isFinite(audio.duration)) {
          audio.currentTime = pct * audio.duration
        }
        const fill = track.querySelector<HTMLElement>('.fill')
        if (fill) fill.style.width = `${pct * 100}%`
      }
      return
    }

    // 3. Playback speed cycling
    const speed = target.closest<HTMLButtonElement>('.lx-speed')
    if (speed) {
      const player = speed.closest<HTMLElement>('.lx-audio')
      const audio = player?.querySelector<HTMLAudioElement>('audio')
      if (audio) {
        e.preventDefault()
        e.stopPropagation()
        const rates = [1.0, 1.25, 1.5, 0.75]
        const curRate = audio.playbackRate || 1.0
        const curIdx = rates.indexOf(curRate)
        const nextRate = rates[(curIdx + 1) % rates.length]
        audio.playbackRate = nextRate
        speed.textContent = `${nextRate}×`
        speed.classList.toggle('active', nextRate !== 1.0)
      }
      return
    }

    // 4. Volume mute toggle button
    const volBtn = target.closest<HTMLButtonElement>('.lx-vol-btn')
    if (volBtn) {
      const player = volBtn.closest<HTMLElement>('.lx-audio')
      const audio = player?.querySelector<HTMLAudioElement>('audio')
      if (audio && player) {
        e.preventDefault()
        e.stopPropagation()
        audio.dataset.volSet = 'true'
        if (audio.muted || audio.volume <= 0.001) {
          const prev = parseFloat(audio.dataset.prevVol || String(DEFAULT_VOLUME)) || DEFAULT_VOLUME
          audio.muted = false
          audio.volume = prev
          updateVolUI(player, prev)
        } else {
          audio.dataset.prevVol = String(audio.volume)
          audio.muted = true
          updateVolUI(player, 0)
        }
      }
      return
    }
  }

  const onInput = (e: Event) => {
    const target = e.target as HTMLElement | null
    if (!target) return
    const slider = target.closest<HTMLInputElement>('.lx-vol-slider')
    if (slider) {
      const player = slider.closest<HTMLElement>('.lx-audio')
      const audio = player?.querySelector<HTMLAudioElement>('audio')
      if (audio) {
        const val = parseFloat(slider.value)
        const clamped = isNaN(val) ? DEFAULT_VOLUME : Math.max(0, Math.min(1, val))
        audio.dataset.volSet = 'true'
        audio.muted = (clamped === 0)
        audio.volume = clamped
        if (player) {
          updateVolUI(player, clamped)
        }
      }
    }
  }

  // Media events (capture phase)
  const onPlay = (e: Event) => {
    const audio = e.target as HTMLAudioElement
    if (audio?.tagName !== 'AUDIO') return
    applyDefaultVolume(audio)
    const player = audio.closest<HTMLElement>('.lx-audio')
    if (!player) return
    player.classList.remove('is-loading')
    player.classList.add('is-playing')
    const btn = player.querySelector<HTMLButtonElement>('.lx-btn')
    if (btn) {
      btn.innerHTML = PAUSE_SVG
      btn.setAttribute('aria-label', 'Pause')
    }
    const label = player.querySelector<HTMLElement>('.lx-title .label .status-text')
    if (label) label.textContent = 'playing'
    updateVolUI(player, audio.muted ? 0 : audio.volume)
  }

  const onPause = (e: Event) => {
    const audio = e.target as HTMLAudioElement
    if (audio?.tagName !== 'AUDIO') return
    const player = audio.closest<HTMLElement>('.lx-audio')
    if (!player) return
    player.classList.remove('is-playing', 'is-loading')
    const btn = player.querySelector<HTMLButtonElement>('.lx-btn')
    if (btn) {
      btn.innerHTML = PLAY_SVG
      btn.setAttribute('aria-label', 'Play')
    }
    const label = player.querySelector<HTMLElement>('.lx-title .label .status-text')
    if (label) label.textContent = 'audio'
  }

  const onTimeUpdate = (e: Event) => {
    const audio = e.target as HTMLAudioElement
    if (audio?.tagName !== 'AUDIO') return
    const player = audio.closest<HTMLElement>('.lx-audio')
    if (!player) return
    const cur = audio.currentTime || 0
    const dur = audio.duration || 0
    const fill = player.querySelector<HTMLElement>('.lx-track .fill')
    const curTime = player.querySelector<HTMLElement>('.lx-time .cur')
    if (fill && dur > 0 && isFinite(dur)) {
      fill.style.width = `${(cur / dur) * 100}%`
    }
    if (curTime) {
      curTime.textContent = formatTime(cur)
    }
  }

  const onLoadedMetadata = (e: Event) => {
    const audio = e.target as HTMLAudioElement
    if (audio?.tagName !== 'AUDIO') return
    applyDefaultVolume(audio)
    const player = audio.closest<HTMLElement>('.lx-audio')
    if (!player) return
    const dur = audio.duration || 0
    const totalTime = player.querySelector<HTMLElement>('.lx-time .total')
    if (totalTime && dur > 0 && isFinite(dur)) {
      totalTime.textContent = formatTime(dur)
    }
    updateVolUI(player, audio.muted ? 0 : audio.volume)
  }

  const onWaiting = (e: Event) => {
    const audio = e.target as HTMLAudioElement
    if (audio?.tagName !== 'AUDIO') return
    const player = audio.closest<HTMLElement>('.lx-audio')
    if (!player) return
    player.classList.add('is-loading')
    const label = player.querySelector<HTMLElement>('.lx-title .label .status-text')
    if (label) label.textContent = 'buffering…'
  }

  const onError = (e: Event) => {
    const audio = e.target as HTMLAudioElement
    if (audio?.tagName !== 'AUDIO') return
    const player = audio.closest<HTMLElement>('.lx-audio')
    if (!player) return
    player.classList.remove('is-playing', 'is-loading')
    player.classList.add('is-error')
    const label = player.querySelector<HTMLElement>('.lx-title .label .status-text')
    if (label) label.textContent = 'unavailable — file error'
    const btn = player.querySelector<HTMLButtonElement>('.lx-btn')
    if (btn) {
      btn.innerHTML = RETRY_SVG
      btn.setAttribute('aria-label', 'Retry')
      btn.style.background = 'var(--color-danger, #FF3B5C)'
    }
    const curTime = player.querySelector<HTMLElement>('.lx-time .cur')
    const totalTime = player.querySelector<HTMLElement>('.lx-time .total')
    if (curTime) curTime.textContent = '–:––'
    if (totalTime) totalTime.textContent = '–:––'
  }

  const onVolumeChange = (e: Event) => {
    const audio = e.target as HTMLAudioElement
    if (audio?.tagName !== 'AUDIO') return
    const player = audio.closest<HTMLElement>('.lx-audio')
    if (!player) return
    updateVolUI(player, audio.muted ? 0 : audio.volume)
  }

  // Apply 20% default volume to all audio elements within root
  try {
    root.querySelectorAll<HTMLAudioElement>('audio').forEach((audio) => {
      applyDefaultVolume(audio)
      const player = audio.closest<HTMLElement>('.lx-audio')
      if (player) {
        updateVolUI(player, audio.muted ? 0 : audio.volume)
      }
    })
  } catch {}

  // Use capture phase so parent block selection cannot swallow clicks
  root.addEventListener('click', onClick, true)
  root.addEventListener('input', onInput, true)
  root.addEventListener('change', onInput, true)
  root.addEventListener('play', onPlay, true)
  root.addEventListener('pause', onPause, true)
  root.addEventListener('timeupdate', onTimeUpdate, true)
  root.addEventListener('loadedmetadata', onLoadedMetadata, true)
  root.addEventListener('durationchange', onLoadedMetadata, true)
  root.addEventListener('waiting', onWaiting, true)
  root.addEventListener('error', onError, true)
  root.addEventListener('volumechange', onVolumeChange, true)

  return () => {
    root.removeEventListener('click', onClick, true)
    root.removeEventListener('input', onInput, true)
    root.removeEventListener('change', onInput, true)
    root.removeEventListener('play', onPlay, true)
    root.removeEventListener('pause', onPause, true)
    root.removeEventListener('timeupdate', onTimeUpdate, true)
    root.removeEventListener('loadedmetadata', onLoadedMetadata, true)
    root.removeEventListener('durationchange', onLoadedMetadata, true)
    root.removeEventListener('waiting', onWaiting, true)
    root.removeEventListener('error', onError, true)
    root.removeEventListener('volumechange', onVolumeChange, true)
  }
}

export const setupLyneAudioRuntime = bindLyneAudio

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bindLyneAudio(document.documentElement)
}
