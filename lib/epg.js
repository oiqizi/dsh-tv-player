/**
 * lib/epg.js — EPG（电子节目单，XMLTV）抓取与解析模块（纯 Node，零第三方依赖）。
 *
 * 数据源：fanmingming/live 的 e.xml（XMLTV 格式，社区维护、开放数据）。文件较大（~5MB）、
 * 连接偶发抖动，因此抓取后落盘缓存（~/.dsh/tv-player-epg.json），TTL 内复用；
 * 抓取失败退回缓存（宁可显示稍旧的节目，也不清空）。
 *
 * 解析目标：只取「正在播出」的节目（now ∈ [start, stop)），按 EPG 频道名归一为
 * epgMatchKey 索引，供 Host 端与频道目录（channelKey）对齐后下发给浏览器。
 * 合规：EPG 为开放数据，仅供个人收看参考；不二次分发。
 */

import { epgMatchKey } from './channels.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 dsh-tv-player/0.1'

/** 从 XMLTV 文本解析出 { [epgKey]: { title, start, stop } }（仅当前节目）。 */
export function parseEpg(text, now = Date.now()) {
  const out = {}
  const raw = String(text || '')
  // 逐条 <programme>：channel / start / stop / title。
  const re = /<programme\s+channel="([^"]*)"\s+start="([^"]*)"\s+stop="([^"]*)">([\s\S]*?)<\/programme>/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const channel = m[1]
    const start = parseXmltvTime(m[2])
    const stop = parseXmltvTime(m[3])
    if (start === null || stop === null) continue
    if (now < start || now >= stop) continue // 只保留当前在播
    const title = (m[4].match(/<title[^>]*>([^<]*)<\/title>/) || [])[1] || ''
    const t = String(title).trim()
    if (t === '') continue
    const key = epgMatchKey(channel)
    // 同一 key 多条（同频道多语言/多源）：只保留第一条（通常是最匹配的）。
    if (!(key in out)) out[key] = { title: t, start, stop }
  }
  return out
}

/** XMLTV 时间 "20260929180000 +0800" → epoch ms（失败返回 null）。 */
function parseXmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s+([+-]\d{4})?$/.exec(String(s || ''))
  if (!m) return null
  const [, Y, Mo, D, H, Mi, Se] = m
  // 按 UTC 构造后减去时区偏移（把 +0800 还原为 UTC epoch）。
  const utcMs = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +Se)
  const tz = m[7]
  if (tz) {
    const sign = tz[0] === '-' ? -1 : 1
    const offMin = (+tz.slice(1, 3)) * 60 + (+tz.slice(3, 5))
    return utcMs - sign * offMin * 60000
  }
  return utcMs
}

async function fetchWithTimeout(url, fetchImpl, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal, redirect: 'follow' })
    if (!r.ok) throw new Error('epg http ' + r.status)
    return await r.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 抓取并解析 EPG，带落盘缓存。返回 { programs: {epgKey: {title,start,stop}}, fetchedAt }。
 * 抓取失败时退回缓存（stale 也可用）；无缓存则返回空。
 * @param {object} opts { epgUrl, epgTtlMs, timeoutMs, cacheFile, fetchImpl }
 */
export async function fetchEpg(opts = {}) {
  const epgUrl = opts.epgUrl
  const ttl = opts.epgTtlMs ?? 6 * 60 * 60 * 1000
  const timeoutMs = opts.timeoutMs ?? 20000
  const cacheFile = opts.cacheFile || null
  const fetchImpl = opts.fetchImpl || fetch

  // 读缓存
  let cached = null
  if (cacheFile) {
    try {
      const { readFileSync, existsSync } = await import('node:fs')
      if (existsSync(cacheFile)) {
        const data = JSON.parse(readFileSync(cacheFile, 'utf8'))
        if (data && typeof data === 'object' && data.programs) cached = data
      }
    } catch { cached = null }
  }
  if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt < ttl) return cached

  // 抓取（失败退缓存）
  try {
    const text = await fetchWithTimeout(epgUrl, fetchImpl, timeoutMs)
    const programs = parseEpg(text)
    const result = { programs, fetchedAt: Date.now() }
    if (cacheFile) {
      try {
        const { writeFileSync, mkdirSync } = await import('node:fs')
        const { dirname } = await import('node:path')
        mkdirSync(dirname(cacheFile), { recursive: true })
        writeFileSync(cacheFile, JSON.stringify(result), 'utf8')
      } catch { /* best-effort */ }
    }
    return result
  } catch {
    return cached || { programs: {}, fetchedAt: 0 }
  }
}

export default { parseEpg, fetchEpg }
