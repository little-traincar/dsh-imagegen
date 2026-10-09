// 由 scripts/build.mjs 生成，请勿直接编辑（改 src/ 下的源码后重新构建）。
import { randomUUID as dep_randomUUID } from "node:crypto";
import { mkdir as dep_mkdir } from "node:fs/promises";
import { readFile as dep_readFile } from "node:fs/promises";
import { writeFile as dep_writeFile } from "node:fs/promises";
import { basename as dep_basename } from "node:path";
import { extname as dep_extname } from "node:path";
import { isAbsolute as dep_isAbsolute } from "node:path";
import { join as dep_join } from "node:path";
import { defineTool as dep_defineTool } from "@deepseek-ai/dsh-tools";
import dep_Schema from "@deepseek-ai/schemastery";

// —— providers.js ——
// providers.js —— 生图 HTTP 适配层（表驱动的多 provider 实现）。
//
// 与上游只支持 doubao / qwen 两个硬编码分支不同，这里把「怎么发请求、怎么解响应」
// 抽象成一张 provider 表：
//   - 内置 provider（doubao / qwen）保留官方端点与各自的参数怪癖；
//   - 任何第三方中转站或本地部署（Ollama / vLLM / SD-WebUI 兼容网关 / 自建
//     兼容层）都可以用 customProviders.<名字> 声明，只要它支持 OpenAI 风格的
//     POST <baseUrl>/images/generations。
//
// 防御性约定（沿用上游）：
//   - watermark 默认显式 false（可关）；qwen 额外 prompt_extend:false（防改写用户文案）。
//   - 网络错误 / 429 / 5xx 自动退避重试（最多 3 次尝试）；4xx 与用户取消不重试。
//   - 图片格式按字节签名嗅探，不信任 API 元数据（豆包 b64 实际常为 JPEG）。
//   - 错误消息透出服务端原文（截断），但绝不含 API key。

/** @typedef {'doubao' | 'qwen'} BuiltinProvider */
/** @typedef {string} Provider */
/** @typedef {'1:1' | '2:3' | '3:4' | '9:16' | '16:9'} Aspect */
/** @typedef {'image/png' | 'image/jpeg'} ImageMediaType */
/**
 * 自定义通道声明（任意 OpenAI 风格 /images/generations 兼容服务）。
 * @typedef {object} OpenAiImageEndpoint
 * @property {string} baseUrl 完整地址或裸主机（自动补 /v1/images/generations）。
 * @property {string} model 该通道使用的模型 id。
 * @property {string} [apiKey] 直填的 key。
 * @property {string | string[]} [apiKeyEnv] key 优先从这些环境变量读取。
 * @property {boolean} [apiKeyOptional] 本地免鉴权端点：无 key 也允许请求。
 * @property {string} [authHeader] 自定义鉴权头名（默认 authorization）。
 * @property {string} [authScheme] 鉴权前缀，默认 'Bearer '；置空串即裸值。
 * @property {Record<string, string> | string} [sizes] 长宽比 → 尺寸，或固定尺寸串。
 * @property {string} [size] 固定尺寸（等价于 sizes 传固定字符串，取更直观的写法）。
 * @property {string} [sizeSeparator] 尺寸分隔符，默认 'x'。
 * @property {boolean} [supportsN] 一次请求直接出多张（n 参数）。
 * @property {number} [maxN] 单次请求最多几张，默认 4。
 * @property {boolean} [sendWatermark] 发送 watermark:false，默认 true。
 * @property {boolean} [sendPromptExtend] 发送 prompt_extend:false，默认 false。
 * @property {boolean} [sendN] 发送 n，默认 true。
 * @property {boolean} [sendSeed] 支持 seed，默认 true。
 * @property {boolean} [sendNegativePrompt] 支持 negative_prompt，默认 true。
 * @property {string | false} [imageField] 参考图字段名，默认 'image'；false = 不支持图生图。
 * @property {'b64_json' | 'url'} [responseFormat] 响应格式，默认 b64_json。
 * @property {Record<string, unknown>} [extraBody] 供应商私有参数。
 * @property {string} [note] 仅供文档。
 */
/**
 * provider 表里归一化后的一行。
 * @typedef {object} ResolvedProvider
 * @property {string} name
 * @property {boolean} builtin
 * @property {string} endpoint
 * @property {string} model
 * @property {string} [apiKey]
 * @property {string | string[]} [apiKeyEnv]
 * @property {boolean} apiKeyOptional
 * @property {string} authHeader
 * @property {string} authScheme
 * @property {(aspect: Aspect) => string} sizeFor
 * @property {boolean} supportsN
 * @property {number} maxN
 * @property {boolean} sendWatermark
 * @property {boolean} sendPromptExtend
 * @property {boolean} sendN
 * @property {boolean} sendSeed
 * @property {boolean} sendNegativePrompt
 * @property {string | false} imageField
 * @property {'b64_json' | 'url'} responseFormat
 * @property {Record<string, unknown>} extraBody
 */
/** @typedef {{ data: Uint8Array, mediaType: ImageMediaType }} GeneratedImage */

const m0_BUILTIN_PROVIDERS = ['doubao', 'qwen']

/** 内置 provider 的默认 endpoint；可在配置 baseUrls 里覆盖。 */
const m0_DEFAULT_ENDPOINTS = {
  doubao: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations',
}

const m0_DEFAULT_MODELS = {
  // 别名会 404；快照 ID 实测可用。
  doubao: 'doubao-seedream-5-0-pro-260628',
  qwen: 'qwen-image-3.0-pro',
}

/**
 * 每家按长宽比的默认分辨率。
 * 竖版 1152x2048 ≈ 236 万像素，落在豆包 0.3 元档；
 * 横版 16:9 提升到 2560x1440（QHD，≈ 369 万像素）以获得 2K 画质，计费档位可能上浮。
 */
const m0_DEFAULT_SIZES = {
  doubao: {
    '1:1': '2048x2048',
    '2:3': '1152x2048',
    '3:4': '1536x2048',
    '9:16': '1080x1920',
    '16:9': '2560x1440',
  },
  qwen: {
    '1:1': '2048*2048',
    '2:3': '1152*2048',
    '3:4': '1536*2048',
    '9:16': '1080*1920',
    '16:9': '2560*1440',
  },
}

/** 自定义通道的兜底尺寸表（SD / SDXL / Flux 常用档位，'x' 分隔符）。 */
const m0_DEFAULT_CUSTOM_SIZES = {
  '1:1': '1024x1024',
  '2:3': '832x1216',
  '3:4': '896x1152',
  '9:16': '768x1344',
  '16:9': '1344x768',
}

const m0_MAX_ATTEMPTS = 3
const m0_RETRY_BASE_MS = 400
const m0_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const m0_MAX_ERROR_TEXT = 400
const m0_MAX_INLINE_B64_CHARS = 64 * 1024 * 1024

