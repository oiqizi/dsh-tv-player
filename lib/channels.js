/**
 * lib/channels.js — 直播频道目录模块（纯 Node，零第三方依赖）。
 *
 * 数据来源分两层：
 *   1) 内置「兜底目录」CURATED_CHANNELS：打包时实测可用的精选频道（央视 / 凤凰 / 主流卫视），
 *      保证在 GitHub 等目录源不可达时插件仍能开箱即用；
 *   2) 「在线目录」SOURCES：社区维护、每日更新的 IPTV m3u 列表（fanmingming/live 与
 *      best-fan/iptv-sources 等，开放数据）。启动/首次调用时拉取并解析，得到的实时
 *      直播 URL 优先于兜底目录（更「新鲜」，频道失效后会被每日更新纠正）。
 *
 * 合规：播放的是各电视台/运营商公开直播流，目录为开放数据；不录制、不二次分发、
 * 不绕过付费墙/DRM，内容版权归电视台/版权方。仅个人收看/学习使用。
 *
 * m3u 解析：逐行读取 #EXTINF 与后续 URI 行，抽取 tvg-name/tvg-logo/group-title 与
 * 显示名，按 group-title 归类（央视频道 / 卫视频道 / 凤凰 / 其他）。
 */

// 吉林电信 tsfile 源（222.169.85.8:9901，1080p AAC；晚高峰可能拥塞，仅作备用）。
const JL = (code) => 'http://222.169.85.8:9901/tsfile/live/' + code + '_1.m3u8?key=txiptv&playlive=1&authid=0'

// 精选频道目录：6 个稳定卫视 + CCTV-9/12（快的源排前面作主源）。
// 每个频道带多个候选流 URL（`urls`），播放时某个源失效会自动切换下一源。
// group: cctv(央视) | satellite(卫视) | other(其他)
export const CURATED_CHANNELS = [
  { id: 'sat-zj', name: '浙江卫视', group: 'satellite', urls: [
    'http://ali-xwl.cztv.com/live/channel011080Plxw.m3u8',
    'http://ali-xwl.cztv.com/live/channel01720Plxw.m3u8',
  ] },
  { id: 'sat-yb', name: '延边卫视', group: 'satellite', urls: [
    'https://srs.iyb983.cn/video/CYS/index.m3u8',
  ] },
  { id: 'sat-hk', name: '香港卫视', group: 'satellite', urls: [
    'https://hkstv.tv/api/m3u8-proxy?url=http%3A%2F%2Fwebcast.hkstv.tv%2Flivestream%2Fmutfysrq%2Fplaylist.m3u8',
  ] },
  { id: 'sat-nmg', name: '内蒙古卫视', group: 'satellite', urls: [
    'http://play1-qk.nmtv.cn/live/1769652018126032.m3u8',
  ] },
  { id: 'sat-hb', name: '河北卫视', group: 'satellite', urls: [
    'http://event.pull.hebtv.com/jishi/weishi_tingyun.m3u8',
  ] },
  { id: 'sat-df', name: '东方卫视', group: 'satellite', urls: [
    'http://bp-resource-dfl.bestv.cn/155/3/video.m3u8',
  ] },
  { id: 'cctv9', name: 'CCTV-9 纪录', group: 'cctv', urls: [
    'https://v4-e6b1c5baf4e240fe63adbf68dda23435.livehwc4.com/play.kankanlive.com/live/1698423397390920.m3u8?sub_m3u8=true&edge_slice=true&user_session_id=9418688afb7b99a56db1a3fb8f0fda52',
    JL('0009'),
  ] },
  { id: 'cctv12', name: 'CCTV-12 社会与法', group: 'cctv', urls: [
    'http://74.91.26.218:82/live/cctv12hd.m3u8',
    JL('0012'),
  ] },
]

// 最终目录白名单：只保留这些「确定稳定」的频道（过滤掉在线源里的其它频道）。
export const STABLE_WHITELIST = [
  'CCTV-9', 'CCTV-12',
  '浙江卫视', '延边卫视', '香港卫视', '内蒙古卫视', '河北卫视', '东方卫视',
]

// 在线目录源：默认关闭（只保留上面的 6 个精选卫视）。
// 如需扩充，可在播放面板底部「自定义 m3u 源」粘贴 IPTV 列表 URL，或在此数组加入。
export const SOURCES = []

