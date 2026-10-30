import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

export const BUILTIN_PROVIDERS = ['doubao', 'qwen']

export const DEFAULT_ENDPOINTS = {
  doubao: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  qwen: 'https://maas.qianwenaiapi.com/compatible-mode/v1/images/generations',
}

export const DEFAULT_MODELS = {

  doubao: 'doubao-seedream-5-0-pro-260628',
  qwen: 'qwen-image-3.0-pro',
}

export const DEFAULT_SIZES = {
  doubao: {
    '1:1': '2048x2048',
    '2:3': '1152x2048',
    '3:4': '1536x2048',
    '9:16': '1080x1920',
    '16:9': '2560x1440',
  },
  qwen: {
    '1:1': '2048x2048',
    '2:3': '1152x2048',
    '3:4': '1536x2048',
    '9:16': '1080x1920',
    '16:9': '2048x1152',
  },
}

export const DEFAULT_CUSTOM_SIZES = {
  '1:1': '1024x1024',
  '2:3': '832x1216',
  '3:4': '896x1152',
  '9:16': '768x1344',
  '16:9': '1344x768',
}

const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 400
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const MAX_ERROR_TEXT = 400
const MAX_INLINE_B64_CHARS = 64 * 1024 * 1024

/** 远程图片 URL 下载的字节上限：超过即拒绝，避免恶意网关用超大响应耗尽内存/磁盘。 */
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024
/** 远程图片 URL 允许的最大重定向跳数，每一跳都重新做主机校验。 */
const MAX_DOWNLOAD_REDIRECTS = 3
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'))
    if (signal?.aborted) { abort(); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    void timer
  })
}

export async function fetchWithRetry(url, init, signal) {
  for (let attempt = 1; ; attempt += 1) {
    let response
    try {
      response = await fetch(url, { ...init, signal })
    } catch (error) {
      const cancelled = signal?.aborted || (error instanceof Error && error.name === 'AbortError')
      if (cancelled || attempt >= MAX_ATTEMPTS) throw error
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), signal)
      continue
    }
    if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt >= MAX_ATTEMPTS) {
      return response
    }
    // 不读重试响应的正文：直接取消，避免恶意/异常网关用超大错误体撑内存。
    await response.body?.cancel().catch(() => {})
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), signal)
  }
}

/** 严格识别 PNG/JPEG 魔数；不是图片时返回 undefined（远程下载内容校验用）。 */
function strictImageType(data) {
  if (data.byteLength >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  return undefined
}

function sniffImageType(data, fallback = 'image/png') {
  return strictImageType(data) ?? fallback
}

/** 内网/保留地址表：URL 里的字面 IP 与域名解析结果都按它判断。 */
const BLOCKED_ADDRESSES = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv6')

function normalizeHostname(rawHostname) {
  const trimmed = rawHostname.trim().toLowerCase()
  const unbracketed = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
  return unbracketed.endsWith('.') ? unbracketed.slice(0, -1) : unbracketed
}

/** 把 IPv6 URL 里出现的 IPv4 映射地址还原成点分四段，再按 IPv4 规则判断。 */
function ipv4FromMapped(address) {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address)
  if (match === null) return undefined
  const high = Number.parseInt(match[1], 16)
  const low = Number.parseInt(match[2], 16)
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
}

function isBlockedAddress(address) {
  const mapped = ipv4FromMapped(address)
  if (mapped !== undefined) return BLOCKED_ADDRESSES.check(mapped, 'ipv4')
  const family = isIP(address)
  if (family === 4) return BLOCKED_ADDRESSES.check(address, 'ipv4')
  if (family === 6) return BLOCKED_ADDRESSES.check(address, 'ipv6')
  return false
}

function isLocalHostname(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
}

/**
 * 主机归类：localhost / 字面 IP 直接判，域名用 DNS 解析结果判；解析失败返回 unknown。
 *
 * 说明：这里只做「解析后是否指向私网」的判断，不 pin 解析结果（fetch 连接时会再次
 * 解析），理论上仍有 DNS rebinding 窗口；但解析失败一律按不可下载处理（fail-closed），
 * 避免攻击者用「解析失败 → 放行」绕过检查。
 */