/** 可被 signal 打断的延迟。 */
function m0_sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'))
    if (signal?.aborted) { abort(); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    void timer
  })
}

/** 带退避重试的 fetch：仅重试可重试状态与网络错误，取消立即失败。 */
async function m0_fetchWithRetry(url, init, signal) {
  for (let attempt = 1; ; attempt += 1) {
    let response
    try {
      response = await fetch(url, { ...init, signal })
    } catch (error) {
      const cancelled = signal?.aborted || (error instanceof Error && error.name === 'AbortError')
      if (cancelled || attempt >= m0_MAX_ATTEMPTS) throw error
      await m0_sleep(m0_RETRY_BASE_MS * 2 ** (attempt - 1), signal)
      continue
    }
    if (response.ok || !m0_RETRYABLE_STATUS.has(response.status) || attempt >= m0_MAX_ATTEMPTS) {
      return response
    }
    await response.arrayBuffer().catch(() => {}) // 排空连接，避免重试被复用/阻塞
    await m0_sleep(m0_RETRY_BASE_MS * 2 ** (attempt - 1), signal)
  }
}

/** 按字节签名嗅探真实格式（与 read_image 同一原则，不信任元数据）。 */
function m0_sniffImageType(data, fallback = 'image/png') {
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.byteLength >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  return fallback
}

/** 从一台本地服务常见的多种响应形状里抠出 base64 / url 列表。 */
function m0_extractItems(payload) {
  const items = []
  const push = (entry) => {
    if (typeof entry === 'string') {
      // 裸 base64 字符串或裸 URL。
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
  // 顶层直接给 b64_json / url 的老实服务。
  if (items.length === 0) push(payload)
  return items
}

/** 把一条候选条目解成图片字节（b64 直接解，url 再下一次）。 */
async function m0_materialize(item, label, signal) {
  if (item.b64 !== undefined) {
    if (item.b64.length > m0_MAX_INLINE_B64_CHARS) {
      throw new Error(`[imagegen] ${label} 返回的 base64 过大（>${Math.round(m0_MAX_INLINE_B64_CHARS / 1024 / 1024)}MB）`)
    }
    const cleaned = item.b64.replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, '')
    const data = new Uint8Array(Buffer.from(cleaned, 'base64'))
    if (data.byteLength === 0) throw new Error(`[imagegen] ${label} 返回了空的图片数据`)
    return { data, mediaType: m0_sniffImageType(data) }
  }
  const download = await m0_fetchWithRetry(item.url, { method: 'GET' }, signal)
  if (!download.ok) throw new Error(`[imagegen] 图片下载失败 (HTTP ${download.status})`)
  const bytes = new Uint8Array(await download.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error('[imagegen] 下载到空的图片数据')
  return { data: bytes, mediaType: m0_sniffImageType(bytes) }
}

/**
 * 解析响应，返回全部图片（一张或多张）。
 *
 * 兼容顺序：二进制图片直出 → JSON（data[].b64_json / data[].url / images[] / 顶层字段）。
 * 本地部署常见的「直接吐 PNG 字节」与「artifacts/images 数组」都在覆盖范围内。
 * @param {Response} response - 上游响应。
 * @param {string} label - 错误信息里的通道标签。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<GeneratedImage[]>} 图片字节列表。
 */
async function m0_decodeImageResponse(response, label, signal) {
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, m0_MAX_ERROR_TEXT)
    throw new Error(`[imagegen] ${label} 请求失败 (HTTP ${response.status}): ${detail}`)
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error(`[imagegen] ${label} 返回了空响应体`)

  // 1) 二进制直出：Content-Type 是图片，或不是 JSON 但字节是图片签名。
  const sniffed = m0_sniffImageType(bytes, 'image/png')
  const looksBinary = contentType.startsWith('image/')
    || (!contentType.includes('json') && (sniffed === 'image/jpeg' || (bytes[0] === 0x89 && bytes[1] === 0x50)))
  if (looksBinary) return [{ data: bytes, mediaType: sniffed }]

  // 2) JSON（含 NDJSON：取最后一行可解析的对象）。
  const text = Buffer.from(bytes).toString('utf8').trim()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== '')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try { payload = JSON.parse(lines[i]); break } catch { /* 继续往前找 */ }
    }
  }
  if (payload === undefined) {
    throw new Error(`[imagegen] ${label} 响应既不是图片也不是合法 JSON: ${text.slice(0, 300)}`)
  }
  // 服务端把错误塞在 200 里（部分自建网关如此）。
  if (typeof payload === 'object' && payload !== null
    && payload.error !== undefined && m0_extractItems(payload).length === 0) {
    throw new Error(`[imagegen] ${label} 返回错误: ${JSON.stringify(payload.error).slice(0, m0_MAX_ERROR_TEXT)}`)
  }
  const items = m0_extractItems(payload)
  if (items.length === 0) {
    throw new Error(`[imagegen] ${label} 响应里没有图片数据: ${JSON.stringify(payload).slice(0, 300)}`)
  }
  return Promise.all(items.map((item) => m0_materialize(item, label, signal)))
}

/**
 * 把 URL 归一化成完整 endpoint：裸主机 / 以 /v1 结尾 / 已带完整路径都能吃。
 * @param {string} raw - 配置里的地址。
 * @returns {string} 完整 endpoint。
 */
function m0_normalizeEndpoint(raw) {
  const value = raw.trim().replace(/\/+$/u, '')
  if (value === '') return value
  if (/\/images\/generations$/iu.test(value)) return value
  if (/\/v\d+$/iu.test(value)) return `${value}/images/generations`
  return `${value}/v1/images/generations`
}

/**
 * 内置 provider → 归一化行（保留上游两家的参数怪癖）。
 * @param {BuiltinProvider} name - 通道名。
 * @param {{ endpoint?: string, model?: string, apiKey?: string }} overrides - 配置覆盖。
 * @returns {ResolvedProvider} 归一化行。
 */
function m0_builtinRow(name, overrides) {
  const isDoubao = name === 'doubao'
  const endpoint = overrides.endpoint?.trim()
  const model = overrides.model?.trim()
  return {
    name,
    builtin: true,
    endpoint: endpoint !== undefined && endpoint !== '' ? m0_normalizeEndpoint(endpoint) : m0_DEFAULT_ENDPOINTS[name],
    model: model !== undefined && model !== '' ? model : m0_DEFAULT_MODELS[name],
    ...(overrides.apiKey === undefined ? {} : { apiKey: overrides.apiKey }),
    apiKeyOptional: false,
    authHeader: 'authorization',
    authScheme: 'Bearer ',
    sizeFor: (aspect) => m0_DEFAULT_SIZES[name][aspect] ?? m0_DEFAULT_SIZES[name]['2:3'],
    supportsN: false,
    maxN: 4,
    sendWatermark: true,
    // 豆包不发 prompt_extend；qwen 必须发（防平台改写用户文案）。
    sendPromptExtend: !isDoubao,
    // 老实现：两家都发 n:1，逐张并发生成。
    sendN: true,
    sendSeed: !isDoubao,
    sendNegativePrompt: !isDoubao,
    imageField: 'image',
    responseFormat: 'b64_json',
    extraBody: {},
  }
}

