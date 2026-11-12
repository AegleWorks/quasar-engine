/**
 * osu! cards — the HTML of `[profilecard]`, `[beatmap]`, `[progress]` and
 * `[score]`.
 *
 * The look follows osu-web's dark theme at its default hue (333): the `b*`
 * surface ramp, `c2`/`f1` text, the pink `h1` accent, the rank, mod, status
 * and star-rating colours. Markup is our own; nothing is copied from osu-web.
 *
 * Two constraints shape every rule here:
 *
 * 1. Export snapshots the card with `domToSVG`, which draws boxes, images and
 *    text only. So: solid fills, uniform borders, no shadows, no gradients,
 *    no `text-transform` (the snapshot reads the DOM text), and hairlines are
 *    1px boxes, never a one-sided border.
 * 2. Aporhelion renders the same cards (`visitors/html_renderer/native.rs`)
 *    and must answer byte for byte. Keep the logic to string work and plain
 *    float maths, and change both sides together.
 */

const FONT = 'font-family:Torus,Inter,Helvetica Neue,Tahoma,Arial,sans-serif;'
const ELLIPSIS = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'

/**
 * Surfaces are translucent black, not osu-web's hue-333 ramp: a userpage can
 * have any background, and a pink card vanishes on a pink page. Layers stack
 * on the root, so each step reads darker than the one beneath it.
 */
const B1 = 'rgba(255,255,255,.1)'
const B2 = 'rgba(0,0,0,.12)'
const B3 = 'rgba(0,0,0,.1)'
const B4 = 'rgba(0,0,0,.2)'
const B6 = 'rgba(0,0,0,.3)'
/** Dark ink on bright pills (stars, mods), which needs to stay opaque. */
const INK = '#1C1C1C'
/** Secondary text (`c2`) and faint labels (`f1`). */
const C2 = 'rgba(255,255,255,.85)'
const F1 = 'rgba(255,255,255,.55)'
/** The accent (`h1`), accuracy yellow and difficulty-name yellow. */
const H1 = '#FF66AB'
const YELLOW = '#FFCC22'
const YELLOW_DARK = '#EEAA00'

const ROOT = `${FONT}box-sizing:border-box;display:inline-block;vertical-align:top;width:100%;max-width:620px;overflow:hidden;border-radius:10px;background:${B4};color:#fff;line-height:1.3;text-align:left;`
const FILL = 'position:absolute;left:0;top:0;width:100%;height:100%;'
const COVER_IMG = `${FILL}object-fit:cover;display:block;margin:0;border-radius:0;`

export type Escape = (text: string) => string

/** An `http(s)` URL, or `''`: the only thing an `<img src>` here may hold. */
export function cardImageUrl(raw: string): string {
  const url = raw.trim()
  return /^https?:\/\//i.test(url) ? url : ''
}

/** `12345` → `12,345`, `9876.5` → `9,876.5`; anything else comes back trimmed. */
export function groupNumber(raw: string): string {
  const text = raw.trim()
  const plain = text.replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(plain)) return text
  const dot = plain.indexOf('.')
  const whole = dot === -1 ? plain : plain.slice(0, dot)
  const rest = dot === -1 ? '' : plain.slice(dot)
  let out = ''
  for (let i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 === 0) out += ','
    out += whole[i]
  }
  return out + rest
}

/** Seconds (`222`) → `3:42`; a value already written as a time is kept. */
export function formatLength(raw: string): string {
  const text = raw.trim()
  if (!/^\d+$/.test(text)) return text
  const total = parseInt(text, 10)
  const seconds = total % 60
  return `${Math.floor(total / 60)}:${seconds < 10 ? '0' : ''}${seconds}`
}

/** The osu! flag artwork (Twemoji code points) of a two-letter country code, or `''`. */
export function flagUrl(country: string): string {
  if (!/^[A-Za-z]{2}$/.test(country)) return ''
  const code = country.toUpperCase()
  const point = (i: number) => (0x1f1e6 + code.charCodeAt(i) - 65).toString(16)
  return `https://osu.ppy.sh/assets/images/flags/${point(0)}-${point(1)}.svg`
}