async function resolveTargetKind(hostname) {
  if (isLocalHostname(hostname)) return 'private'
  if (isIP(hostname) !== 0) return isBlockedAddress(hostname) ? 'private' : 'public'
  let records
  try {
    records = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    return 'unknown'
  }
  if (records.length === 0) return 'unknown'
  return records.some((record) => isBlockedAddress(record.address)) ? 'private' : 'public'
}

/**
 * 下载策略：生图端点在本机/内网时（本地部署、公司内网网关），允许图片 URL 指向
 * 私网地址；端点在公网时，响应里的私网 URL 一律拒绝（防 SSRF/内网探测）。
 */
async function createDownloadPolicy(endpoint) {
  let endpointHost
  try {
    endpointHost = normalizeHostname(new URL(endpoint).hostname)
  } catch {
    endpointHost = undefined
  }
  const kind = endpointHost === undefined ? 'unknown' : await resolveTargetKind(endpointHost)
  return { allowPrivate: kind === 'private' }
}

async function assertSafeImageUrl(rawUrl, policy) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('[imagegen] 响应里的图片 URL 不合法，已拒绝下载')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`[imagegen] 响应里的图片 URL 协议不受支持（${parsed.protocol}），已拒绝下载`)
  }
  const hostname = normalizeHostname(parsed.hostname)
  if (hostname === '') throw new Error('[imagegen] 响应里的图片 URL 缺少主机名，已拒绝下载')
  const kind = await resolveTargetKind(hostname)
  if (kind === 'unknown') {
    throw new Error(`[imagegen] 无法解析图片 URL 的主机名（${hostname}），已拒绝下载`)
  }
  if (kind === 'private' && policy?.allowPrivate !== true) {
    throw new Error(`[imagegen] 拒绝下载指向内网/回环地址的图片（${hostname}）：生图端点不在本机/内网时不允许访问私网地址`)
  }
  return parsed
}

/** 逐跳校验并跟随重定向：避免公网 URL 用 302 跳到内网绕过主机检查。 */
async function openImageDownload(rawUrl, policy, signal) {
  let target = rawUrl
  for (let hop = 0; ; hop += 1) {
    const checked = await assertSafeImageUrl(target, policy)
    const response = await fetchWithRetry(checked.href, { method: 'GET', redirect: 'manual' }, signal)
    if (!REDIRECT_STATUS.has(response.status)) return response
    await response.body?.cancel().catch(() => {})
    if (hop >= MAX_DOWNLOAD_REDIRECTS) {
      throw new Error(`[imagegen] 图片 URL 重定向次数过多（>${MAX_DOWNLOAD_REDIRECTS}）`)
    }
    const location = response.headers.get('location')
    if (location === null || location === '') throw new Error('[imagegen] 图片 URL 重定向缺少 Location，已拒绝下载')
    let next
    try {
      next = new URL(location, checked)
    } catch {
      throw new Error('[imagegen] 图片 URL 的重定向目标不合法，已拒绝下载')
    }
    target = next.href
  }
}

