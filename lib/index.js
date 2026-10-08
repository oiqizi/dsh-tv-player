/**
 * dsh-tv-player — DSH 电视插件（Host 半体）。
 *
 * 参考 dsh-music-player 的双面结构：本模块运行在 Host 进程，负责——
 *   1. 直播频道目录（lib/channels.js）：内置兜底目录 + 拉取社区每日更新的 IPTV m3u，
 *      解析央视 / 凤凰卫视 / 卫视频道并合并去重；
 *   2. 同源直播流代理（lib/proxy.js）：`/dsh-tv/playlist`（重写 m3u8 分片 URL 到同源）
 *      与 `/dsh-tv/segment`（分片逐字节透传），规避上游无 CORS 导致的跨域问题；
 *   3. `tv_play` 模型工具：agent 按频道名/关键词开播、暂停/继续/停止/静音/换台；
 *   4. 少量偏好持久化（音量/静音/上次频道）到 ~/.dsh/tv-player-prefs.json。
 *
 * 浏览器半体（lib/client.js）用 `<video>` + 内嵌 hls.js 播放经本代理的 HLS 直播流，
 * 通过轮询 `/dsh-tv/intent` 接收工具下发的播放意图。
 *
 * 合规：播放各电视台/运营商公开直播流，目录为开放数据；不录制、不二次分发、不绕过
 * 付费墙/DRM，内容版权归电视台/版权方。仅供个人收看/学习使用，不构成任何建议。
 * @module dsh-tv-player
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { exec } from 'node:child_process'
import os from 'node:os'
import { Config, resolveConfig } from './config.js'
import * as Channels from './channels.js'
import * as Proxy from './proxy.js'
import * as Epg from './epg.js'

export const name = 'dsh-tv-player'

/** Hard services: the HTTP server (routes) and the tool registry. */
export const inject = ['webServer', 'tools']

export { Config, resolveConfig } from './config.js'
export * as Channels from './channels.js'
export * as Proxy from './proxy.js'

/** 工具支持的播放动作。 */
const PLAY_ACTIONS = ['play', 'pause', 'resume', 'stop', 'mute', 'unmute', 'next', 'prev']

/** 直播流是否为 HLS(m3u8)。 */
function looksLikeM3u8(u) {
  return /\.m3u8($|\?)/i.test(String(u || ''))
}