// ── Star rating ──────────────────────────────────────────────────

const SR_DOMAIN = [0.1, 1.25, 2, 2.5, 3.3, 4.2, 4.9, 5.8, 6.7, 7.7, 9]
const SR_RANGE: ReadonlyArray<readonly [number, number, number]> = [
  [0x42, 0x90, 0xfb], [0x4f, 0xc0, 0xff], [0x4f, 0xff, 0xd5], [0x7c, 0xff, 0x4f],
  [0xf6, 0xf0, 0x5c], [0xff, 0x80, 0x68], [0xff, 0x4e, 0x6f], [0xc6, 0x45, 0xb8],
  [0x65, 0x63, 0xde], [0x18, 0x15, 0x8e], [0x00, 0x00, 0x00],
]
const SR_GAMMA = 2.2

const hex2 = (value: number): string => (value < 16 ? '0' : '') + value.toString(16).toUpperCase()

/**
 * osu!'s difficulty colour: the star-rating spectrum, interpolated between
 * its stops in gamma 2.2 as the site does. Below 0.1 is grey, 9 and up black.
 */
export function starColor(sr: number): string {
  if (!Number.isFinite(sr) || sr < 0.1) return '#AAAAAA'
  if (sr >= 9) return '#000000'
  let i = 0
  while (sr >= SR_DOMAIN[i + 1]) i++
  const t = (sr - SR_DOMAIN[i]) / (SR_DOMAIN[i + 1] - SR_DOMAIN[i])
  const from = SR_RANGE[i]
  const to = SR_RANGE[i + 1]
  let out = '#'
  for (let c = 0; c < 3; c++) {
    const a = Math.pow(from[c], SR_GAMMA)
    const b = Math.pow(to[c], SR_GAMMA)
    out += hex2(Math.round(Math.pow(a + t * (b - a), 1 / SR_GAMMA)))
  }
  return out
}

/** Text on a difficulty badge: dark up to 6.5 stars, yellow on the dark end. */
const starInk = (sr: number): string => (sr < 6.5 ? INK : '#FFD966')

// ── Vocabulary ───────────────────────────────────────────────────

/** Beatmap status → `[background, text]`. */
function statusColors(status: string): readonly [string, string] {
  switch (status) {
    case 'ranked':
    case 'approved': return ['#B3FF66', '#333333']
    case 'qualified': return ['#66CCFF', '#333333']
    case 'loved': return ['#FF66AB', '#333333']
    case 'pending': return ['#FFD966', '#333333']
    case 'wip': return ['#FF9966', '#333333']
    case 'graveyard': return ['#000000', '#5C6970']
    default: return [B1, '#FFFFFF']
  }
}

/** Grade as written → `[label, background, text]`. `SS`/`SSH` are osu!'s `X`/`XH`. */
function gradeBadge(grade: string): readonly [string, string, string] {
  switch (grade) {
    case 'XH':
    case 'SSH': return ['SS', '#DE31AE', '#F0F3F5']
    case 'X':
    case 'SS': return ['SS', '#DE31AE', '#FFE566']
    case 'SH': return ['S', '#02B5C3', '#F0F3F5']
    case 'S': return ['S', '#02B5C3', '#FFE566']
    case 'A': return ['A', '#88DA20', '#1F3B08']
    case 'B': return ['B', '#E3B130', '#4A3608']
    case 'C': return ['C', '#FF8E5D', '#4D1F0C']
    case 'D': return ['D', '#FF5A5A', '#4D1010']
    default: return [grade, B1, '#FFFFFF']
  }
}

const MODS_REDUCTION = ['EZ', 'NF', 'HT', 'DC']
const MODS_INCREASE = ['HR', 'SD', 'PF', 'DT', 'NC', 'HD', 'FL', 'FI', 'BL', 'ST', 'AC', 'CO']
const MODS_AUTOMATION = ['AT', 'CN', 'RX', 'AP', 'SO']
const MODS_CONVERSION = ['TP', 'DA', 'CL', 'RD', 'MR', 'AL', 'SG', 'DS', 'IN', 'CS', 'HO', 'SW', 'NR', '1K', '2K', '3K', '4K', '5K', '6K', '7K', '8K', '9K']
const MODS_SYSTEM = ['TD', 'V2']

