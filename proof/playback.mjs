// Does the Nutflix page really PLAY at a URL, and where does the startup time go? Headless Chromium
// (Playwright, a fresh context per run, never a real profile), inside a throwaway Kata VM:
// proof/playback-vm.sh. Nothing here signs or publishes.
//
//   node playback.mjs <https base> [--cold N] [--settled N] [--nortc N] [--alphaoff N] [--no-names]
//     cold      open the page, go to the video, press Play as soon as the button shows: what a viewer gets
//     settled   press Play only after a seeder's beacon for the video has arrived: the startup WITHOUT the
//               wait for a beacon (beacons are ephemeral, republished every 60 s, and never stored)
//     nortc     settled, in a browser whose WebRTC cannot use UDP, so no peer connection can form: if
//               this starts as fast as `settled`, WebRTC is not what delays the first frame
//     alphaoff  the alpha-off drill: alpha is cut off (below, proven at the start of each run), and the
//               Network feed must list both videos, the video must play 8 s with bytes over WebRTC, and no
//               request to alpha may get an answer. Only with no other mode in the same process.
//     --no-names  alphaoff: alpha's names do not resolve at all (default: they resolve to an unroutable
//               address, so connections hang as in the 2026-11-26 outage)
// How alpha is cut: a CI guest has no CAP_NET_ADMIN, so this is done in the browser, and covers each way
// the page reaches alpha. Its names (*.nutflix.xyz, all 185.147.157.180; the apex is not alpha) are
// mapped by --host-resolver-rules to 192.0.2.1 (TEST-NET-1) or to NOTFOUND. A request to its address
// itself is held 30 s and then fails. Every peer connection loses alpha's STUN servers and every ICE
// candidate at alpha's address, offered or added (`rtc.cut` counts them).
// One `RUN {json}` line per run, all times in ms from navigation:
//   dom, rendered   the page parsed; the app drew into #root
//   listed          alphaoff: when the Network feed showed `listCards` videos (null: fewer than 2 in 30 s);
//                   listMs: from opening the feed (after the cut's probe) to that
//   button          the video's page is up (its Play button)
//   click           Play pressed
//   seeder          the first beacon frame for the video, from any seeder; `seeders` = their keys (12 hex)
//   firstOrigin     the first request to alpha's HTTPS origin (web.nutflix.xyz/o)
//   alphaRequests, alphaOk   requests to alpha's names or address, and how many got an HTTP answer
//   playing         the first frame (currentTime > 0)
//   past8           currentTime > 8 s: it really plays
//   rtc             the first peer connection created, ICE gathered, connected, data channel open;
//                   rtcBytesAtFirstFrame / rtcBytesAt8s: bytes received over WebRTC by then;
//                   pairs: each connection's selected candidate pair, as local/remote candidate types
import { chromium } from 'playwright'

const VIDEO = '38504:fcbe23d9ff9a65b43163612decd68137a498e69663741b4689e5022bfced03c0:nfx:testnet:1:big-buck-bunny'
const ORIGIN = 'https://web.nutflix.xyz/o'
const BEACON_KIND = '"kind":20464'
/** alpha: its address, and every name it serves (the subdomains; the apex is elsewhere). */
const ALPHA_IP = '185.147.157.180'
const isAlpha = (url) => {
  try {
    const h = new URL(url).hostname
    return h.endsWith('.nutflix.xyz') || h === ALPHA_IP
  } catch { return false }
}

const argv = process.argv.slice(2)
const base = argv[0]
const opt = (k, d) => { const i = argv.indexOf(k); return i > 0 ? Number(argv[i + 1]) : d }
const noNames = argv.includes('--no-names')
const cut = opt('--alphaoff', 0) > 0
if (cut && (opt('--cold', 3) + opt('--settled', 2) + opt('--nortc', 2)) > 0) { console.error('--alphaoff runs alone: pass --cold 0 --settled 0 --nortc 0'); process.exit(2) }
if (!base || !/^https:\/\/[a-z0-9.-]+\/?$/.test(base)) { console.error('usage: node playback.mjs <https base> [--cold N] [--settled N] [--nortc N] [--alphaoff N] [--no-names]'); process.exit(2) }
const short = (s, n = 160) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, n)