/**
 * 自定义 provider 声明 → 归一化行。
 * @param {string} name - 通道名。
 * @param {OpenAiImageEndpoint} spec - 声明。
 * @returns {ResolvedProvider} 归一化行。
 */
function m0_customRow(name, spec) {
  // 固定尺寸两种写法都认：size（更直观）优先，其次 sizes 传字符串。
  const fixedRaw = typeof spec.size === 'string' && spec.size.trim() !== ''
    ? spec.size.trim()
    : (typeof spec.sizes === 'string' ? spec.sizes.trim() : '')
  const sizes = fixedRaw !== '' ? undefined : spec.sizes
  const separator = spec.sizeSeparator ?? 'x'
  const apiKey = spec.apiKey?.trim()
  return {
    name,
    builtin: false,
    endpoint: m0_normalizeEndpoint(spec.baseUrl),
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
      const fallback = m0_DEFAULT_CUSTOM_SIZES[aspect] ?? m0_DEFAULT_CUSTOM_SIZES['2:3']
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

/**
 * 把配置里的 customProviders 归一化成 provider 行。
 * 非法条目抛可读错误（宁可在调用时明确失败，也不要静默降级到别的通道）。
 * @param {unknown} raw - 配置里的原始表。
 * @returns {Map<string, ResolvedProvider>} 名字 → 归一化行。
 */
function m0_normalizeCustomProviders(raw) {
  const table = new Map()
  if (raw === undefined || raw === null) return table
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[imagegen] customProviders 必须是对象：{ <名字>: { baseUrl, model, ... } }')
  }
  for (const [rawKey, spec] of Object.entries(raw)) {
    const providerName = rawKey.trim()
    if (providerName === '') throw new Error('[imagegen] customProviders 里有空的名字键')
    if (m0_BUILTIN_PROVIDERS.includes(providerName)) {
      throw new Error(`[imagegen] customProviders 不能覆盖内置通道「${providerName}」（请改用 baseUrls/models/apiKeys 覆盖）`)
    }
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      throw new Error(`[imagegen] customProviders.${providerName} 必须是对象`)
    }
    const baseUrl = typeof spec.baseUrl === 'string' ? spec.baseUrl.trim() : ''
    const model = typeof spec.model === 'string' ? spec.model.trim() : ''
    if (baseUrl === '') throw new Error(`[imagegen] customProviders.${providerName} 缺少 baseUrl`)
    if (model === '') throw new Error(`[imagegen] customProviders.${providerName} 缺少 model`)
    const normalizedEndpoint = m0_normalizeEndpoint(baseUrl)
    if (!/^https?:\/\//iu.test(normalizedEndpoint)) {
      throw new Error(`[imagegen] customProviders.${providerName}.baseUrl 必须是 http(s) 地址，当前为 ${baseUrl}`)
    }
    table.set(providerName, m0_customRow(providerName, { ...spec, baseUrl, model }))
  }
  return table
}

/**
 * 未在表里声明的 provider 名 → 错误对象（含可用名字提示）。
 * @param {string} name - 请求的通道名。
 * @param {string[]} available - 当前可用通道名。
 * @returns {Error} 错误。
 */
function m0_unknownProviderError(name, available) {
  return new Error(
    `[imagegen] 未知 provider「${name}」。可用：${available.join(' / ')}`
    + '（新增通道请在设置页 customProviders 或 cordis.patch.yml 里声明 baseUrl + model）',
  )
}

/**
 * 通用生图请求：按 provider 行组装 OpenAI 风格请求体。
 * 一张或多张都走同一函数；返回数组（长度可能小于 n，由调用方判断）。
 * @param {{ provider: ResolvedProvider, prompt: string, aspect: Aspect, n: number, image?: string, seed?: number, negativePrompt?: string, signal?: AbortSignal }} options - 请求参数。
 * @returns {Promise<GeneratedImage[]>} 图片字节列表。
 */
async function m0_generateImages(options) {
  const { provider } = options
  const body = {
    model: provider.model,
    prompt: options.prompt,
    size: provider.sizeFor(options.aspect),
  }
  if (provider.sendN) body.n = provider.supportsN ? options.n : 1
  if (provider.responseFormat === 'b64_json') body.response_format = 'b64_json'
  if (provider.sendWatermark) body.watermark = false // 硬性要求：不加水印
  if (provider.sendPromptExtend) body.prompt_extend = false // 禁止改写提示词，保证文字逐字呈现
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

  const response = await m0_fetchWithRetry(provider.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, options.signal)
  return m0_decodeImageResponse(response, `${provider.name} ${provider.model}`, options.signal)
}

/** 内置 provider 的环境变量回退名。 */
const m0_BUILTIN_KEY_ENV = {
  doubao: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'ALIYUN_API_KEY'],
}

/** 自定义 provider 的环境变量回退名（含全局兜底）。 */
const m0_GLOBAL_KEY_ENV = ['IMAGE_API_KEY', 'OPENAI_API_KEY']