/** 挂载插件：解析配置、注册 HTTP 路由与 tv_play 工具。 */
export async function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const logger = ctx.logger(name)
  if (!resolved.enabled) {
    logger.info('disabled: enabled is false — no TV capabilities are mounted')
    return
  }

  // ---- 状态 ----
  let pendingIntent = null
  let catalog = { channels: Channels.CURATED_CHANNELS.map((c) => {
    const urls = Array.isArray(c.urls) && c.urls.length > 0 ? c.urls : [c.url]
    return { ...c, id: Channels.channelKey(c.name), source: 'curated', url: urls[0], urls }
  }), source: '精选频道', fetchedAt: 0 }
  let catalogPromise = null

  // ---- 偏好持久化（~/.dsh/tv-player-prefs.json）----
  const prefsFile = () => {
    const home = (typeof os !== 'undefined' && os.homedir) ? os.homedir() : ''
    const base = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) || (home === '' ? null : home + '/.dsh')
    return base === null ? null : base + '/tv-player-prefs.json'
  }
  let prefs = { volume: 1, muted: false, lastChannel: null }
  const loadPrefs = () => {
    const file = prefsFile()
    if (file === null) return
    try {
      if (!existsSync(file)) return
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (data && typeof data === 'object') {
        if (typeof data.volume === 'number' && Number.isFinite(data.volume)) prefs.volume = Math.max(0, Math.min(1, data.volume))
        if (typeof data.muted === 'boolean') prefs.muted = data.muted
        if (data.lastChannel && typeof data.lastChannel === 'object') prefs.lastChannel = data.lastChannel
      }
    } catch { /* best-effort */ }
  }
  const savePrefs = async () => {
    const file = prefsFile()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(prefs, null, 2) + '\n', 'utf8')
    } catch { /* best-effort */ }
  }

  // ---- 收藏频道（~/.dsh/tv-player-favs.json，按频道稳定键持久化）----
  const dshFile = (name) => {
    const home = (typeof os !== 'undefined' && os.homedir) ? os.homedir() : ''
    const base = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) || (home === '' ? null : home + '/.dsh')
    return base === null ? null : base + '/' + name
  }

  let favs = new Set()
  const loadFavs = () => {
    const file = dshFile('tv-player-favs.json')
    if (file === null) return
    try {
      if (!existsSync(file)) return
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (data && Array.isArray(data.favs)) favs = new Set(data.favs.filter((x) => typeof x === 'string' && x !== ''))
    } catch { /* best-effort */ }
  }
  const saveFavs = async () => {
    const file = dshFile('tv-player-favs.json')
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ favs: [...favs] }, null, 2) + '\n', 'utf8')
    } catch { /* best-effort */ }
  }

  // ---- 自定义 m3u 源（~/.dsh/tv-player-sources.json）----
  let customSources = []
  const loadCustomSources = () => {
    const file = dshFile('tv-player-sources.json')
    if (file === null) return
    try {
      if (!existsSync(file)) return
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (data && Array.isArray(data.sources)) customSources = data.sources.filter((x) => typeof x === 'string' && /^https?:\/\//.test(x))
    } catch { /* best-effort */ }
  }
  const saveCustomSources = async () => {
    const file = dshFile('tv-player-sources.json')
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ sources: customSources }, null, 2) + '\n', 'utf8')
    } catch { /* best-effort */ }
  }

  // ---- 最近播放（~/.dsh/tv-player-recent.json，最多 12 条）----
  let recent = []
  const loadRecent = () => {
    const file = dshFile('tv-player-recent.json')
    if (file === null) return
    try {
      if (!existsSync(file)) return
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (data && Array.isArray(data.recent)) {
        recent = data.recent.filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.url === 'string').slice(0, 12)
      }
    } catch { /* best-effort */ }
  }
  const saveRecent = async () => {
    const file = dshFile('tv-player-recent.json')
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ recent }, null, 2) + '\n', 'utf8')
    } catch { /* best-effort */ }
  }
  const recordRecent = (ch) => {
    if (!ch || typeof ch.id !== 'string') return
    recent = [{ id: ch.id, name: ch.name, url: ch.url, group: ch.group || 'other' }, ...recent.filter((x) => x.id !== ch.id)].slice(0, 12)
    void saveRecent()
  }

  // ---- EPG 节目单（内存缓存 + 落盘缓存见 lib/epg.js）----
  let epgCache = { programs: {}, fetchedAt: 0 }
  let epgPromise = null
  const ensureEpg = () => {
    if (epgPromise !== null) return epgPromise
    epgPromise = Epg.fetchEpg({
      epgUrl: resolved.epgUrl,
      epgTtlMs: resolved.epgTtlMs,
      timeoutMs: 25000,
      cacheFile: dshFile('tv-player-epg.json'),
      fetchImpl: fetch,
    }).then((r) => { epgCache = r; return r }).finally(() => { epgPromise = null })
    return epgPromise
  }

  // ---- 「搜索频道」用公开源目录（拉取一次 + TTL 缓存，供 /dsh-tv/search 搜索）----
  let searchCatalog = { channels: [], source: '', fetchedAt: 0 }
  let searchCatalogPromise = null
  const ensureSearchCatalog = (force = false) => {
    if (!force && searchCatalog.fetchedAt !== 0 && Date.now() - searchCatalog.fetchedAt < 30 * 60 * 1000) return Promise.resolve(searchCatalog)
    if (searchCatalogPromise !== null) return searchCatalogPromise
    searchCatalogPromise = Channels.fetchCatalog({
      sources: Channels.SEARCH_SOURCES,
      timeoutMs: 20000,
      fetchImpl: fetch,
      whitelist: false, // 搜索要返回全部可播放频道，不受稳定白名单限制
    }).then((r) => { searchCatalog = r; return r }).finally(() => { searchCatalogPromise = null })
    return searchCatalogPromise
  }

  // ---- 定时换台（~/.dsh/tv-player-schedule.json）----
  // Host 端 Node 定时器自维护，脱离会话存活；到点下发播放意图（客户端轮询领取）。
  let schedule = []
  const loadSchedule = () => {
    const file = dshFile('tv-player-schedule.json')
    if (file === null) return
    try {
      if (!existsSync(file)) return
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (data && Array.isArray(data.schedule)) {
        schedule = data.schedule
          .filter((r) => r && typeof r.time === 'string' && /^\d{2}:\d{2}$/.test(r.time))
          .map((r) => ({
            id: typeof r.id === 'string' ? r.id : 's' + Math.random().toString(36).slice(2),
            time: r.time,
            weekdays: Array.isArray(r.weekdays) ? r.weekdays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) : [],
            action: ['switch', 'tvoff', 'shutdown'].includes(r.action) ? r.action : 'switch',
            channelId: typeof r.channelId === 'string' ? r.channelId : '',
            channelName: typeof r.channelName === 'string' ? r.channelName : '',
            channelUrl: typeof r.channelUrl === 'string' ? r.channelUrl : '',
            enabled: r.enabled !== false,
            lastFiredMinute: 0,
          }))
      }
    } catch { /* best-effort */ }
  }
  const saveSchedule = async () => {
    const file = dshFile('tv-player-schedule.json')
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const clean = schedule.map(({ lastFiredMinute, ...rest }) => rest)
      writeFileSync(file, JSON.stringify({ schedule: clean }, null, 2) + '\n', 'utf8')
    } catch { /* best-effort */ }
  }
  const publicSchedule = () => schedule.map(({ lastFiredMinute, ...r }) => r)

  // 到点触发：换台 / 关电视 / 关电脑。
  const fireSchedule = async (rule) => {
    if (rule.action === 'tvoff') {
      // 关电视：下发 stop 意图，客户端停止播放。
      pendingIntent = { action: 'stop' }
      logger.info('schedule fired: 关电视 @ ' + rule.time)
      return
    }
    if (rule.action === 'shutdown') {
      // 关电脑：30 秒后关机（到点可运行 shutdown /a 取消）。
      try {
        exec('shutdown /s /t 30', (err) => {
          if (err) logger.info('shutdown failed: ' + String((err && err.message) || err))
          else logger.info('shutdown scheduled (30s) @ ' + rule.time)
        })
      } catch (e) { logger.info('shutdown error: ' + String(e)) }
      return
    }
    // switch（换台）：优先目录里的新 URL，退存储的 URL。
    const cat = await ensureCatalog()
    const ch = cat.channels.find((c) => c.id === rule.channelId)
      || cat.channels.find((c) => c.name === rule.channelName)
      || null
    if (ch) {
      pendingIntent = { action: 'play', kind: 'tv', id: ch.id, name: ch.name, url: ch.url, group: ch.group, logo: ch.logo || '' }
      recordRecent(ch)
    } else if (rule.channelUrl) {
      pendingIntent = { action: 'play', kind: 'tv', id: rule.channelId, name: rule.channelName, url: rule.channelUrl, group: 'other', logo: '' }
      recordRecent({ id: rule.channelId, name: rule.channelName, url: rule.channelUrl, group: 'other' })
    }
  }

  const checkSchedule = async () => {
    if (schedule.length === 0) return
    const now = new Date()
    const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
    const dow = now.getDay() === 0 ? 7 : now.getDay() // ISO: 周一=1..周日=7
    const minute = Math.floor(now.getTime() / 60000)
    for (const rule of schedule) {
      if (!rule.enabled || rule.time !== hm) continue
      if (rule.weekdays.length > 0 && !rule.weekdays.includes(dow)) continue
      if (rule.lastFiredMinute === minute) continue
      rule.lastFiredMinute = minute
      void saveSchedule()
      await fireSchedule(rule)
      logger.info('schedule fired: ' + (rule.channelName || rule.channelId) + ' @ ' + hm)
    }
  }

  // ---- 频道目录（懒拉取 + TTL 缓存）----
  const ensureCatalog = async (force = false) => {
    const ttl = resolved.catalogTtlMs
    if (!force && catalog.fetchedAt !== 0 && Date.now() - catalog.fetchedAt < ttl) return catalog
    if (catalogPromise !== null) return catalogPromise
    catalogPromise = (async () => {
      try {
        const fresh = await Channels.fetchCatalog({
          sources: [...resolved.sources, ...customSources],
          timeoutMs: resolved.timeoutMs,
          fetchImpl: fetch,
        })
        if (fresh.channels.length > 0) catalog = fresh
        else catalog = { channels: catalog.channels, source: 'curated 兜底（在线源空）', fetchedAt: Date.now() }
      } catch (err) {
        logger.info('catalog fetch failed, fall back to curated: ' + String((err && err.message) || err))
        catalog = { channels: catalog.channels, source: 'curated 兜底（在线源失败）', fetchedAt: Date.now() }
      }
      if (resolved.maxChannels > 0 && catalog.channels.length > resolved.maxChannels) {
        catalog = { ...catalog, channels: catalog.channels.slice(0, resolved.maxChannels) }
      }
      return catalog
    })().finally(() => { catalogPromise = null })
    return catalogPromise
  }

  // ---- HTTP 小工具 ----
  const writeJson = (res, value, status) => {
    res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  const readBody = async (req) => {
    // 收集 Buffer 块再拼接，避免多字节 UTF-8 字符被按 chunk 边界截断（否则中文名会乱码）。
    const chunks = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (chunks.length === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8')
    try { return JSON.parse(text) } catch { return {} }
  }
  const playlistHeaders = (extra = {}) => ({
    'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extra,
  })

  // 拉上游 m3u8 文本（带重试；防盗链站带 Referer=origin）。
  const fetchPlaylistText = async (upstream) => {
    const ref = (() => { try { return new URL(upstream).origin } catch { return '' } })()
    let lastErr = null
    for (let attempt = 0; attempt <= resolved.retries; attempt++) {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), resolved.timeoutMs)
        try {
          const r = await fetch(upstream, {
            headers: { 'User-Agent': 'Mozilla/5.0 dsh-tv-player/0.1', Referer: ref },
            redirect: 'follow',
            signal: ctrl.signal,
          })
          if (!r.ok) throw new Error('upstream playlist http ' + r.status)
          return await r.text()
        } finally { clearTimeout(timer) }
      } catch (err) { lastErr = err }
    }
    throw new Error('playlist fetch failed: ' + String((lastErr && lastErr.message) || lastErr))
  }

  // ---- 路由处理 ----
  const serve = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x')
      const pathname = url.pathname

      // 插件清单：版本 + 分组 + 频道数（客户端启动时取一次）。
      if (pathname === '/dsh-tv/manifest' && req.method === 'GET') {
        const cat = await ensureCatalog()
        const byGroup = {}
        for (const c of cat.channels) byGroup[c.group] = (byGroup[c.group] || 0) + 1
        writeJson(res, {
          ok: true,
          name,
          groups: Channels.GROUP_LABELS,
          counts: byGroup,
          channelCount: cat.channels.length,
          source: cat.source,
        })
        return
      }

      // 频道目录（客户端列表数据源）。
      if (pathname === '/dsh-tv/channels' && req.method === 'GET') {
        const force = url.searchParams.get('refresh') === '1'
        const cat = await ensureCatalog(force)
        writeJson(res, { ok: true, channels: cat.channels, source: cat.source, fetchedAt: cat.fetchedAt })
        return
      }

      // 播放意图（客户端每 2s 轮询一次）。
      if (pathname === '/dsh-tv/intent' && req.method === 'GET') {
        const it = pendingIntent
        pendingIntent = null
        writeJson(res, it || null)
        return
      }

      // 偏好读写。
      if (pathname === '/dsh-tv/prefs' && req.method === 'GET') {
        loadPrefs()
        writeJson(res, { ok: true, prefs })
        return
      }
      if (pathname === '/dsh-tv/prefs' && req.method === 'POST') {
        const body = await readBody(req)
        if (typeof body.volume === 'number' && Number.isFinite(body.volume)) prefs.volume = Math.max(0, Math.min(1, body.volume))
        if (typeof body.muted === 'boolean') prefs.muted = body.muted
        if (body.lastChannel && typeof body.lastChannel === 'object') prefs.lastChannel = body.lastChannel
        await savePrefs()
        writeJson(res, { ok: true, prefs })
        return
      }

      // 收藏频道（按频道稳定键）。
      if (pathname === '/dsh-tv/favs' && req.method === 'GET') {
        loadFavs()
        writeJson(res, { ok: true, favs: [...favs] })
        return
      }
      if (pathname === '/dsh-tv/favs/toggle' && req.method === 'POST') {
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        if (id === '') { writeJson(res, { ok: false, error: 'missing id' }, 400); return }
        if (favs.has(id)) favs.delete(id); else favs.add(id)
        await saveFavs()
        writeJson(res, { ok: true, favs: [...favs], on: favs.has(id) })
        return
      }

      // 搜索频道：从公开源查找可播放（AAC）频道，按名称匹配；空查询则返回可浏览列表。
      if (pathname === '/dsh-tv/search' && req.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim()
        const refresh = url.searchParams.get('refresh') === '1'
        const cat = await ensureSearchCatalog(refresh)
        let results
        if (q === '') {
          // 自动浏览：央视→卫视→凤凰，组内按名称排序，限量 120。
          const order = { cctv: 0, satellite: 1, phoenix: 2, other: 3 }
          results = [...cat.channels]
            .sort((a, b) => ((order[a.group] ?? 4) - (order[b.group] ?? 4)) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
            .slice(0, 120)
        } else {
          results = Channels.searchChannels(q, cat.channels)
        }
        writeJson(res, { ok: true, q, results, source: cat.source })
        return
      }
      if (pathname === '/dsh-tv/sources' && req.method === 'GET') {
        loadCustomSources()
        writeJson(res, { ok: true, custom: customSources, defaults: resolved.sources })
        return
      }
      if (pathname === '/dsh-tv/sources' && req.method === 'POST') {
        const body = await readBody(req)
        const src = typeof body.url === 'string' ? body.url.trim() : ''
        if (!/^https?:\/\//.test(src)) { writeJson(res, { ok: false, error: 'bad url' }, 400); return }
        if (!customSources.includes(src)) customSources.push(src)
        await saveCustomSources()
        catalog.fetchedAt = 0
        writeJson(res, { ok: true, custom: customSources })
        return
      }
      if (pathname === '/dsh-tv/sources/remove' && req.method === 'POST') {
        const body = await readBody(req)
        const src = typeof body.url === 'string' ? body.url : ''
        customSources = customSources.filter((x) => x !== src)
        await saveCustomSources()
        catalog.fetchedAt = 0
        writeJson(res, { ok: true, custom: customSources })
        return
      }

      // 最近播放（面板顶部「🕘 最近播放」分组）。
      if (pathname === '/dsh-tv/recent' && req.method === 'GET') {
        loadRecent()
        writeJson(res, { ok: true, recent })
        return
      }
      if (pathname === '/dsh-tv/recent' && req.method === 'POST') {
        const body = await readBody(req)
        if (body && body.id && body.name && body.url) {
          recordRecent({ id: body.id, name: body.name, url: body.url, group: body.group || 'other' })
        }
        writeJson(res, { ok: true, recent })
        return
      }

      // EPG 节目单：把 EPG 与频道目录对齐，按频道 id 下发当前节目。
      if (pathname === '/dsh-tv/epg' && req.method === 'GET') {
        const cat = await ensureCatalog()
        const epg = await ensureEpg()
        const programs = {}
        for (const ch of cat.channels) {
          const p = epg.programs[Channels.epgMatchKey(ch.name)]
          if (p) programs[ch.id] = p
        }
        writeJson(res, { ok: true, programs, fetchedAt: epg.fetchedAt })
        return
      }

      // 定时换台（规则读写/删除/启停/立即执行）。
      if (pathname === '/dsh-tv/schedule' && req.method === 'GET') {
        loadSchedule()
        writeJson(res, { ok: true, schedule: publicSchedule() })
        return
      }
      if (pathname === '/dsh-tv/schedule' && req.method === 'POST') {
        const body = await readBody(req)
        const time = typeof body.time === 'string' ? body.time.trim() : ''
        const weekdays = Array.isArray(body.weekdays) ? body.weekdays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) : []
        const action = ['switch', 'tvoff', 'shutdown'].includes(body.action) ? body.action : 'switch'
        const channelId = typeof body.channelId === 'string' ? body.channelId : ''
        const channelName = typeof body.channelName === 'string' ? body.channelName : ''
        const channelUrl = typeof body.channelUrl === 'string' ? body.channelUrl : ''
        if (!/^\d{2}:\d{2}$/.test(time)) { writeJson(res, { ok: false, error: 'bad schedule' }, 400); return }
        if (action === 'switch' && channelId === '' && channelUrl === '') { writeJson(res, { ok: false, error: 'bad schedule' }, 400); return }
        schedule.push({ id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), time, weekdays, action, channelId, channelName, channelUrl, enabled: true, lastFiredMinute: 0 })
        await saveSchedule()
        writeJson(res, { ok: true, schedule: publicSchedule() })
        return
      }
      if (pathname === '/dsh-tv/schedule/remove' && req.method === 'POST') {
        const body = await readBody(req)
        schedule = schedule.filter((r) => r.id !== body.id)
        await saveSchedule()
        writeJson(res, { ok: true, schedule: publicSchedule() })
        return
      }
      if (pathname === '/dsh-tv/schedule/toggle' && req.method === 'POST') {
        const body = await readBody(req)
        const rule = schedule.find((r) => r.id === body.id)
        if (rule) { rule.enabled = !rule.enabled; await saveSchedule() }
        writeJson(res, { ok: true, schedule: publicSchedule() })
        return
      }
      if (pathname === '/dsh-tv/schedule/run-now' && req.method === 'POST') {
        const body = await readBody(req)
        const rule = schedule.find((r) => r.id === body.id)
        if (rule) await fireSchedule(rule)
        writeJson(res, { ok: true })
        return
      }

      // 内嵌 hls.js（客户端经 <script> 注入加载）。
      if (pathname === '/dsh-tv/vendor/hls.min.js' && req.method === 'GET') {
        try {
          const file = new URL('./vendor/hls.min.js', import.meta.url)
          const buf = readFileSync(file)
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
          })
          res.end(buf)
        } catch {
          res.writeHead(404); res.end('hls.min.js missing')
        }
        return
      }

      // ---- 同源直播流代理：播放列表重写 ----
      if (pathname === '/dsh-tv/playlist' && (req.method === 'GET' || req.method === 'HEAD')) {
        const upstream = url.searchParams.get('u') || ''
        if (!/^https?:\/\//.test(upstream)) { writeJson(res, { error: 'bad url' }, 400); return }
        try {
          const text = await fetchPlaylistText(upstream)
          const rewritten = Proxy.rewritePlaylist(text, upstream)
          res.writeHead(200, playlistHeaders({ 'X-DSH-TV-HLS': '1' }))
          if (req.method === 'HEAD') { res.end(); return }
          res.end(rewritten)
        } catch (err) {
          if (!res.headersSent) {
            writeJson(res, { error: '播放列表获取失败：' + String((err && err.message) || err) }, 502)
          } else if (!res.writableEnded && !res.destroyed) {
            try { res.end() } catch {}
          }
        }
        return
      }

      // ---- 同源直播流代理：分片透传 ----
      if (pathname === '/dsh-tv/segment' && (req.method === 'GET' || req.method === 'HEAD')) {
        const upstream = url.searchParams.get('u') || ''
        if (!/^https?:\/\//.test(upstream)) { writeJson(res, { error: 'bad url' }, 400); return }
        if (req.method === 'HEAD') {
          // HEAD：轻量可达性探测（不转发 body）。
          try {
            const ref = (() => { try { return new URL(upstream).origin } catch { return '' } })()
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), 8000)
            let r
            try {
              r = await fetch(upstream, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0 dsh-tv-player/0.1', Referer: ref }, signal: ctrl.signal })
            } finally { clearTimeout(timer) }
            res.writeHead(r.ok ? 200 : r.status, { 'Access-Control-Allow-Origin': '*' })
            res.end()
          } catch {
            res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); res.end()
          }
          return
        }
        // 分片流式直传（透传，不缓冲、不转码——保证低延迟）。
        await Proxy.forwardUpstream(upstream, res, fetch)
        return
      }

      // 未知路由。
      writeJson(res, { error: 'not found' }, 404)
    } catch (err) {
      try {
        if (!res.headersSent) writeJson(res, { error: String((err && err.message) || err) }, 500)
        else if (!res.writableEnded && !res.destroyed) res.end()
      } catch {}
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-tv', handler: serve }), 'dsh-tv-player: routes')

  // ---- model tool: tv_play ----
  const tool = {
    name: 'tv_play',
    description: '控制 DSH 电视插件播放直播频道。当前内置 8 个确定稳定频道：CCTV-9 纪录、CCTV-12 社会与法，以及卫视频道（浙江 / 延边 / 香港 / 内蒙古 / 河北 / 东方）。播放时可按频道名/关键词搜索并开播（如「CCTV-9」「浙江卫视」；不传 channel 则播放上次频道或第一个频道）；也可用 action 执行暂停/继续/停止/静音/取消静音/上一个频道/下一个频道。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: { type: 'string', description: '频道名/关键词，用于搜索并播放，如「CCTV-13」「凤凰卫视资讯台」「湖南卫视」。仅当 action 为 play（默认）时使用，可留空' },
        action: { type: 'string', enum: PLAY_ACTIONS, description: '要执行的动作：play 播放（默认）、pause 暂停、resume 继续、stop 停止、mute 静音、unmute 取消静音、next 下一个频道、prev 上一个频道' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          played: { type: 'boolean' },
          channel: { type: 'string' },
          matches: { type: 'number' },
          count: { type: 'number' },
          notice: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: (value && value.notice) || '电视插件未就绪' }]
      },
    },
    async execute(args) {
      const cat = await ensureCatalog()
      const channels = cat.channels || []
      const action = args && typeof args.action === 'string' && PLAY_ACTIONS.includes(args.action) ? args.action : 'play'

      // 非 play 动作：直接转发传输命令到浏览器播放器。
      if (action !== 'play') {
        pendingIntent = { action }
        const labels = {
          pause: '已请求暂停播放', resume: '已请求继续播放', stop: '已请求停止播放',
          mute: '已请求静音', unmute: '已请求取消静音',
          next: '已请求切换到下一个频道', prev: '已请求切换到上一个频道',
        }
        return { action, played: false, channel: '', matches: 0, count: channels.length, notice: labels[action] + '。若浏览器拦截自动操作，请在播放条上点击对应按钮。' }
      }

      const query = args && typeof args.channel === 'string' ? args.channel.trim() : ''
      let pick = null
      if (query !== '') {
        pick = Channels.matchChannel(channels, query)
        if (pick === null) {
          return { action, played: false, channel: '', matches: 0, count: channels.length, notice: '没有找到频道「' + query + '」。可用频道：CCTV-9 纪录、CCTV-12 社会与法、浙江卫视、延边卫视、香港卫视、内蒙古卫视、河北卫视、东方卫视。' }
        }
      } else {
        // 无关键词：优先上次频道，其次第一个（央视）频道。
        const lastId = prefs.lastChannel && prefs.lastChannel.id
        pick = (lastId && channels.find((c) => c.id === lastId)) || channels[0] || null
      }

      if (pick === null) {
        return { action, played: false, channel: '', matches: 0, count: 0, notice: '频道目录为空：在线源与兜底目录均无可用频道。请稍后在播放面板点「刷新频道」重试。' }
      }

      pendingIntent = { action: 'play', kind: 'tv', id: pick.id, name: pick.name, url: pick.url, group: pick.group, logo: pick.logo || '' }
      recordRecent(pick)
      const groupLabel = Channels.GROUP_LABELS[pick.group] || pick.group
      return {
        action, played: true, channel: pick.name, matches: 1, count: channels.length,
        notice: '已请求播放「' + pick.name + '」（' + groupLabel + '，共 ' + channels.length + ' 个频道）。浏览器可能拦截自动播放，请在播放条点击一次 ▶ 解锁。',
      }
    },
  }
  ctx.effect(() => ctx.tools.register(tool), 'dsh-tv-player: tv_play tool')

  // 启动即加载收藏/自定义源/最近播放/定时换台并预热目录（后台，不阻塞）。
  loadFavs()
  loadCustomSources()
  loadRecent()
  loadSchedule()
  void ensureCatalog().then((cat) => logger.info('catalog ready: ' + cat.channels.length + ' channels (' + cat.source + ')'))
  // EPG 预热（后台，不阻塞；失败静默退缓存）。
  void ensureEpg().catch(() => {})
  // 定时换台：Host 进程内 Node 定时器自维护（每 15s 检查一次，到点触发）。
  const scheduleTimer = setInterval(() => { void checkSchedule() }, 15000)
  ctx.effect(() => () => clearInterval(scheduleTimer), 'dsh-tv-player: schedule timer')
}