// 「搜索频道」时使用的公开 IPTV 源（比精选目录更全，供按频道名查找可播放频道）。
export const SEARCH_SOURCES = [
  'https://cdn.jsdelivr.net/gh/best-fan/iptv-sources@master/cn_all_status.m3u8',
  'https://raw.githubusercontent.com/best-fan/iptv-sources/master/cn_all_status.m3u8',
]

/** 按名称/关键词在一个频道列表里搜索（供「搜索频道」用）。 */
export function searchChannels(query, channels) {
  const q = String(query || '').trim().toLowerCase()
  if (q === '') return []
  const qn = q.replace(/\s+/g, '')
  return (channels || []).filter((c) => {
    const name = String(c.name || '').toLowerCase()
    const key = String(c.id || '').toLowerCase()
    return name.includes(q) || name.replace(/\s+/g, '').includes(qn) || key.includes(qn)
  }).slice(0, 20)
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 dsh-tv-player/0.1'

// 频道分组显示名（客户端与 Host 共用语义）。
export const GROUP_LABELS = {
  cctv: '央视 CCTV',
  phoenix: '凤凰卫视 Phoenix',
  satellite: '卫视 Satellite',
  other: '其他 Other',
}

/** 归一化频道显示名：去掉冗余后缀/分辨率标记，便于去重与匹配。 */
export function normalizeName(name) {
  return String(name || '')
    .replace(/\[(?:1080|720|576|480|540)[pP]?\]?/g, '')
    .replace(/\((?:1080|720|576|480)p\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 把名称归类到 group。 */
export function classifyGroup(name, groupTitle) {
  const g = String(groupTitle || '').trim()
  const n = String(name || '')
  if (/凤凰|phoenix|ifeng/i.test(n) || /凤凰|phoenix|港台|香港|台湾/i.test(g)) return 'phoenix'
  if (/^CCTV[- ]?\d|央视|CGTN|中国教育/i.test(n) || /央视|中央/i.test(g)) return 'cctv'
  if (/卫视/i.test(n) || /卫视|卫星/i.test(g)) return 'satellite'
  return 'other'
}

/** 从名称里抽取画质档位（如「CCTV-1[1080]」「(720p)」「4K」）。 */
function extractQuality(name, tvgName) {
  const s = String(name || '') + ' ' + String(tvgName || '')
  if (/8k/i.test(s)) return '8K'
  if (/4k/i.test(s)) return '4K'
  const m = /\[(\d{3,4})[pP]?\]/.exec(s) || /\((\d{3,4})[pP]\)/.exec(s)
  if (m) return m[1] + 'p'
  return ''
}

/** 画质档位 → 数值分（越高越好，用于多源同名频道时保留高画质）。 */
export function qualityScore(q) {
  if (/8k/i.test(String(q || ''))) return 432
  if (/4k/i.test(String(q || ''))) return 216
  const m = /(\d{3,4})p/.exec(String(q || ''))
  return m ? parseInt(m[1], 10) / 10 : 0
}

/** 解析一段 m3u8 文本为归一化频道数组。 */
export function parseM3u(text) {
  const out = []
  let pending = null
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('#EXTINF')) {
      const mName = /tvg-name="([^"]*)"/i.exec(line)
      const mLogo = /tvg-logo="([^"]*)"/i.exec(line)
      const mGroup = /group-title="([^"]*)"/i.exec(line)
      const mTitle = /,(.*)$/.exec(line)
      const rawName = (mTitle ? mTitle[1] : (mName ? mName[1] : '')).trim()
      pending = {
        name: rawName,
        tvgName: mName ? mName[1] : '',
        logo: mLogo ? mLogo[1] : '',
        groupTitle: mGroup ? mGroup[1] : '',
      }
      continue
    }
    if (line === '' || line.startsWith('#')) continue
    if (!pending) continue
    if (!/^https?:\/\//i.test(line)) { pending = null; continue }
    // 过滤 IPv6 字面量主机（http://[2409:...]）：多数 IPv4-only 机器不可达，直接跳过。
    if (/^https?:\/\/\[/i.test(line)) { pending = null; continue }
    // 过滤 txiptv 的 tsfile/live 中继：这些源用 MP2/AC-3 音轨，浏览器 Chromium 解不了 → 有影无声。
    if (/\/tsfile\/live\//i.test(line) || /key=txiptv/i.test(line)) { pending = null; continue }
    const name = normalizeName(pending.name || pending.tvgName)
    if (name === '') { pending = null; continue }
    out.push({
      name,
      logo: pending.logo,
      group: classifyGroup(name, pending.groupTitle),
      url: line,
      source: 'live',
      quality: extractQuality(pending.name, pending.tvgName),
    })
    pending = null
  }
  return out
}

async function fetchWithTimeout(url, fetchImpl, timeoutMs, signal) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onAbort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const r = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal, redirect: 'follow' })
    if (!r.ok) throw new Error('catalog http ' + r.status)
    return await r.text()
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/** 频道稳定主键：去掉「卫视/电视/台/频道」等词组、标点与全部空格后的核心名，
 *  并对央视抽掉类型后缀（综合/新闻/体育赛事…），使「CCTV-1」与「CCTV-1 综合」归并为同一键。
 *  用作去重键、收藏键与「上次频道」持久化键——跨会话稳定（只要频道名不变）。 */
