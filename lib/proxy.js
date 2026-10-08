/**
 * lib/proxy.js — 直播流同源代理（纯 Node，零第三方依赖）。
 *
 * 背景：IPTV 直播多为 HLS(m3u8) 或 HTTP-FLV；多数上游不返回 CORS 头，浏览器
 * `<video>` + hls.js 直接跨域拉流会被同源策略拦下。因此 Host 端提供一个同源代理：
 *   - `/dsh-tv/playlist?u=<m3u8>` 拉上游播放列表并「重写」其中的分片/子列表/密钥 URL
 *     为同源 `/dsh-tv/segment?u=...`，返回给 hls.js；hls.js 再经同源代理拉分片。
 *   - `/dsh-tv/segment?u=<分片>` 逐字节透传上游分片（附上游 Referer/UA 以满足防盗链）。
 * 纯透传、不转码、不落盘、不缓存完整流。
 *
 * 支持：master/media 两层 m3u8、相对/绝对/协议相对(scheme-relative) URL、
 * EXT-X-KEY(URI)/EXT-X-MAP(URI)/EXT-X-MEDIA(URI) 的重写；分片透传带 Range 无关的
 * 简单透传（直播分片无 seek 需求）。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 相对/协议相对 URL → 绝对 URL（基于当前列表 URL）。 */
export function resolveUrl(base, ref) {
  if (!ref) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) return ref
  try {
    return new URL(ref, base).href
  } catch { return ref }
}

/** 把一条绝对 URL 编成同源代理 URL。 */
export function segmentProxyUrl(u) {
  return '/dsh-tv/segment?u=' + encodeURIComponent(u)
}

/** 把一条绝对 URL 编成同源 playlist 代理 URL。 */
export function playlistProxyUrl(u) {
  return '/dsh-tv/playlist?u=' + encodeURIComponent(u)
}

/** 重写一行内所有 URI="..." 属性值为同源代理（KEY/MAP/MEDIA 用 segment 代理）。 */
function rewriteUriAttrs(line, baseUrl) {
  return line.replace(/URI="([^"]*)"/gi, (m, uri) => {
    const abs = resolveUrl(baseUrl, uri)
    return abs === '' ? m : 'URI="' + segmentProxyUrl(abs) + '"'
  })
}

/**
 * 重写一段 m3u8 播放列表文本：
 *   - 紧随 #EXTINF 的 URI 行（分片）→ segment 代理；
 *   - 紧随 #EXT-X-STREAM-INF 的 URI 行（master 子列表）→ playlist 代理；
 *   - EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA 里的 URI="..." → segment 代理。
 * @param {string} text 播放列表原文
 * @param {string} baseUrl 列表本身的绝对 URL
 * @returns 重写后的文本
 */
export function rewritePlaylist(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  let expectVariant = false
  let expectSegment = false
  for (const raw of lines) {
    let line = raw.replace(/\r$/, '')
    const t = line.trim()
    if (t.startsWith('#EXT-X-STREAM-INF')) {
      // master 子列表行：改写该行的 URI 属性（RESOLUTION/CODECS 等不动）。
      line = rewriteUriAttrs(line, baseUrl)
      expectVariant = true
      expectSegment = false
      out.push(line)
      continue
    }
    if (t.startsWith('#EXTINF')) {
      expectSegment = true
      expectVariant = false
      out.push(line)
      continue
    }
    if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP') || t.startsWith('#EXT-X-MEDIA')) {
      line = rewriteUriAttrs(line, baseUrl)
      out.push(line)
      continue
    }
    if (t.startsWith('#EXT-X-ENDLIST') || t.startsWith('#EXT-X-DISCONTINUITY') || t === '') {
      // 这些行不影响 URI 语义；落到通用分支前先复位标志。
      if (t.startsWith('#EXT-X-ENDLIST')) { expectSegment = false; expectVariant = false; out.push(line); continue }
    }
    if (t === '' || t.startsWith('#')) {
      out.push(line)
      continue
    }
    // 非注释行 = URI
    const abs = resolveUrl(baseUrl, t)
    if (expectVariant) {
      out.push(playlistProxyUrl(abs))
    } else if (expectSegment) {
      out.push(segmentProxyUrl(abs))
    } else {
      out.push(abs) // 兜底：原样绝对化
    }
    expectVariant = false
    expectSegment = false
  }
  return out.join('\n')
}

/** 抓上游并逐字节透传到 res（直播分片透传）。 */
export async function forwardUpstream(upstream, res, fetchImpl = fetch, extraHeaders = {}) {
  const ctrl = new AbortController()
  const abort = () => { try { ctrl.abort() } catch {} }
  res.on('close', abort)
  try {
    const ref = (() => { try { return new URL(upstream).origin } catch { return '' } })()
    const headers = {
      'User-Agent': UA,
      Referer: ref,
      ...extraHeaders,
    }
    const headerTimer = setTimeout(() => ctrl.abort(), 20000)
    let stream
    try {
      stream = await fetchImpl(upstream, { headers, redirect: 'follow', signal: ctrl.signal })
    } finally {
      clearTimeout(headerTimer)
    }
    if (!stream.ok) {
      res.writeHead(stream.status || 502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('上游分片获取失败 HTTP ' + stream.status)
      return
    }
    const ct = stream.headers.get('content-type') || 'video/mp2t'
    res.writeHead(200, {
      'Content-Type': ct,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'none',
    })
    if (stream.body) {
      for await (const chunk of stream.body) {
        if (res.writableEnded || res.destroyed) { ctrl.abort(); break }
        res.write(chunk)
      }
    }
    if (!res.writableEnded) res.end()
  } catch (err) {
    if (res.headersSent) {
      if (!res.writableEnded && !res.destroyed) { try { res.end() } catch {} }
    } else if (!res.writableEnded && !res.destroyed) {
      try { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('上游分片获取失败') } catch {}
    }
  } finally {
    res.removeListener('close', abort)
  }
}

export default { resolveUrl, segmentProxyUrl, playlistProxyUrl, rewritePlaylist, forwardUpstream }