/** Mod acronym → `[background, text]`, by the mod's type as lazer colours it. */
function modColors(mod: string): readonly [string, string] {
  if (MODS_REDUCTION.includes(mod)) return ['#B2FF66', INK]
  if (MODS_INCREASE.includes(mod)) return ['#FF6666', INK]
  if (MODS_AUTOMATION.includes(mod)) return ['#66CCFF', INK]
  if (MODS_CONVERSION.includes(mod)) return ['#8C66FF', '#FFFFFF']
  if (MODS_SYSTEM.includes(mod)) return [YELLOW, INK]
  return [H1, INK]
}

/**
 * `HDHR`, `hd,hr`, `HD + HR` → `['HD', 'HR']`. Written together, acronyms are
 * two characters each; `NM` (no mod) is not a mod.
 */
export function splitMods(raw: string): string[] {
  const text = raw.trim().toUpperCase()
  if (!text) return []
  const parts = /[\s,+]/.test(text)
    ? text.split(/[\s,+]+/)
    : Array.from(text).reduce<string[]>((acc, ch, i) => {
        if (i % 2 === 0) acc.push(ch)
        else acc[acc.length - 1] += ch
        return acc
      }, [])
  return parts.filter(part => part !== '' && part !== 'NM')
}

// ── Cards ────────────────────────────────────────────────────────

export interface ProfileCardInput {
  /** ` data-node-id="…"` or `''`. */
  id: string
  user: string
  rank: string
  countryRank: string
  pp: string
  acc: string
  country: string
  avatar: string
  cover: string
  /** The rendered children. */
  body: string
}

const stat = (label: string, value: string): string =>
  `<div style="min-width:0;"><div style="font-size:11px;color:${F1};white-space:nowrap;">${label}</div>`
  + `<div style="font-size:19px;line-height:1.25;white-space:nowrap;">${value}</div></div>`