function m0_envValue(names) {
  if (names === undefined) return undefined
  const list = typeof names === 'string' ? [names] : names
  for (const name of list) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * 取完整 API key：provider 直填 > apiKeyEnv > 内置/全局环境变量。
 * 缺失时给出可读错误（不含任何秘密）；免鉴权本地端点直接返回 undefined。
 * @param {ResolvedProvider} provider - 归一化行。
 * @returns {string | undefined} key。
 */
function m0_resolveApiKey(provider) {
  const direct = provider.apiKey?.trim()
  if (direct !== undefined && direct !== '') return direct
  const fromEnv = m0_envValue(provider.apiKeyEnv)
  if (fromEnv !== undefined) return fromEnv
  const names = provider.builtin ? (m0_BUILTIN_KEY_ENV[provider.name] ?? []) : m0_GLOBAL_KEY_ENV
  const fallback = m0_envValue(names)
  if (fallback !== undefined) return fallback
  if (provider.apiKeyOptional) return undefined
  const hint = provider.builtin
    ? `环境变量 ${(m0_BUILTIN_KEY_ENV[provider.name] ?? ['ARK_API_KEY'])[0]}`
    : 'customProviders 里的 apiKey / apiKeyEnv，或环境变量 IMAGE_API_KEY'
  throw new Error(`[imagegen] 通道「${provider.name}」未配置 API key（设置页填写，或 ${hint}）`)
}

/**
 * 供设置页/诊断用的能力摘要。
 * @param {ResolvedProvider} row - 归一化行。
 * @returns {string} 一行描述。
 */
function m0_describeRow(row) {
  return `${row.name} (${row.builtin ? 'builtin' : 'custom'}) ${row.model} @ ${row.endpoint}`
}

// —— index.js ——
/**
 * imagegen —— DSH 生图工具插件（宿主半侧）。
 *
 * 目标宿主：DSH 0.2.x（本文件按 dsh-v0.2.0-rc.2 的真实 API 编写）。
 * 与上游 0.1.x 版本的差异：
 *   - 上游用 `settings.installSection(...)`（0.1.2–0.1.6 的命名空间 API），该 API 在
 *     0.1.7+ 已被移除。本版本改为官方现行形态：静态 `m1_Config`（字段级 `.volatile()`）
 *     + `ctx.get('configEditor').edit(...)` 落 profile；读经 m1_apply 入参的 volatile 引用。
 *   - 工具入参新增 `model`：单次调用可临时指定模型，不必改配置。
 *   - 通道（provider）是开放表：内置 doubao / qwen，其余走 `customProviders`；
 *     每个通道的模型 id 由 `models` 自由填写。
 *
 * 运行时只依赖宿主已经提供的服务（tools / attachments / webServer / settings），
 * 缺服务一律干净降级，不在 m1_apply 里抛错。
 *
 * 防御性工程：
 *   - 所有入参做边界校验（长度/数量/枚举/范围），错误信息可读且不含密钥。
 *   - 并发生成用 allSettled：部分失败保留成功图并逐条标注，全部失败才报错。
 *   - 路由只读、单段文件名白名单（杜绝路径穿越）、nosniff、no-store、HEAD 支持。
 *   - 超时与 exec.signal 合并（AbortSignal.any），取消即停止等待。
 */
const __ns_0 = { BUILTIN_PROVIDERS: m0_BUILTIN_PROVIDERS, DEFAULT_ENDPOINTS: m0_DEFAULT_ENDPOINTS, DEFAULT_MODELS: m0_DEFAULT_MODELS, DEFAULT_SIZES: m0_DEFAULT_SIZES, DEFAULT_CUSTOM_SIZES: m0_DEFAULT_CUSTOM_SIZES, fetchWithRetry: m0_fetchWithRetry, decodeImageResponse: m0_decodeImageResponse, normalizeEndpoint: m0_normalizeEndpoint, builtinRow: m0_builtinRow, customRow: m0_customRow, normalizeCustomProviders: m0_normalizeCustomProviders, unknownProviderError: m0_unknownProviderError, generateImages: m0_generateImages, resolveApiKey: m0_resolveApiKey, describeRow: m0_describeRow };

// 可测试面：这两个纯函数是自检脚本与诊断入口直接调用的部分，显式对外导出。
// 注意：必须先落到本地名字再 export —— 打包器的公共导出块只接受本地标识符，
// 直接把「相对导入得到的绑定」写进 export 会生成非法的 `export { ns.member }`。
const m1_exportNormalizeCustomProviders = __ns_0.normalizeCustomProviders
const m1_exportNormalizeEndpoint = __ns_0.normalizeEndpoint


/** 插件名。刻意不叫 name：打包器给顶层标识符加模块前缀，与对象字面量键同名会互相污染。 */
const m1_PLUGIN_NAME = 'imagegen'

/** 工具注册表服务需在 m1_apply 顶层可见。 */
const m1_PLUGIN_INJECT = ['tools']



/** 设置命名空间 = profile 里的 entry id；客户端卡片按同一名字读写。 */
const m1_IMAGEGEN_SETTINGS_NS = 'imagegen'

/**
 * 模型单元格的保留后缀：`<通道>/model` 与 `<通道>/label` 是 0.3.1 卡片写下的
 * 遗留键（写入键与读取键不一致的实现缺陷）。内置通道不再把它们当别名暴露，
 * 只在读取默认模型时兜底识别一次。
 */
const m1_LEGACY_MODEL_SUFFIXES = ['model', 'label']

/** 入参边界（超过即拒绝并给出明确提示，而不是让远端 API 去试错）。 */
const m1_LIMITS = {
  prompt: 4000,
  textLines: 20,
  textLineLen: 200,
  minCount: 1,
  maxCount: 4,
  model: 200,
  seedMin: 0,
  seedMax: 2_147_483_647,
  /** 参考图：本地文件读取上限。 */
  imageFileBytes: 10 * 1024 * 1024,
  /** 参考图：base64 data URI 长度上限。 */
  imageDataUri: 15 * 1024 * 1024,
}

/**
 * 插件配置。每个字段都 `.volatile()`：改动经 configEditor 落 profile 后由 Loader
 * 原地热更，不重启进程；工具每次调用现读（见 m1_apply 里的 imagegenConfig）。
 *
 * 兼容性说明：`.volatile()` 由 schemastery 3.18.3 引入，DSH 0.2.x 提供的是 ~3.18.4。
 * 若宿主自带的是更老的 schemastery（0.1.x 那代是 3.18.2），这里不抛错、只是不加
 * volatile —— 此时插件仍能加载与出图，但设置页（需要 volatile 字段）不可用。
 */
const m1_volatileFields = typeof dep_Schema.object({}).volatile === 'function'

/** 需要热更的字段包一层 volatile；老 schemastery 上原样返回。 */
function m1_live(field) {
  return m1_volatileFields ? field.volatile() : field
}

const m1_Config = dep_Schema.object({
  /** 默认通道名。不收窄成 union：自定义通道名在运行期解析。 */
  defaultProvider: m1_live(dep_Schema.string().default('doubao')),
  /** 每个通道的 API key，按通道名索引。 */
  apiKeys: m1_live(dep_Schema.dict(dep_Schema.string().role('secret')).default({})),
  /** 每个通道的 endpoint 覆盖（裸主机 / 以 /v1 结尾 / 完整地址都能吃）。 */
  baseUrls: m1_live(dep_Schema.dict(dep_Schema.string()).default({})),
  /**
   * 每个通道使用的模型 id：自由填写。
   * 值是字符串；也可以写 `{ id: '...', label: '...' }` 给个显示名。
   * 键支持 `<通道>` 与 `<通道>/<别名>`（别名供工具入参 model 引用）。
   */
  models: m1_live(dep_Schema.dict(dep_Schema.any()).default({})),
  /** 自定义通道声明（任意 OpenAI 风格 images/generations）。 */
  customProviders: m1_live(dep_Schema.dict(dep_Schema.any()).default({})),
  /** 落盘目录；空串 = 启动目录下的 generated-images。 */
  outDir: m1_live(dep_Schema.string().default('')),
  /** 是否把生成的图片作为会话附件（影响对话内嵌显示）。 */
  attachToConversation: m1_live(dep_Schema.boolean().default(true)),
  /** 默认张数。 */
  count: m1_live(dep_Schema.number().step(1).min(m1_LIMITS.minCount).max(m1_LIMITS.maxCount).default(m1_LIMITS.minCount)),
  /** 默认长宽比。 */
  aspect: m1_live(dep_Schema.union(['1:1', '2:3', '3:4', '9:16', '16:9']).default('2:3')),
  /** 单次请求超时。 */
  requestTimeoutMs: m1_live(dep_Schema.number().default(300_000)),
})

/** qwen 专用质量负面提示词（豆包与多数本地模型不支持该参数）。 */
const m1_NEGATIVE_PROMPT = '低分辨率、模糊、畸变、肢体错误、多余手指、文字乱码或错字、水印、重复元素、低质量'

/** 追加到提示词末尾的质量要求（豆包默认偏浅色 PPT 风，必须显式压风格与细节）。 */
const m1_QUALITY_SUFFIX = '\n画面要求：专业级商业设计，构图完整、光影自然、细节精致、色彩协调；风格与主色调以用户指定为准。'

/** 内联路由支持的扩展名 → 响应 Content-Type。 */
const m1_INLINE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/**
 * 把用户文案逐字嵌入提示词，禁止模型/平台改写。
 * @param {string} description - 画面描述。
 * @param {string[] | undefined} textLines - 必须逐字出现的文字行。
 * @returns {string} 完整提示词。
 */
function m1_buildPrompt(description, textLines) {
  const parts = [description]
  if (textLines !== undefined && textLines.length > 0) {
    const verbatim = textLines.map((line) => `「${line}」`).join('')
    parts.push(
      `图内需要出现的文字（必须逐字精确渲染，顺序、标点、换行一致，严禁增删改字或用同义替换）：${verbatim}`,
    )
  }
  return parts.join('\n') + m1_QUALITY_SUFFIX
}

/**
 * 读一个「可能是 volatile 引用」的配置字段。
 *
 * 为什么需要它：带 `m1_Config` 导出的插件，m1_apply 入参的 volatile 字段在部分组合形态下
 * 是 boxed ref（`{ get() }` 容器）而非裸值。两种形态都解。
 * @param {unknown} field - 配置字段（裸值或 ref）。
 * @param {unknown} fallback - 两者都取不到时的兜底。
 * @returns {unknown} 解箱后的值。
 */
function m1_unbox(field, fallback) {
  if (field === undefined || field === null) return fallback
  if (typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined || value === null ? fallback : value
  }
  return field
}

/**
 * 模型声明归一化：字符串，或 `{ id, label }`。
 * @param {unknown} value - models 字典里的一个条目。
 * @returns {{ id: string, label?: string } | undefined} 归一化后的声明。
 */
function m1_modelSpec(value) {
  if (typeof value === 'string') {
    const id = value.trim()
    return id === '' ? undefined : { id }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const id = typeof value.id === 'string' ? value.id.trim() : ''
    if (id === '') return undefined
    const label = typeof value.label === 'string' && value.label.trim() !== '' ? value.label.trim() : undefined
    return label === undefined ? { id } : { id, label }
  }
  return undefined
}

/**
 * models 字典（`<通道>` 或 `<通道>/<别名>`）→ 小写键的查找表。
 * @param {unknown} models - 配置里的 models。
 * @returns {Map<string, { id: string, label?: string }>} 查找表。
 */
function m1_modelEntries(models) {
  const table = new Map()
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return table
  for (const [key, value] of Object.entries(models)) {
    const spec = m1_modelSpec(value)
    if (spec === undefined) continue
    table.set(String(key).trim().toLowerCase(), spec)
  }
  return table
}

/**
 * 某通道的默认模型 id（未配置时返回 undefined，由调用方回落内置快照 id）。
 *
 * 读法（按优先级）：
 *   1. `models.<通道>` —— 规范键，设置页模型行写的就是它；
 *   2. `models.<通道>/default` —— 等价写法；
 *   3. `models.<通道>/model` —— 0.3.1 卡片写下的遗留键，读取期兜底一次，
 *      下次在设置页保存会被迁移成规范键（见客户端 buildSaveOps）。
 * @param {string} name - 通道名。
 * @param {Map<string, { id: string }>} table - models 查找表。
 * @returns {string | undefined} 模型 id。
 */
function m1_defaultModelFor(name, table) {
  const key = name.toLowerCase()
  return table.get(key)?.id
    ?? table.get(`${key}/default`)?.id
    ?? table.get(`${key}/model`)?.id
}

/**
 * 某通道可被别名引用的模型（models 里 `<通道>/<别名>` 形式的条目）。
 *
 * `model` / `label` 是 0.3.1 卡片遗留的模型单元格键，对内置通道必须排除：
 * 否则历史配置会额外冒出一个名为 `model` 的假别名。自定义通道不受影响。
 * @param {string} name - 通道名。
 * @param {Map<string, { id: string, label?: string }>} table - models 查找表。
 * @returns {{ alias: string, id: string, label?: string }[]} 候选模型。
 */
function m1_modelOptionsFor(name, table) {
  const key = name.toLowerCase()
  const reservedAliases = __ns_0.BUILTIN_PROVIDERS.includes(key) ? m1_LEGACY_MODEL_SUFFIXES : []
  const options = []
  for (const [entryKey, spec] of table) {
    const [channel, ...rest] = entryKey.split('/')
    if (channel !== key) continue
    const alias = rest.join('/')
    if (alias === '' || alias === 'default') continue
    if (reservedAliases.includes(alias)) continue
    options.push({ alias, ...spec })
  }
  return options
}

/**
 * 解析工具入参 `model`：接受别名，也接受任意模型 id（自由填写的落点）。
 * @param {string} requested - 入参原始值。
 * @param {string} channel - 目标通道名。
 * @param {string | undefined} fallbackId - 通道默认模型 id。
 * @param {Map<string, { id: string }>} table - models 查找表。
 * @returns {string} 最终模型 id。
 */
function m1_resolveRequestedModel(requested, channel, fallbackId, table) {
  const candidate = requested.trim()
  if (candidate === '') return fallbackId ?? candidate
  const options = m1_modelOptionsFor(channel, table)
  const byAlias = options.find((option) => option.alias === candidate)
  if (byAlias !== undefined) return byAlias.id
  const byId = options.find((option) => option.id === candidate)
  if (byId !== undefined) return byId.id
  return candidate
}

/**
 * 校验工具入参；违规即抛可读错误（发生在任何 IO 之前）。
 * count 未传时返回 undefined，由调用方回落到配置默认值。
 * @param {Record<string, unknown>} args - 模型给出的原始入参。
 * @param {string} outDir - 落盘目录。
 * @returns {{ count?: number, seed?: number, model?: string }} 已校验的可选入参。
 */
function m1_validateRequest(args, outDir) {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (prompt.length === 0) throw new Error('generate_image: prompt 不能为空')
  if (prompt.length > m1_LIMITS.prompt) throw new Error(`generate_image: prompt 过长（上限 ${m1_LIMITS.prompt} 字符）`)

  if (args.text_lines !== undefined) {
    if (!Array.isArray(args.text_lines) || args.text_lines.some((line) => typeof line !== 'string')) {
      throw new Error('generate_image: text_lines 必须是字符串数组')
    }
    if (args.text_lines.length > m1_LIMITS.textLines) {
      throw new Error(`generate_image: text_lines 最多 ${m1_LIMITS.textLines} 行`)
    }
    for (const line of args.text_lines) {
      if (line.length > m1_LIMITS.textLineLen) {
        throw new Error(`generate_image: 单行文字超过 ${m1_LIMITS.textLineLen} 字符（逐字渲染成功率下降，请精简）`)
      }
    }
  }

  const count = args.count
  if (count !== undefined && (!Number.isInteger(count) || count < m1_LIMITS.minCount || count > m1_LIMITS.maxCount)) {
    throw new Error(`generate_image: count 必须是 ${m1_LIMITS.minCount}–${m1_LIMITS.maxCount} 的整数`)
  }

  if (args.seed !== undefined
    && (!Number.isInteger(args.seed) || args.seed < m1_LIMITS.seedMin || args.seed > m1_LIMITS.seedMax)) {
    throw new Error(`generate_image: seed 必须在 ${m1_LIMITS.seedMin}–${m1_LIMITS.seedMax} 之间`)
  }

  let model
  if (args.model !== undefined) {
    if (typeof args.model !== 'string' || args.model.trim() === '') {
      throw new Error('generate_image: model 必须是非空字符串（模型 id 或 models 配置里的别名）')
    }
    if (args.model.trim().length > m1_LIMITS.model) {
      throw new Error(`generate_image: model 过长（上限 ${m1_LIMITS.model} 字符）`)
    }
    model = args.model.trim()
  }

  if (outDir.length === 0) throw new Error('generate_image: 未配置落盘目录（config.outDir）')
  if (!dep_isAbsolute(outDir)) throw new Error(`generate_image: outDir 必须是绝对路径，当前为 ${outDir}`)
  return { count, seed: args.seed, model }
}

/**
 * 解析参考图入参：URL 原样透传；data URI 校验后透传；本地绝对路径读成 base64。
 * @param {unknown} raw - image 入参。
 * @returns {Promise<string | undefined>} 可直接发给通道的参考图。
 */
async function m1_resolveImageInput(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new Error('generate_image: image 必须是字符串（URL / 本地绝对路径 / data URI）')
  const value = raw.trim()
  if (value === '') return undefined
  if (/^https?:\/\//iu.test(value)) return value
  if (/^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)) {
    if (value.length > m1_LIMITS.imageDataUri) {
      throw new Error(`generate_image: 参考图 data URI 超过 ${Math.round(m1_LIMITS.imageDataUri / 1024 / 1024)}MB`)
    }
    return value
  }
  if (!dep_isAbsolute(value)) throw new Error(`generate_image: image 本地路径必须是绝对路径，当前为 ${value}`)
  let data
  try {
    data = await dep_readFile(value)
  } catch {
    throw new Error(`generate_image: 读取参考图失败（文件不存在或不可读）：${value}`)
  }
  if (data.byteLength === 0) throw new Error(`generate_image: 参考图是空文件：${value}`)
  if (data.byteLength > m1_LIMITS.imageFileBytes) {
    throw new Error(`generate_image: 参考图超过 ${Math.round(m1_LIMITS.imageFileBytes / 1024 / 1024)}MB`)
  }
  const ext = dep_extname(value).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${data.toString('base64')}`
}

/** 单张图片生成结果（落盘 + 可选附件）的规范值。 */
const m1_IMAGE_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    attached: { type: 'boolean', required: true },
    image: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', enum: ['image/png', 'image/jpeg'], required: true },
        bytes: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
        name: { type: 'string' },
      },
    },
    note: { type: 'string' },
  },
}

/** generate_image 的规范输出（模型看到的内容由 render 投影）。 */
const m1_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
    aspect: { type: 'string', required: true },
    size: { type: 'string', required: true },
    prompt: { type: 'string', required: true },
    images: { type: 'array', required: true, items: m1_IMAGE_ITEM_SCHEMA },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', required: true },
          message: { type: 'string', required: true },
        },
      },
    },
  },
}

/**
 * 注册生图工具、内联图片路由，并把设置页交给客户端卡片。
 * @param {object} ctx - 插件上下文。
 * @param {object} config - 组合入口配置（volatile 字段可能是 boxed ref）。
 */
function m1_apply(ctx, config) {
  /** 现读配置：经 m1_apply 入参的 volatile 引用，GUI 保存后无需重启即时生效。 */
  const imagegenConfig = () => ({
    defaultProvider: m1_unbox(config?.defaultProvider, 'doubao'),
    apiKeys: m1_unbox(config?.apiKeys, {}),
    baseUrls: m1_unbox(config?.baseUrls, {}),
    models: m1_unbox(config?.models, {}),
    customProviders: m1_unbox(config?.customProviders, {}),
    outDir: m1_unbox(config?.outDir, ''),
    attachToConversation: m1_unbox(config?.attachToConversation, true),
    count: m1_unbox(config?.count, m1_LIMITS.minCount),
    aspect: m1_unbox(config?.aspect, '2:3'),
    requestTimeoutMs: m1_unbox(config?.requestTimeoutMs, 300_000),
  })

  /** 当前全部通道（内置两家 + 自定义，含 models 配置的模型覆盖）。 */
  const providerTable = () => {
    const cfg = imagegenConfig()
    const models = m1_modelEntries(cfg.models)
    const rows = new Map()
    for (const builtin of __ns_0.BUILTIN_PROVIDERS) {
      const configured = m1_defaultModelFor(builtin, models)
      rows.set(builtin, __ns_0.builtinRow(builtin, {
        endpoint: cfg.baseUrls?.[builtin],
        // 规范键 `models.<通道>` 也覆盖字符串写法（m1_modelSpec 已归一化），
        // 这里不再重复读 cfg.models[builtin]，避免出现第二条读法不一致的路径。
        model: configured,
        apiKey: cfg.apiKeys?.[builtin],
      }))
    }
    for (const [key, row] of __ns_0.normalizeCustomProviders(cfg.customProviders)) {
      const fromSettings = cfg.apiKeys?.[key]
      const configured = m1_defaultModelFor(key, models)
      const withModel = configured === undefined ? row : { ...row, model: configured }
      rows.set(key, typeof fromSettings === 'string' && fromSettings.trim() !== ''
        ? { ...withModel, apiKey: fromSettings.trim() }
        : withModel)
    }
    return { rows, names: [...rows.keys()], models }
  }

  /** 解析通道名 → 归一化行；未声明即报错（错误里列出可用通道）。 */
  const resolveProvider = (providerName) => {
    const table = providerTable()
    const row = table.rows.get(providerName)
    if (row === undefined) throw __ns_0.unknownProviderError(providerName, table.names)
    return { row, models: table.models }
  }

  /** 工具描述里的通道清单（让模型知道当前能选哪些通道与模型）。 */
  const providerCatalog = () => {
    try {
      const { rows } = providerTable()
      return [...rows.values()].map((row) => `${row.name}${row.builtin ? '' : '(自定义)'} → ${row.model}`).join('；')
    } catch (error) {
      return `配置有误：${error instanceof Error ? error.message : String(error)}`
    }
  }

  // —— 会话内联展示：同源只读 /imagegen/<文件名> 路由 + 结果里的 Markdown 链接。
  // webServer 未组成的部署（CLI/无头）自动跳过。
  let inlineBaseUrl
  ctx.inject(['webServer'], (webCtx) => {
    const web = webCtx.get('webServer')
    if (web === undefined) return
    webCtx.effect(() => {
      inlineBaseUrl = process.env.DSH_WEB_URL?.replace(/\/+$/u, '') ?? `http://127.0.0.1:${web.port}`
      const dispose = web.register({
        kind: 'prefix',
        path: '/imagegen',
        handler: (req, res) => {
          try {
            if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
            const pathname = new URL(req.url ?? '/', 'http://x').pathname
            if (!pathname.startsWith('/imagegen/')) { res.writeHead(404); res.end('not found'); return }
            const fileName = decodeURIComponent(pathname.slice('/imagegen/'.length))
            // 单段文件名 + 白名单扩展名：杜绝路径穿越与任意文件读取。
            if (!/^[\w.-]+\.(?:jpg|jpeg|png|webp)$/iu.test(fileName)) { res.writeHead(404); res.end('not found'); return }
            const cfg = imagegenConfig()
            const outDir = cfg.outDir === '' ? dep_join(process.cwd(), 'generated-images') : cfg.outDir
            const file = dep_join(outDir, fileName)
            void dep_readFile(file).then((data) => {
              res.writeHead(200, {
                'content-type': m1_INLINE_MIME[dep_extname(file).toLowerCase()] ?? 'application/octet-stream',
                'content-length': String(data.byteLength),
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
              })
              if (req.method === 'HEAD') res.end()
              else res.end(data)
            }, () => { res.writeHead(404); res.end('not found') })
          } catch {
            res.writeHead(400); res.end('bad request')
          }
        },
      })
      return () => { dispose(); inlineBaseUrl = undefined }
    }, 'imagegen: inline image route')
  })

  // —— 工具注册。与 read_image 同一刀法：在 attachments 服务的作用域里注册，
  // execute 才能看见附件 store、把图片作为会话附件交给前端内嵌显示。
  ctx.inject(['attachments'], (imageCtx) => {
    imageCtx.tools.register(dep_defineTool({
      name: 'generate_image',
      description: 'Generate one or more high-quality images (default: Doubao Seedream 5.0 Pro; can switch to qwen-image-3.0-pro for denser, more accurate text, '
        + 'or to any channel configured under imagegen settings, including local deployments). '
        + `Currently available channels: ${providerCatalog()}. `
        + 'Calling rules: (1) if the user has not specified the visual style, palette/atmosphere, composition, or the exact wording to place in the image, ask the user first, then call this tool; '
        + '(2) render in-image text verbatim from the user, never add, drop, or reword characters; '
        + '(3) always state an explicit art style and palette in the description to avoid the model\u2019s default plain light-color look; '
        + '(4) default aspect is portrait 2:3 (poster); pass aspect for other ratios; '
        + '(5) exactly one image is generated by default; pass count (1\u20134) only when the user asked for several candidates or a comparison; '
        + '(6) the result contains ready-to-use Markdown image links \u2014 embed them verbatim in your reply so the images display inline in the conversation; '
        + '(7) to modify, restyle, or reference an existing image (image-to-image), pass it via the image parameter (an http(s) URL, an absolute local file path, or a data URI) and describe the desired change in prompt; '
        + '(8) pass model only to override the chosen channel\u2019s configured model for this call.',
      parameters: {
        prompt: { type: 'string', required: true, description: '完整画面描述（中文即可）：主体内容、构图、风格、主色调/氛围。必须包含明确的风格与配色描述。图生图时描述期望的修改/风格。' },
        image: { type: 'string', description: '参考图（可选）：http(s) URL、本地文件绝对路径，或 data:image/...;base64,...。提供后为图生图/基于参考图的修改重绘。' },
        provider: { type: 'string', description: '通道名（不填用配置默认值）。内置 doubao（Seedream，视觉优先）/ qwen（文字更准）；其余名字来自配置里的 customProviders。' },
        model: { type: 'string', description: '模型覆盖（可选，只影响本次调用）：可填通道配置里的模型别名，也可直接填任意模型 id。不填则用该通道配置的模型。' },
        aspect: { type: 'string', enum: ['1:1', '2:3', '3:4', '9:16', '16:9'], description: '长宽比，默认 2:3（竖版海报）。' },
        count: { type: 'integer', description: '生成几张候选（1–4），不填默认只出 1 张。' },
        text_lines: { type: 'array', items: { type: 'string' }, description: '必须原样出现在图内的文字行（逐字呈现，不得增删改）。没有则为空。' },
        seed: { type: 'integer', description: '随机种子（支持的通道生效）：固定后可复现相近构图，用于微调迭代。' },
      },
      output: {
        schema: m1_OUTPUT_SCHEMA,
        render: (_args, value) => {
          const blocks = []
          const items = Array.isArray(value.images) ? value.images : []
          for (const item of items) {
            const meta = item.image
            let envelope = `<path>${item.path}</path>\n<type>image</type>\n<content>\n`
            envelope += `${value.provider} · ${value.model} · ${value.aspect} (${value.size})\n`
            envelope += meta !== undefined
              ? `${meta.mediaType} image, ${meta.width}x${meta.height} px, ${meta.bytes} bytes`
              : item.note ?? 'file saved (not attached to the conversation)'
            envelope += '</content>'
            blocks.push({ type: 'text', text: envelope })
            if (meta !== undefined) {
              blocks.push({
                type: 'image',
                attachment: {
                  attachmentId: meta.attachmentId,
                  mediaType: meta.mediaType,
                  bytes: meta.bytes,
                  width: meta.width,
                  height: meta.height,
                  ...(meta.name === undefined ? {} : { name: meta.name }),
                },
              })
            }
          }
          const failures = Array.isArray(value.failures) ? value.failures : []
          for (const failure of failures) {
            blocks.push({ type: 'text', text: `⚠ 第 ${failure.index} 张生成失败：${failure.message}` })
          }
          if (inlineBaseUrl !== undefined && items.length > 0) {
            const links = items.map((item) => `![${dep_basename(item.path)}](${inlineBaseUrl}/imagegen/${encodeURIComponent(dep_basename(item.path))})`)
            blocks.push({
              type: 'text',
              text: '\n会话内链接（请在你的回复中使用下面的 Markdown 图片语法，逐条原样内嵌，图片会直接显示在对话里）：\n' + links.join('\n'),
            })
          }
          return blocks
        },
        presentationMeta: (_args, value) => ({
          provider: value.provider,
          model: value.model,
          paths: value.images.map((item) => item.path),
          failures: (Array.isArray(value.failures) ? value.failures : []).map((failure) => ({ index: failure.index, message: failure.message })),
        }),
      },
      async execute(args, exec) {
        const cfg = imagegenConfig()
        const outDir = cfg.outDir === '' ? dep_join(process.cwd(), 'generated-images') : cfg.outDir
        const validated = m1_validateRequest(args, outDir)
        const providerName = typeof args.provider === 'string' && args.provider.trim() !== ''
          ? args.provider.trim()
          : cfg.defaultProvider
        const aspect = typeof args.aspect === 'string' && args.aspect.trim() !== '' ? args.aspect.trim() : cfg.aspect
        // 张数：入参优先，缺省用配置默认值，并统一夹到 1–4。
        // 夹取而非抛错：旧会话回放可能带越界入参，配置也可能被手改成越界值。
        const preferred = validated.count ?? cfg.count
        const requestedCount = Math.min(Math.max(preferred, m1_LIMITS.minCount), m1_LIMITS.maxCount)

        const { row, models } = resolveProvider(providerName)
        const apiKey = __ns_0.resolveApiKey(row)
        const model = validated.model === undefined
          ? row.model
          : m1_resolveRequestedModel(validated.model, row.name, row.model, models)
        const size = row.sizeFor(aspect)
        const prompt = m1_buildPrompt(args.prompt.trim(), args.text_lines)
        // 参考图一次解析、全量复用（读文件/校验都发生在任何 API 请求之前）。
        const imageInput = await m1_resolveImageInput(args.image)
        // 超时与调用方取消合并：任意一方触发即让所有等待结束。
        const signal = AbortSignal.any([
          exec.signal ?? new AbortController().signal,
          AbortSignal.timeout(cfg.requestTimeoutMs),
        ])

        await dep_mkdir(outDir, { recursive: true })

        /**
         * 落盘 + 可选附件，返回一条规范值。
         * @param {object} image - 通道返回的图片字节。
         * @param {number} index - 本批次内的序号（用于文件名与失败定位）。
         * @returns {Promise<object>} 规范图片项。
         */
        const commitImage = async (image, index) => {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const suffix = `${stamp}-${index + 1}-${dep_randomUUID().slice(0, 4)}`
          const name = `${suffix}${image.mediaType === 'image/jpeg' ? '.jpg' : '.png'}`
          const path = dep_join(outDir, name)
          await dep_writeFile(path, image.data)

          if (cfg.attachToConversation) {
            const attachments = imageCtx.get('attachments')
            if (attachments !== undefined) {
              try {
                const ref = await attachments.saveImage({ data: image.data, mediaType: image.mediaType, name })
                return {
                  path,
                  attached: true,
                  image: {
                    attachmentId: ref.attachmentId,
                    mediaType: ref.mediaType,
                    bytes: ref.bytes,
                    width: ref.width,
                    height: ref.height,
                    ...(ref.name === undefined ? {} : { name: ref.name }),
                  },
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return { path, attached: false, note: `会话附件失败（已保留文件）：${message.slice(0, 200)}` }
              }
            }
            return { path, attached: false, note: '当前环境未挂载附件服务，仅落盘' }
          }
          return { path, attached: false, note: '配置关闭了会话附件，仅落盘' }
        }

        /** 发一次请求并把该请求返回的每一张都落盘（通道声明 supportsN 时一次出多张）。 */
        const runBatch = async (n, index, offset) => {
          const generated = await __ns_0.generateImages({
            provider: { ...row, apiKey, model },
            prompt,
            aspect,
            n,
            ...(imageInput === undefined ? {} : { image: imageInput }),
            ...(validated.seed === undefined ? {} : { seed: validated.seed + offset }),
            negativePrompt: m1_NEGATIVE_PROMPT,
            signal,
          })
          if (generated.length === 0) throw new Error('通道没有返回任何图片数据')
          const committed = []
          for (const [position, image] of generated.entries()) {
            committed.push(await commitImage(image, index + position))
          }
          return committed
        }

        // 一张一批：通道声明 supportsN 时用一次请求出多张，否则逐张并发。
        // 部分失败保留成功图；全部失败才让工具报错（模型能看到完整失败原因）。
        const settled = row.supportsN
          ? await Promise.allSettled([runBatch(requestedCount, 0, 0)])
          : await Promise.allSettled(Array.from({ length: requestedCount }, (_unused, index) => runBatch(1, index, index)))
        const images = []
        const failures = []
        settled.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            for (const item of result.value) images.push(item)
          } else {
            const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
            failures.push({ index: index + 1, message: message.slice(0, 300) })
          }
        })
        if (images.length === 0) {
          throw new Error(`generate_image: 全部 ${requestedCount} 张生成失败 — ${failures.map((failure) => `#${failure.index}: ${failure.message}`).join('；')}`)
        }
        return { provider: row.name, model, aspect, size, prompt, images, failures }
      },
    }))
  })

  // —— 设置页策略：本插件自带客户端卡片（settings.section），关掉 schemastery 自动页，
  // 避免同一个 namespace 出现两个页面。缺 settings 服务的部署直接跳过。
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })
}