/** 读取下载响应体并施加字节上限；Content-Length 已超限时先拒绝，不白下载一遍。 */
async function readDownloadBytes(response, label) {
  const limitLabel = `${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB`
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`[imagegen] ${label} 图片过大（>${limitLabel}），已拒绝下载`)
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`[imagegen] ${label} 图片过大（>${limitLabel}），已拒绝下载`)
    }
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error(`[imagegen] ${label} 图片过大（>${limitLabel}），已中断下载`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function extractItems(payload) {
  const items = []
  const push = (entry) => {
    if (typeof entry === 'string') {

      if (/^https?:\/\//iu.test(entry)) items.push({ url: entry })
      else if (entry.length > 64) items.push({ b64: entry })
      return
    }
    if (typeof entry !== 'object' || entry === null) return
    const b64 = entry.b64_json ?? entry.b64 ?? entry.image_base64 ?? entry.base64
    const url = entry.url ?? entry.image_url ?? entry.image
    if (typeof b64 === 'string' && b64.trim() !== '') items.push({ b64: b64.trim() })
    else if (typeof url === 'string' && /^https?:\/\//iu.test(url)) items.push({ url })
  }
  if (typeof payload === 'string') {
    push(payload)
    return items
  }
  if (Array.isArray(payload)) {
    for (const entry of payload) push(entry)
    return items
  }
  if (typeof payload !== 'object' || payload === null) return items
  for (const key of ['data', 'images', 'image', 'output', 'artifacts', 'result']) {
    const value = payload[key]
    if (Array.isArray(value)) { for (const entry of value) push(entry); continue }
    if (value !== undefined) push(value)
  }

  if (items.length === 0) push(payload)
  return items
}

async function materialize(item, label, signal, policy) {
  if (item.b64 !== undefined) {
    if (item.b64.length > MAX_INLINE_B64_CHARS) {
      throw new Error(`[imagegen] ${label} 返回的 base64 过大（>${Math.round(MAX_INLINE_B64_CHARS / 1024 / 1024)}MB）`)
    }
    const cleaned = item.b64.replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, '')
    const data = new Uint8Array(Buffer.from(cleaned, 'base64'))
    if (data.byteLength === 0) throw new Error(`[imagegen] ${label} 返回了空的图片数据`)
    return { data, mediaType: sniffImageType(data) }
  }
  const download = await openImageDownload(item.url, policy, signal)
  if (!download.ok) throw new Error(`[imagegen] 图片下载失败 (HTTP ${download.status})`)
  const bytes = await readDownloadBytes(download, label)
  if (bytes.byteLength === 0) throw new Error('[imagegen] 下载到空的图片数据')
  const mediaType = strictImageType(bytes)
  if (mediaType === undefined) {
    throw new Error(`[imagegen] ${label} 图片 URL 返回的内容不是 PNG/JPEG，已拒绝写入`)
  }
  return { data: bytes, mediaType }
}

/** 读取错误响应正文：最多按 MAX_ERROR_TEXT 截断，读够即断开，避免超大错误体撑内存。 */
async function readErrorDetail(response) {
  if (response.body === null) return ''
  const limit = MAX_ERROR_TEXT * 4
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const room = limit - total
      chunks.push(value.subarray(0, room))
      total += Math.min(room, value.byteLength)
      if (total >= limit) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  } catch {
    return ''
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, MAX_ERROR_TEXT)
}

export async function decodeImageResponse(response, label, signal, context) {
  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new Error(`[imagegen] ${label} 请求失败 (HTTP ${response.status}): ${detail}`)
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error(`[imagegen] ${label} 返回了空响应体`)

  const sniffed = sniffImageType(bytes, 'image/png')
  const looksBinary = contentType.startsWith('image/')
    || (!contentType.includes('json') && (sniffed === 'image/jpeg' || (bytes[0] === 0x89 && bytes[1] === 0x50)))
  if (looksBinary) return [{ data: bytes, mediaType: sniffed }]

  const text = Buffer.from(bytes).toString('utf8').trim()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== '')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try { payload = JSON.parse(lines[i]); break } catch {}
    }
  }
  if (payload === undefined) {
    throw new Error(`[imagegen] ${label} 响应既不是图片也不是合法 JSON: ${text.slice(0, 300)}`)
  }

  if (typeof payload === 'object' && payload !== null
    && payload.error !== undefined && extractItems(payload).length === 0) {
    throw new Error(`[imagegen] ${label} 返回错误: ${JSON.stringify(payload.error).slice(0, MAX_ERROR_TEXT)}`)
  }
  const items = extractItems(payload)
  if (items.length === 0) {
    throw new Error(`[imagegen] ${label} 响应里没有图片数据: ${JSON.stringify(payload).slice(0, 300)}`)
  }
  // 只有确实要从远程 URL 拉图时才解析端点主机（本地部署端点允许私网，公网端点禁止）。
  const policy = context?.endpoint !== undefined && items.some((item) => item.url !== undefined)
    ? await createDownloadPolicy(context.endpoint)
    : undefined
  return Promise.all(items.map((item) => materialize(item, label, signal, policy)))
}

