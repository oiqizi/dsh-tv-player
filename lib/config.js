/**
 * Config schema and resolution for `dsh-tv-player`. 每个可调项都是 Schemastery
 * 校验字段，可在 cordis.patch.yml 里覆盖：主开关、在线目录源列表、目录缓存 TTL、
 * 采集节奏与超时、收录频道上限。
 * @module dsh-tv-player/config
 */

import z from '@deepseek-ai/schemastery'
import { SOURCES } from './channels.js'

export const Config = z.object({
  enabled: z.boolean().default(true),
  sources: z.array(z.string()).default(SOURCES.slice()),
  epgUrl: z.string().default('https://raw.githubusercontent.com/fanmingming/live/main/e.xml'),
  epgTtlMs: z.number().default(6 * 60 * 60 * 1000),
  catalogTtlMs: z.number().default(30 * 60 * 1000),
  timeoutMs: z.number().default(15000),
  retries: z.number().default(1),
  maxChannels: z.number().default(400),
})

function assertPositiveInt(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer, got ${String(value)}`)
  }
}

function assertNonNegativeInt(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer, got ${String(value)}`)
  }
}

function isHttpsUrl(v) {
  return typeof v === 'string' && /^https?:\/\/[^\s]+$/u.test(v)
}

export function resolveConfig(config = {}) {
  const sources = Array.isArray(config.sources) && config.sources.length > 0
    ? config.sources.filter(isHttpsUrl)
    : SOURCES.slice()
  const epgUrl = typeof config.epgUrl === 'string' && isHttpsUrl(config.epgUrl)
    ? config.epgUrl
    : 'https://raw.githubusercontent.com/fanmingming/live/main/e.xml'
  const epgTtlMs = config.epgTtlMs ?? 6 * 60 * 60 * 1000
  assertNonNegativeInt('epgTtlMs', epgTtlMs)
  const catalogTtlMs = config.catalogTtlMs ?? 30 * 60 * 1000
  assertNonNegativeInt('catalogTtlMs', catalogTtlMs)
  const timeoutMs = config.timeoutMs ?? 15000
  assertPositiveInt('timeoutMs', timeoutMs)
  const retries = config.retries ?? 1
  assertNonNegativeInt('retries', retries)
  const maxChannels = config.maxChannels ?? 400
  assertPositiveInt('maxChannels', maxChannels)
  return {
    enabled: config.enabled ?? true,
    sources,
    epgUrl,
    epgTtlMs,
    catalogTtlMs,
    timeoutMs,
    retries,
    maxChannels,
  }
}