/**
 * 供测试与诊断：把当前配置描述成一行行文本。
 * @param {object} config - 组合入口配置。
 * @returns {string[]} 每行一个通道。
 */
function m1_describeProviders(config) {
  const models = m1_modelEntries(m1_unbox(config?.models, {}))
  const rows = []
  for (const builtin of __ns_0.BUILTIN_PROVIDERS) {
    rows.push(__ns_0.builtinRow(builtin, {
      endpoint: m1_unbox(config?.baseUrls, {})?.[builtin],
      model: m1_defaultModelFor(builtin, models),
      apiKey: m1_unbox(config?.apiKeys, {})?.[builtin],
    }))
  }
  for (const [, row] of __ns_0.normalizeCustomProviders(m1_unbox(config?.customProviders, {}))) rows.push(row)
  return rows.map((row) => __ns_0.describeRow(row))
}

// —— 公共导出（入口模块） ——
export { m1_exportNormalizeCustomProviders as normalizeCustomProviders, m1_exportNormalizeEndpoint as normalizeEndpoint, m1_PLUGIN_NAME as name, m1_PLUGIN_INJECT as inject, m1_IMAGEGEN_SETTINGS_NS as IMAGEGEN_SETTINGS_NS, m1_Config as Config, m1_apply as apply, m1_describeProviders as describeProviders };
export default { name: m1_PLUGIN_NAME, inject: m1_PLUGIN_INJECT, apply: m1_apply, Config: m1_Config };