/**
 * Installed before any page script: every peer connection's first milestones, as absolute times. With
 * `cut` (alphaoff), alpha's STUN servers and every ICE candidate at its address never reach the browser.
 */
function watchRtc ({ cut, ip }) {
  const rtc = { count: 0, created: null, gathered: null, connected: null, channel: null, pcs: [], cut: { servers: 0, candidates: 0 } }
  window.__rtc = rtc
  const P = window.RTCPeerConnection
  if (!P) return
  const alphaUrl = (u) => String(u).includes(ip) || /\.nutflix\.xyz/i.test(String(u))
  const servers = (cfg) => {
    if (!cut || !cfg?.iceServers) return cfg
    const kept = []
    for (const s of cfg.iceServers) {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => { const a = alphaUrl(u); if (a) rtc.cut.servers++; return !a })
      if (urls.length > 0) kept.push({ ...s, urls })
    }
    return { ...cfg, iceServers: kept }
  }
  const sdp = (d) => {
    if (!cut || !d?.sdp) return d
    const lines = d.sdp.split('\r\n').filter((l) => { const a = l.startsWith('a=candidate:') && l.includes(` ${ip} `); if (a) rtc.cut.candidates++; return !a })
    return { type: d.type, sdp: lines.join('\r\n') }
  }
  const opened = (d) => d.addEventListener('open', () => { rtc.channel ??= Date.now() })
  window.RTCPeerConnection = class extends P {
    constructor (cfg, ...rest) {
      super(servers(cfg), ...rest)
      rtc.count++
      rtc.pcs.push(this)
      rtc.created ??= Date.now()
      this.addEventListener('icegatheringstatechange', () => { if (this.iceGatheringState === 'complete') rtc.gathered ??= Date.now() })
      this.addEventListener('connectionstatechange', () => { if (this.connectionState === 'connected') rtc.connected ??= Date.now() })
      this.addEventListener('datachannel', (e) => opened(e.channel))
    }
    createDataChannel (...a) { const d = super.createDataChannel(...a); opened(d); return d }
    setConfiguration (cfg) { return super.setConfiguration(servers(cfg)) }
    setRemoteDescription (d, ...rest) { return super.setRemoteDescription(sdp(d), ...rest) }
    addIceCandidate (c, ...rest) {
      const line = typeof c === 'string' ? c : c?.candidate
      if (cut && typeof line === 'string' && line.includes(` ${ip} `)) { rtc.cut.candidates++; return Promise.resolve() }
      return super.addIceCandidate(c, ...rest)
    }
  }
}

/** Bytes received over every peer connection so far. */
const rtcBytes = (page) => page.evaluate(async () => {
  let n = 0
  for (const pc of window.__rtc?.pcs ?? []) {
    try { (await pc.getStats()).forEach((x) => { if (x.type === 'transport') n += x.bytesReceived || 0 }) } catch {}
  }
  return n
})

/** Each connection's selected candidate pair as `local/remote` candidate types (host, srflx, prflx, relay). */
const rtcPairs = (page) => page.evaluate(async () => {
  const out = []
  for (const pc of window.__rtc?.pcs ?? []) {
    try {
      const s = await pc.getStats()
      const all = new Map(); s.forEach((x) => all.set(x.id, x))
      for (const x of all.values()) {
        if (x.type !== 'transport' || !x.selectedCandidatePairId) continue
        const p = all.get(x.selectedCandidatePairId)
        const l = p && all.get(p.localCandidateId); const r = p && all.get(p.remoteCandidateId)
        if (l && r) out.push(`${l.candidateType}/${r.candidateType}`)
      }
    } catch {}
  }
  return out
}).catch(() => [])