export function channelKey(name) {
  let n = normalizeName(name).replace(/[·\s\-_台频道卫视电视]/g, '').toLowerCase()
  // 「cctv数字(+)+中文后缀」→ 只保留「cctv数字(+)」；cctv4k/cctv8k 不受影响（k 非中文）。
  n = n.replace(/^(cctv\d+\+?)[\u4e00-\u9fa5]+$/, '$1')
  return n
}

/** EPG 频道匹配键：把频道名归一为与 EPG `<display-name>` 可对齐的核心标识。
 *  比 channelKey 更激进地抽掉「综合/财经/卫视」等后缀，使「CCTV-1 综合」↔「CCTV1」、
 *  「CCTV-5+ 体育赛事」↔「CCTV5+」、中文台/资讯台等能对上。 */
export function epgMatchKey(name) {
  let n = String(name || '').trim().toLowerCase().replace(/\s+/g, '')
  const m = /^cctv[-]?(\d+)(\+|plus)?/.exec(n)
  if (m) return 'cctv' + m[1] + (m[2] ? '+' : '')
  if (/cgtn/.test(n)) {
    const lang = n.replace(/^cgtn/, '').replace(/语$/, '').replace(/西班牙/, '西')
    return 'cgtn' + lang
  }
  if (/凤凰/.test(n)) return n.replace(/卫视|台/g, '')
  if (/卫视/.test(n)) return n.replace(/卫视.*$/, '')
  return n
}

/**
 * 拉取在线目录并与兜底目录合并、去重。每个频道保留**多个候选流 URL**（`urls`，主 URL
 * 取最高画质），供客户端在某个源失效时自动切换下一源（容灾）。
 * @param {object} opts { sources, timeoutMs, fetchImpl, signal }
 * @returns {Promise<{channels: object[], source: string, fetchedAt: number}>}
 */