export function normalizeEndpoint(raw) {
  const value = raw.trim().replace(/\/+$/u, '')
  if (value === '') return value
  if (/\/images\/generations$/iu.test(value)) return value
  if (/\/v\d+$/iu.test(value)) return `${value}/images/generations`
  return `${value}/v1/images/generations`
}

export function builtinRow(name, overrides) {
  const isDoubao = name === 'doubao'
  const endpoint = overrides.endpoint?.trim()
  const model = overrides.model?.trim()
  return {
    name,
    builtin: true,
    endpoint: endpoint !== undefined && endpoint !== '' ? normalizeEndpoint(endpoint) : DEFAULT_ENDPOINTS[name],
    model: model !== undefined && model !== '' ? model : DEFAULT_MODELS[name],
    ...(overrides.apiKey === undefined ? {} : { apiKey: overrides.apiKey }),
    apiKeyOptional: false,
    authHeader: 'authorization',
    authScheme: 'Bearer ',
    sizeFor: (aspect) => DEFAULT_SIZES[name][aspect] ?? DEFAULT_SIZES[name]['2:3'],
    supportsN: false,
    maxN: 4,
    sendWatermark: true,

    sendPromptExtend: !isDoubao,

    sendN: true,
    sendSeed: !isDoubao,
    sendNegativePrompt: !isDoubao,
    imageField: 'image',
    responseFormat: 'b64_json',
    extraBody: {},
  }
}

export function customRow(name, spec) {

  const fixedRaw = typeof spec.size === 'string' && spec.size.trim() !== ''
    ? spec.size.trim()
    : (typeof spec.sizes === 'string' ? spec.sizes.trim() : '')
  const sizes = fixedRaw !== '' ? undefined : spec.sizes
  const separator = spec.sizeSeparator ?? 'x'
  const apiKey = spec.apiKey?.trim()
  return {
    name,
    builtin: false,
    endpoint: normalizeEndpoint(spec.baseUrl),
    model: spec.model.trim(),
    ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
    ...(spec.apiKeyEnv === undefined ? {} : { apiKeyEnv: spec.apiKeyEnv }),
    apiKeyOptional: spec.apiKeyOptional === true,
    authHeader: (spec.authHeader ?? 'authorization').toLowerCase(),
    authScheme: spec.authScheme ?? 'Bearer ',
    sizeFor: (aspect) => {
      if (fixedRaw !== '') return fixedRaw
      const explicit = sizes?.[aspect]
      if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
      const fallback = DEFAULT_CUSTOM_SIZES[aspect] ?? DEFAULT_CUSTOM_SIZES['2:3']
      return separator === 'x' ? fallback : fallback.replace('x', separator)
    },
    supportsN: spec.supportsN === true,
    maxN: Number.isInteger(spec.maxN) && spec.maxN > 0 ? Math.min(spec.maxN, 8) : 4,
    sendWatermark: spec.sendWatermark !== false,
    sendPromptExtend: spec.sendPromptExtend === true,
    sendN: spec.sendN !== false,
    sendSeed: spec.sendSeed !== false,
    sendNegativePrompt: spec.sendNegativePrompt !== false,
    imageField: spec.imageField === false ? false : (spec.imageField ?? 'image'),
    responseFormat: spec.responseFormat === 'url' ? 'url' : 'b64_json',
    extraBody: spec.extraBody ?? {},
  }
}