/** A websocket frame's beacon for VIDEO, as its seeder's key, or null. */
function beaconSeeder (s) {
  if (!s.includes(BEACON_KIND) || !s.includes(VIDEO)) return null
  try {
    const m = JSON.parse(s)
    const ev = Array.isArray(m) && m[0] === 'EVENT' ? m[2] : null
    if (ev?.kind !== 20464 || !ev.tags?.some((t) => t[0] === 'a' && t[1] === VIDEO)) return null
    return typeof ev.pubkey === 'string' ? ev.pubkey.slice(0, 12) : null
  } catch { return null }
}

/** alphaoff: open the Network feed and wait (30 s) for at least two video cards. */
async function networkListing (page, r, ms) {
  r.listStart = ms()
  const tab = page.locator('[role="tab"]', { hasText: 'Network' })
  if (await tab.count() > 0) await tab.first().click({ timeout: 5_000 }).catch(() => undefined)
  const cards = page.locator('.nf-card:not(.nf-card--skeleton)')
  const until = Date.now() + 30_000
  while (Date.now() < until && await cards.count() < 2) await page.waitForTimeout(200)
  r.listCards = await cards.count()
  const start = r.listStart
  r.listTitles = (await page.locator('.nf-card:not(.nf-card--skeleton) .nf-card__title').allInnerTexts().catch(() => [])).slice(0, 4).map((t) => short(t, 60))
  if (r.listCards >= 2) { r.listed = ms(); r.listMs = r.listed - start }
  else r.listShown = short(await page.locator('#root').innerText({ timeout: 1000 }).catch(() => ''), 240)
}

async function once (browser, mode) {
  const ctx = await browser.newContext()
  await ctx.addInitScript(watchRtc, { cut, ip: ALPHA_IP })
  // A request to alpha's address itself (no name for the resolver rules to catch): held, then failed.
  if (cut) await ctx.route((u) => u.hostname === ALPHA_IP, async (route) => { await new Promise((f) => setTimeout(f, 30_000)); await route.abort('timedout').catch(() => undefined) })
  const page = await ctx.newPage()
  const t0 = Date.now()
  const ms = () => Date.now() - t0
  const r = { mode, noNames, cutProven: null, ok: false, dom: null, rendered: null, listed: null, listMs: null, listCards: null, button: null, click: null, seeder: null, seeders: [], beaconFrames: 0, firstOrigin: null, originRequests: 0, alphaRequests: 0, alphaOk: 0, playing: null, past8: null, rtcBytesAtFirstFrame: null, rtcBytesAt8s: null, rtc: null, pairs: [], problem: null, errors: [], csp: [] }
  page.on('pageerror', (e) => { if (r.errors.length < 3) r.errors.push(short(e)) })
  page.on('console', (m) => { if (/Content[- ]Security[- ]Policy|Refused to/i.test(m.text()) && r.csp.length < 3) r.csp.push(short(m.text())) })
  page.on('websocket', (ws) => {
    if (isAlpha(ws.url())) r.alphaRequests++
    ws.on('framereceived', (f) => {
      const s = typeof f.payload === 'string' ? f.payload : ''
      if (s.includes(BEACON_KIND)) r.beaconFrames++
      const who = beaconSeeder(s)
      if (who === null) return
      if (r.seeder === null) r.seeder = ms()
      if (!r.seeders.includes(who)) r.seeders.push(who)
    })
  })
  ctx.on('request', (q) => {
    if (q.url().startsWith(ORIGIN)) { r.originRequests++; if (r.firstOrigin === null) r.firstOrigin = ms() }
    if (isAlpha(q.url())) r.alphaRequests++
  })
  ctx.on('response', (s) => { if (isAlpha(s.url())) r.alphaOk++ })
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    r.dom = ms()
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, null, { timeout: 60_000 })
    r.rendered = ms()
    if (mode === 'alphaoff') {
      // The cut is proven, not assumed: alpha, by name and by address, must not answer in this browser
      // (a tab of its own, so the site's CSP cannot fake a pass).
      const probe = await ctx.newPage()
      r.cutProven = true
      for (const u of ['https://web.nutflix.xyz/', `https://${ALPHA_IP}/`]) {
        try { await probe.goto(u, { timeout: 10_000 }); r.cutProven = false } catch {}
      }
      await probe.close().catch(() => undefined)
      if (!r.cutProven) throw new Error('alpha answered: the cut does not hold')
      await networkListing(page, r, ms)
    }
    await page.evaluate((h) => { location.hash = h }, `#/watch/${VIDEO}`)
    const play = page.locator('.nf-nfxwatch__start button')
    await play.waitFor({ timeout: 90_000 })
    r.button = ms()
    if (mode === 'settled' || mode === 'nortc') {
      const until = Date.now() + 75_000
      while (r.seeder === null && Date.now() < until) await page.waitForTimeout(100)
      if (r.seeder === null) throw new Error('no seeder beacon within 75 s')
      await page.waitForTimeout(250)
    }
    r.click = ms()
    await play.click({ timeout: 15_000 })
    const at = (n) => page.waitForFunction((x) => {
      const v = document.querySelector('video.nf-nfxwatch__video')
      return v instanceof HTMLVideoElement && v.currentTime > x
    }, n, { timeout: 150_000, polling: 50 })
    await at(0)
    r.playing = ms()
    r.rtcBytesAtFirstFrame = await rtcBytes(page)
    await at(8)
    r.past8 = ms()
    r.rtcBytesAt8s = await rtcBytes(page)
    r.ok = await page.locator('.nf-nfxwatch__problem--stopped').count() === 0
  } catch (e) {
    r.problem = short(e.message.split('\n')[0])
    r.shown = short(await page.locator('.nf-nfxwatch__problems').first().innerText({ timeout: 1000 }).catch(() => ''))
  }
  r.pairs = await rtcPairs(page)
  const c = await page.evaluate(() => { const x = window.__rtc; return x ? { count: x.count, created: x.created, gathered: x.gathered, connected: x.connected, channel: x.channel, cut: x.cut } : null }).catch(() => null)
  if (c) r.rtc = { count: c.count, created: c.created && c.created - t0, gathered: c.gathered && c.gathered - t0, connected: c.connected && c.connected - t0, channel: c.channel && c.channel - t0, ...(cut ? { cut: c.cut } : {}) }
  if (mode === 'alphaoff') {
    // The drill's verdict, part by part, so "lists, but does not play yet" is recorded as such.
    r.listOk = r.listed !== null
    r.playOk = r.ok && r.past8 !== null && (r.rtcBytesAt8s ?? 0) > 0
    r.alphaFree = r.alphaOk === 0
    r.ok = r.cutProven === true && r.listOk && r.playOk && r.alphaFree
  }
  await ctx.close().catch(() => undefined)
  return r
}

