// Does the Nutflix page really PLAY at a URL, and where does the startup time go? Headless Chromium
// (Playwright, a fresh context per run, never a real profile), inside a throwaway Kata VM:
// proof/playback-vm.sh. Nothing here signs or publishes.
//
//   node playback.mjs <https base> [--cold N] [--settled N] [--nortc N]
//     cold     open the page, go to the video, press Play as soon as the button shows: what a viewer gets
//     settled  press Play only after the seeder's beacon has arrived: the startup WITHOUT the wait for a
//              beacon (beacons are ephemeral, republished every 60 s, and never stored)
//     nortc    settled, in a browser whose WebRTC cannot use UDP, so no peer connection can form: if
//              this starts as fast as `settled`, WebRTC is not what delays the first frame
// One `RUN {json}` line per run, all times in ms from navigation:
//   dom, rendered   the page parsed; the app drew into #root
//   button          the video's page is up (its Play button)
//   click           Play pressed
//   seeder          the first beacon frame from the nfxweb seeder
//   firstOrigin     the first request to the HTTPS origin
//   playing         the first frame (currentTime > 0)
//   past8           currentTime > 8 s: it really plays
//   rtc             the first peer connection created, ICE gathered, connected, data channel open;
//                   rtcBytesAtFirstFrame / rtcBytesAt8s: bytes received over WebRTC by then
import { chromium } from 'playwright'

const VIDEO = '38504:fcbe23d9ff9a65b43163612decd68137a498e69663741b4689e5022bfced03c0:nfx:testnet:1:big-buck-bunny'
const SEEDER = '4f7c9958a276d245a3e6811e9ecca567457a2c4901170be27463ac2b3fcc9213'
const ORIGIN = 'https://web.nutflix.xyz/o'
const BEACON_KIND = '"kind":20464'

const argv = process.argv.slice(2)
const base = argv[0]
const opt = (k, d) => { const i = argv.indexOf(k); return i > 0 ? Number(argv[i + 1]) : d }
if (!base || !/^https:\/\/[a-z0-9.-]+\/?$/.test(base)) { console.error('usage: node playback.mjs <https base> [--cold N] [--settled N] [--nortc N]'); process.exit(2) }
const short = (s, n = 160) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, n)

/** Installed before any page script: every peer connection's first milestones, as absolute times. */
function watchRtc () {
  const rtc = { count: 0, created: null, gathered: null, connected: null, channel: null, pcs: [] }
  window.__rtc = rtc
  const P = window.RTCPeerConnection
  if (!P) return
  const opened = (d) => d.addEventListener('open', () => { rtc.channel ??= Date.now() })
  window.RTCPeerConnection = class extends P {
    constructor (...a) {
      super(...a)
      rtc.count++
      rtc.pcs.push(this)
      rtc.created ??= Date.now()
      this.addEventListener('icegatheringstatechange', () => { if (this.iceGatheringState === 'complete') rtc.gathered ??= Date.now() })
      this.addEventListener('connectionstatechange', () => { if (this.connectionState === 'connected') rtc.connected ??= Date.now() })
      this.addEventListener('datachannel', (e) => opened(e.channel))
    }
    createDataChannel (...a) { const d = super.createDataChannel(...a); opened(d); return d }
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

async function once (browser, mode) {
  const ctx = await browser.newContext()
  await ctx.addInitScript(watchRtc)
  const page = await ctx.newPage()
  const t0 = Date.now()
  const ms = () => Date.now() - t0
  const r = { mode, ok: false, dom: null, rendered: null, button: null, click: null, seeder: null, beaconFrames: 0, firstOrigin: null, originRequests: 0, playing: null, past8: null, rtcBytesAtFirstFrame: null, rtcBytesAt8s: null, rtc: null, problem: null, errors: [], csp: [] }
  page.on('pageerror', (e) => { if (r.errors.length < 3) r.errors.push(short(e)) })
  page.on('console', (m) => { if (/Content[- ]Security[- ]Policy|Refused to/i.test(m.text()) && r.csp.length < 3) r.csp.push(short(m.text())) })
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    const s = typeof f.payload === 'string' ? f.payload : ''
    if (!s.includes(BEACON_KIND)) return
    r.beaconFrames++
    if (r.seeder === null && s.includes(SEEDER)) r.seeder = ms()
  }))
  ctx.on('request', (q) => { if (q.url().startsWith(ORIGIN)) { r.originRequests++; if (r.firstOrigin === null) r.firstOrigin = ms() } })
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    r.dom = ms()
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0, null, { timeout: 60_000 })
    r.rendered = ms()
    await page.evaluate((h) => { location.hash = h }, `#/watch/${VIDEO}`)
    const play = page.locator('.nf-nfxwatch__start button')
    await play.waitFor({ timeout: 90_000 })
    r.button = ms()
    if (mode !== 'cold') {
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
  const c = await page.evaluate(() => { const x = window.__rtc; return x ? { count: x.count, created: x.created, gathered: x.gathered, connected: x.connected, channel: x.channel } : null }).catch(() => null)
  if (c) r.rtc = { count: c.count, created: c.created && c.created - t0, gathered: c.gathered && c.gathered - t0, connected: c.connected && c.connected - t0, channel: c.channel && c.channel - t0 }
  await ctx.close().catch(() => undefined)
  return r
}

const ARGS = ['--autoplay-policy=no-user-gesture-required']
const browser = await chromium.launch({ args: ARGS })
const noRtc = await chromium.launch({ args: [...ARGS, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] })
let bad = 0
try {
  const plan = [...Array(opt('--cold', 3)).fill('cold'), ...Array(opt('--settled', 2)).fill('settled'), ...Array(opt('--nortc', 2)).fill('nortc')]
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