const rankText = (raw: string, esc: Escape): string => {
  const rank = groupNumber(raw.trim().replace(/^#/, ''))
  return rank ? `#${esc(rank)}` : ''
}

/** `98.5` and `98.5%` → `98.50%`; a value that is not a number is shown as written. */
function accuracyText(raw: string, esc: Escape): string {
  const text = raw.trim().replace(/%$/, '')
  const value = parseFloat(text)
  if (Number.isFinite(value)) return `${value.toFixed(2)}%`
  return esc(text)
}

export function profileCardHTML(input: ProfileCardInput, esc: Escape): string {
  const user = input.user || 'player'
  const avatar = cardImageUrl(input.avatar)
  const cover = cardImageUrl(input.cover)
  const country = input.country.trim()
  const flag = flagUrl(country)
  const rank = rankText(input.rank, esc)
  const countryRank = rankText(input.countryRank, esc)
  const pp = groupNumber(input.pp)
  const acc = accuracyText(input.acc, esc)

  const stats = (rank ? stat('Global Ranking', rank) : '')
    + (countryRank ? stat('Country Ranking', countryRank) : '')
    + (pp ? stat('pp', esc(pp)) : '')
    + (acc ? stat('Accuracy', acc) : '')

  const face = avatar
    ? `<img src="${esc(avatar)}" alt="" style="flex:none;width:72px;height:72px;object-fit:cover;display:block;margin:0;border-radius:18px;">`
    : `<div style="flex:none;width:72px;height:72px;border-radius:18px;background:${B1};display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:600;line-height:1;">${esc(Array.from(user)[0].toUpperCase())}</div>`

  return `<div${input.id} class="bb-profilecard" style="${ROOT}">`
    + `<div style="position:relative;background:${B2};">`
    + (cover
        ? `<img src="${esc(cover)}" alt="" style="${COVER_IMG}"><div style="${FILL}background:rgba(28,23,25,.6);"></div>`
        : '')
    + `<div style="position:relative;display:flex;align-items:center;gap:14px;padding:16px;">`
    + face
    + `<div style="min-width:0;flex:1;">`
    + `<div style="font-size:22px;font-weight:600;line-height:1.2;${ELLIPSIS}">${esc(user)}</div>`
    + (country
        ? `<div style="display:flex;align-items:center;gap:6px;margin-top:4px;font-size:13px;color:${C2};">`
          + (flag ? `<img src="${flag}" alt="" style="flex:none;width:20px;height:20px;display:block;margin:0;border-radius:0;">` : '')
          + `<span>${esc(flag ? country.toUpperCase() : country)}</span></div>`
        : '')
    + `</div></div></div>`
    + (stats ? `<div style="display:flex;gap:28px;padding:10px 16px 12px;">${stats}</div>` : '')
    + (input.body
        ? `<div style="padding:${stats ? '0' : '12px'} 16px 14px;font-size:13px;line-height:1.5;">${input.body}</div>`
        : '')
    + `</div>`
}

export interface BeatmapCardInput {
  id: string
  artist: string
  title: string
  diff: string
  mapper: string
  sr: string
  status: string
  cover: string
  bpm: string
  length: string
  body: string
}

export function beatmapCardHTML(input: BeatmapCardInput, esc: Escape): string {
  const cover = cardImageUrl(input.cover)
  const diff = input.diff.trim()
  const sr = parseFloat(input.sr)
  const status = (input.status.trim() || 'ranked').toLowerCase()
  const [statusBg, statusInk] = statusColors(status)
  const bpm = input.bpm.trim()
  const length = formatLength(input.length)
  const facts = [bpm ? `${esc(bpm)} BPM` : '', length ? esc(length) : ''].filter(Boolean).join(' · ')

  return `<div${input.id} class="bb-beatmap" style="${ROOT}display:inline-flex;min-height:100px;">`
    + `<div style="position:relative;flex:none;width:100px;background:${B2};">`
    + (cover
        ? `<img src="${esc(cover)}" alt="" style="${COVER_IMG}">`
        : `<div style="position:absolute;left:50%;top:50%;width:36px;height:36px;margin:-22px 0 0 -22px;border:4px solid ${B1};border-radius:22px;"></div>`)
    + `</div>`
    + `<div style="min-width:0;flex:1;display:flex;flex-direction:column;padding:8px 12px 9px;">`
    + `<div style="font-size:16px;font-weight:600;${ELLIPSIS}">${esc(input.title || 'Untitled')}</div>`
    + (input.artist ? `<div style="font-size:13px;color:${C2};${ELLIPSIS}">by ${esc(input.artist)}</div>` : '')
    + (input.mapper
        ? `<div style="margin-top:2px;font-size:12px;color:${F1};${ELLIPSIS}">mapped by <span style="font-weight:600;color:${C2};">${esc(input.mapper)}</span></div>`
        : '')
    + `<div style="display:flex;align-items:center;gap:6px;margin-top:auto;padding-top:8px;font-size:12px;white-space:nowrap;">`
    + `<span style="flex:none;padding:1px 8px;border-radius:999px;background:${statusBg};color:${statusInk};font-size:10px;font-weight:700;">${esc(status.toUpperCase())}</span>`
    + (Number.isFinite(sr)
        ? `<span style="flex:none;padding:1px 7px;border-radius:999px;background:${starColor(sr)};color:${starInk(sr)};font-size:11px;font-weight:700;">★ ${sr.toFixed(2)}</span>`
        : '')
    + `<span style="min-width:0;flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;">${esc(diff)}</span>`
    + (facts ? `<span style="flex:none;color:${F1};">${facts}</span>` : '')
    + `</div>`
    + (input.body
        ? `<div style="height:1px;margin:8px 0;background:${B2};"></div><div style="font-size:13px;line-height:1.5;">${input.body}</div>`
        : '')
    + `</div></div>`
}

export interface ProgressInput {
  id: string
  /** Already clamped to 0–100. */
  percent: number
  label: string
  level: string
  color: string
}

export function progressHTML(input: ProgressInput, esc: Escape): string {
  const color = input.color.trim()
  const fill = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color) ? color : H1
  const label = input.label || (input.level ? `Level ${input.level}` : 'Progress')
  const percent = `${Math.round(input.percent * 10) / 10}%`

  return `<div${input.id} class="bb-progress" style="${ROOT}display:inline-flex;align-items:center;gap:12px;padding:10px 14px;">`
    + (input.level
        ? `<div style="box-sizing:border-box;flex:none;min-width:40px;height:40px;padding:0 6px;border:2px solid ${fill};border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;white-space:nowrap;">${esc(input.level)}</div>`
        : '')
    + `<div style="min-width:0;flex:1;">`
    + `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:6px;font-size:12px;">`
    + `<span style="min-width:0;color:${C2};${ELLIPSIS}">${esc(label)}</span>`
    + `<span style="flex:none;font-weight:600;">${percent}</span>`
    + `</div>`
    + `<div style="height:6px;overflow:hidden;border-radius:3px;background:${B6};"><div style="width:${input.percent}%;height:100%;border-radius:3px;background:${fill};"></div></div>`
    + `</div></div>`
}

export interface ScoreInput {
  id: string
  grade: string
  artist: string
  title: string
  diff: string
  mapper: string
  mods: string
  acc: string
  combo: string
  pp: string
}

export function scoreHTML(input: ScoreInput, esc: Escape): string {
  const [gradeLabel, gradeBg, gradeInk] = gradeBadge(input.grade.trim().toUpperCase() || 'S')
  const diff = input.diff.trim()
  const mods = splitMods(input.mods)
  const acc = accuracyText(input.acc, esc)
  const combo = input.combo.trim()
  const pp = groupNumber(input.pp)

  const chips = mods.map((mod) => {
    const [bg, ink] = modColors(mod)
    return `<span style="flex:none;padding:2px 6px;border-radius:999px;background:${bg};color:${ink};font-size:10px;font-weight:700;line-height:1.2;">${esc(mod)}</span>`
  }).join('')

  return `<div${input.id} class="bb-score" style="${ROOT}display:inline-flex;align-items:stretch;min-height:52px;font-size:12px;">`
    + `<div style="flex:none;width:62px;display:flex;align-items:center;justify-content:center;">`
    + `<div style="box-sizing:border-box;min-width:42px;height:22px;padding:0 8px;border-radius:11px;background:${gradeBg};color:${gradeInk};display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;line-height:1;white-space:nowrap;">${esc(gradeLabel)}</div>`
    + `</div>`
    + `<div style="min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center;padding:7px 10px 7px 0;">`
    + `<div style="${ELLIPSIS}"><span style="font-size:14px;font-weight:600;">${esc(input.title || 'Untitled')}</span>`
    + (input.artist ? `<span style="color:${C2};"> by ${esc(input.artist)}</span>` : '')
    + `</div>`
    + (diff || input.mapper
        ? `<div style="margin-top:1px;${ELLIPSIS}">`
          + (diff ? `<span style="color:${YELLOW_DARK};">${esc(diff)}</span>` : '')
          + (input.mapper ? `<span style="color:${F1};">${diff ? ' · ' : ''}mapped by ${esc(input.mapper)}</span>` : '')
          + `</div>`
        : '')
    + `</div>`
    + (chips || acc || combo
        ? `<div style="flex:none;display:flex;align-items:center;gap:8px;padding:0 12px 0 2px;white-space:nowrap;">`
          + (chips ? `<span style="display:flex;gap:3px;">${chips}</span>` : '')
          + (acc ? `<span style="font-size:13px;font-weight:600;color:${YELLOW};">${acc}</span>` : '')
          + (combo ? `<span style="color:${F1};">${esc(combo)}</span>` : '')
          + `</div>`
        : '')
    + (pp
        ? `<div style="box-sizing:border-box;flex:none;min-width:92px;padding:0 12px;display:flex;align-items:center;justify-content:center;background:${B3};font-size:17px;font-weight:700;color:${H1};white-space:nowrap;">${esc(pp)}<span style="margin-left:1px;font-size:12px;font-weight:400;color:#FFB3D5;">pp</span></div>`
        : '')
    + `</div>`
}