const ARGS = ['--autoplay-policy=no-user-gesture-required']
if (cut) ARGS.push(`--host-resolver-rules=MAP *.nutflix.xyz ${noNames ? '~NOTFOUND' : '192.0.2.1'}`)
const browser = await chromium.launch({ args: ARGS })
const noRtc = await chromium.launch({ args: [...ARGS, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] })
let bad = 0
try {
  const plan = [...Array(opt('--cold', 3)).fill('cold'), ...Array(opt('--settled', 2)).fill('settled'), ...Array(opt('--nortc', 2)).fill('nortc'), ...Array(opt('--alphaoff', 0)).fill('alphaoff')]
  for (const mode of plan) {
    const r = await once(mode === 'nortc' ? noRtc : browser, mode)
    if (!r.ok) bad++
    const clickToPlay = r.playing !== null ? r.playing - r.click : null
    const beaconWait = r.seeder !== null && r.click !== null ? Math.max(0, r.seeder - r.click) : null
    const afterBeacon = r.playing !== null && r.seeder !== null ? r.playing - Math.max(r.click, r.seeder) : null
    const rtcConnectedVsFirstFrame = r.playing !== null && r.rtc?.connected ? r.rtc.connected - r.playing : null
    console.log('RUN ' + JSON.stringify({ base, ...r, clickToPlay, beaconWait, afterBeacon, rtcConnectedVsFirstFrame }))
  }
} finally {
  await browser.close()
  await noRtc.close()
}
process.exit(bad === 0 ? 0 : 1)