export async function fetchCatalog(opts = {}) {
  const sources = Array.isArray(opts.sources) && opts.sources.length > 0 ? opts.sources : SOURCES
  const timeoutMs = opts.timeoutMs || 15000
  const fetchImpl = opts.fetchImpl || fetch
  const signal = opts.signal
  const whitelist = opts.whitelist !== false // 默认应用稳定频道白名单（搜索时传 false 关闭）

  // 先放入精选目录（source: curated，多 URL 起步）；跳过 IPv6 死链与旧 tsfile 中继，
  // 但保留吉林电信源（222.169.85.8，实测 AAC 可播）。
  const merged = new Map()
  for (const c of CURATED_CHANNELS) {
    const urls = (Array.isArray(c.urls) ? c.urls : [c.url])
      .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
      .filter((u) => !/^https?:\/\/\[/i.test(u))
      .filter((u) => /222\.169\.85\.8/.test(u) || (!/\/tsfile\/live\//i.test(u) && !/key=txiptv/i.test(u)))
    if (urls.length === 0) continue
    const key = channelKey(c.name)
    merged.set(key, { ...c, id: key, source: 'curated', logo: '', quality: c.quality || '', urls, url: urls[0] })
  }
  let liveCount = 0
  const usedSources = []

  // 合并一个实时频道：累积候选 URL（去重、上限 8），主 URL 取最高画质。
  const mergeLive = (c) => {
    const key = channelKey(c.name)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...c, id: key, source: 'live', urls: [c.url], url: c.url })
      return true
    }
    let urls = Array.isArray(existing.urls) ? existing.urls.slice() : [existing.url]
    if (!urls.includes(c.url)) urls.push(c.url)
    if (urls.length > 8) urls = urls.slice(0, 8)
    const better = qualityScore(c.quality) > qualityScore(existing.quality)
    merged.set(key, {
      ...existing,
      ...c,
      id: key,
      source: 'live',
      name: existing.name, // 保留首个（兜底）更友好的名称
      urls,
      url: better ? c.url : existing.url,
      quality: better ? c.quality : existing.quality,
    })
    return false
  }

  for (const src of sources) {
    try {
      const text = await fetchWithTimeout(src, fetchImpl, timeoutMs, signal)
      const parsed = parseM3u(text)
      if (parsed.length === 0) continue
      let added = 0
      for (const c of parsed) {
        // 只收录我们关心的三大类（央视/凤凰/卫视），跳过地方台/卡通等噪音。
        if (c.group === 'other') continue
        if (mergeLive(c)) added++
      }
      liveCount += added
      usedSources.push(src)
      if (liveCount >= 400) break // 收录上限，避免超大目录拖慢首次加载
    } catch {
      // 单个源失败静默跳过，用剩余源 + 兜底目录。
    }
  }

  // 主 URL 排首位，其余候选跟在后面。
  // 稳定源判定：官方/省级台 CDN（河北台、百视通、浙江台、延边、香港、内蒙古、央视官方）。
  const stableUrl = (u) => /hebtv\.com|bestv\.cn|cztv\.com|iyb983\.cn|hkstv\.tv|nmtv\.cn|cctvnews\.cctv\.com/i.test(u)
  const channels = [...merged.values()]
    .map((c) => {
      const urls = Array.isArray(c.urls) && c.urls.length > 0 ? c.urls : [c.url]
      const all = [c.url, ...urls.filter((u) => u !== c.url)]
      // 稳定源排前面（作主 URL），中继排后面（仅作容灾备份）。
      const stable = all.filter(stableUrl)
      const rest = all.filter((u) => !stableUrl(u))
      return { ...c, urls: [...stable, ...rest], url: stable[0] || all[0] }
    })
    // 只保留「确定稳定」频道（白名单），过滤掉间歇性中继（搜索时关闭）。
    .filter((c) => !whitelist || STABLE_WHITELIST.some((w) => String(c.name || '').includes(w)))
    .sort((a, b) => {
      // 卫视排前面（原 6 个卫视在数组最前），央视随后；组内保持数组顺序（稳定排序）。
      const order = { satellite: 0, cctv: 1, phoenix: 2, other: 3 }
      return (order[a.group] ?? 4) - (order[b.group] ?? 4)
    })

  return {
    channels,
    source: usedSources.length > 0 ? 'live+' + usedSources.length + ' 源' : '精选频道',
    fetchedAt: Date.now(),
  }
}

/** 按名称/关键词匹配频道：先精确命中，再子串命中。 */
export function matchChannel(channels, query) {
  const q = String(query || '').trim().toLowerCase()
  if (q === '') return null
  // 关键词归一：把「凤凰」「CCTV13」「cctv 13」「央视13」等变体对齐。
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[-·—]/g, '')
  const qn = norm(q)
  // 中文频道常见别名（供工具按口语词命中）。
  const aliases = (ch) => {
    const n = ch.name
    const set = [n, norm(n)]
    const mCctv = /cctv[- ]?(\d+)/i.exec(n)
    if (mCctv) set.push('cctv' + mCctv[1], '央视' + mCctv[1], '中央' + mCctv[1])
    if (/凤凰/.test(n)) set.push('凤凰', '凤凰卫视')
    if (/中文台/.test(n)) set.push('凤凰中文', '凤凰中文台')
    if (/资讯台/.test(n)) set.push('凤凰资讯', '凤凰资讯台')
    if (/香港台/.test(n)) set.push('凤凰香港', '凤凰香港台')
    return set
  }
  let best = null
  let bestScore = 0
  for (const ch of channels) {
    for (const a of aliases(ch)) {
      const an = norm(a)
      let score = 0
      if (an === qn) score = 100
      else if (an.includes(qn) || qn.includes(an)) score = 60
      else if (a.toLowerCase().includes(q)) score = 40
      if (score > bestScore) { bestScore = score; best = ch }
    }
  }
  return bestScore >= 40 ? best : null
}

export default { CURATED_CHANNELS, SOURCES, SEARCH_SOURCES, STABLE_WHITELIST, GROUP_LABELS, normalizeName, classifyGroup, parseM3u, fetchCatalog, matchChannel, channelKey, epgMatchKey, qualityScore, searchChannels }