export function normalizeCustomProviders(raw) {
  const table = new Map()
  if (raw === undefined || raw === null) return table
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[imagegen] customProviders 必须是对象：{ <名字>: { baseUrl, model, ... } }')
  }
  for (const [rawKey, spec] of Object.entries(raw)) {
    const providerName = rawKey.trim()
    if (providerName === '') throw new Error('[imagegen] customProviders 里有空的名字键')
    if (BUILTIN_PROVIDERS.includes(providerName)) {
      throw new Error(`[imagegen] customProviders 不能覆盖内置通道「${providerName}」（请改用 baseUrls/models/apiKeys 覆盖）`)
    }
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      throw new Error(`[imagegen] customProviders.${providerName} 必须是对象`)
    }
    const baseUrl = typeof spec.baseUrl === 'string' ? spec.baseUrl.trim() : ''
    const model = typeof spec.model === 'string' ? spec.model.trim() : ''
    if (baseUrl === '') throw new Error(`[imagegen] customProviders.${providerName} 缺少 baseUrl`)
    if (model === '') throw new Error(`[imagegen] customProviders.${providerName} 缺少 model`)
    const normalizedEndpoint = normalizeEndpoint(baseUrl)
    if (!/^https?:\/\//iu.test(normalizedEndpoint)) {
      throw new Error(`[imagegen] customProviders.${providerName}.baseUrl 必须是 http(s) 地址，当前为 ${baseUrl}`)
    }
    table.set(providerName, customRow(providerName, { ...spec, baseUrl, model }))
  }
  return table
}

export function unknownProviderError(name, available) {
  return new Error(
    `[imagegen] 未知 provider「${name}」。可用：${available.join(' / ')}`
    + '（新增通道请在设置页 customProviders 或 cordis.patch.yml 里声明 baseUrl + model）',
  )
}

export async function generateImages(options) {
  const { provider } = options
  const body = {
    model: provider.model,
    prompt: options.prompt,
    size: provider.sizeFor(options.aspect),
  }
  if (provider.sendN) body.n = provider.supportsN ? options.n : 1
  if (provider.responseFormat === 'b64_json') body.response_format = 'b64_json'
  if (provider.sendWatermark) body.watermark = false
  if (provider.sendPromptExtend) body.prompt_extend = false
  if (options.image !== undefined && provider.imageField !== false) body[provider.imageField] = options.image
  if (options.seed !== undefined && provider.sendSeed) body.seed = options.seed
  if (options.negativePrompt !== undefined && provider.sendNegativePrompt) body.negative_prompt = options.negativePrompt
  for (const [key, value] of Object.entries(provider.extraBody)) {
    if (value !== undefined) body[key] = value
  }

  const headers = { 'content-type': 'application/json' }
  if (provider.apiKey !== undefined && provider.apiKey !== '') {
    headers[provider.authHeader] = `${provider.authScheme}${provider.apiKey}`
  }

  const response = await fetchWithRetry(provider.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, options.signal)
  return decodeImageResponse(response, `${provider.name} ${provider.model}`, options.signal, {
    endpoint: provider.endpoint,
  })
}

const BUILTIN_KEY_ENV = {
  doubao: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'ALIYUN_API_KEY'],
}

const GLOBAL_KEY_ENV = ['IMAGE_API_KEY', 'OPENAI_API_KEY']

function envValue(names) {
  if (names === undefined) return undefined
  const list = typeof names === 'string' ? [names] : names
  for (const name of list) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

export function resolveApiKey(provider) {
  const direct = provider.apiKey?.trim()
  if (direct !== undefined && direct !== '') return direct
  const fromEnv = envValue(provider.apiKeyEnv)
  if (fromEnv !== undefined) return fromEnv
  // 免鉴权通道必须在全局兜底之前短路：用户明确声明「这个端点不需要鉴权」时，
  // 绝不能把环境里的 IMAGE_API_KEY / OPENAI_API_KEY 静默发给它（本地端点、
  // 第三方网关都不该收到与本通道无关的密钥）。
  if (provider.apiKeyOptional) return undefined
  const names = provider.builtin ? (BUILTIN_KEY_ENV[provider.name] ?? []) : GLOBAL_KEY_ENV
  const fallback = envValue(names)
  if (fallback !== undefined) return fallback
  const hint = provider.builtin
    ? `环境变量 ${(BUILTIN_KEY_ENV[provider.name] ?? ['ARK_API_KEY'])[0]}`
    : 'customProviders 里的 apiKey / apiKeyEnv，或环境变量 IMAGE_API_KEY'
  throw new Error(`[imagegen] 通道「${provider.name}」未配置 API key（设置页填写，或 ${hint}）`)
}

export function describeRow(row) {
  return `${row.name} (${row.builtin ? 'builtin' : 'custom'}) ${row.model} @ ${row.endpoint}`
}
