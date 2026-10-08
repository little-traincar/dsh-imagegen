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

export const BUILTIN_PROVIDERS = ['doubao', 'qwen']

/** 内置 provider 的默认 endpoint；可在配置 baseUrls 里覆盖。 */
export const DEFAULT_ENDPOINTS = {
  doubao: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations',
}

export const DEFAULT_MODELS = {
  // 别名会 404；快照 ID 实测可用。
  doubao: 'doubao-seedream-5-0-pro-260628',
  qwen: 'qwen-image-3.0-pro',
}

/**
 * 每家按长宽比的默认分辨率。
 * 竖版 1152x2048 ≈ 236 万像素，落在豆包 0.3 元档；
 * 横版 16:9 提升到 2560x1440（QHD，≈ 369 万像素）以获得 2K 画质，计费档位可能上浮。
 */
export const DEFAULT_SIZES = {
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

/** 可被 signal 打断的延迟。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'))
    if (signal?.aborted) { abort(); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    void timer
  })
}

/** 带退避重试的 fetch：仅重试可重试状态与网络错误，取消立即失败。 */
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
    await response.arrayBuffer().catch(() => {}) // 排空连接，避免重试被复用/阻塞
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), signal)
  }
}

/** 按字节签名嗅探真实格式（与 read_image 同一原则，不信任元数据）。 */
function sniffImageType(data, fallback = 'image/png') {
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.byteLength >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  return fallback
}

/** 从一台本地服务常见的多种响应形状里抠出 base64 / url 列表。 */
function extractItems(payload) {
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
async function materialize(item, label, signal) {
  if (item.b64 !== undefined) {
    if (item.b64.length > MAX_INLINE_B64_CHARS) {
      throw new Error(`[imagegen] ${label} 返回的 base64 过大（>${Math.round(MAX_INLINE_B64_CHARS / 1024 / 1024)}MB）`)
    }
    const cleaned = item.b64.replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, '')
    const data = new Uint8Array(Buffer.from(cleaned, 'base64'))
    if (data.byteLength === 0) throw new Error(`[imagegen] ${label} 返回了空的图片数据`)
    return { data, mediaType: sniffImageType(data) }
  }
  const download = await fetchWithRetry(item.url, { method: 'GET' }, signal)
  if (!download.ok) throw new Error(`[imagegen] 图片下载失败 (HTTP ${download.status})`)
  const bytes = new Uint8Array(await download.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error('[imagegen] 下载到空的图片数据')
  return { data: bytes, mediaType: sniffImageType(bytes) }
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
export async function decodeImageResponse(response, label, signal) {
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, MAX_ERROR_TEXT)
    throw new Error(`[imagegen] ${label} 请求失败 (HTTP ${response.status}): ${detail}`)
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error(`[imagegen] ${label} 返回了空响应体`)

  // 1) 二进制直出：Content-Type 是图片，或不是 JSON 但字节是图片签名。
  const sniffed = sniffImageType(bytes, 'image/png')
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
    && payload.error !== undefined && extractItems(payload).length === 0) {
    throw new Error(`[imagegen] ${label} 返回错误: ${JSON.stringify(payload.error).slice(0, MAX_ERROR_TEXT)}`)
  }
  const items = extractItems(payload)
  if (items.length === 0) {
    throw new Error(`[imagegen] ${label} 响应里没有图片数据: ${JSON.stringify(payload).slice(0, 300)}`)
  }
  return Promise.all(items.map((item) => materialize(item, label, signal)))
}

/**
 * 把 URL 归一化成完整 endpoint：裸主机 / 以 /v1 结尾 / 已带完整路径都能吃。
 * @param {string} raw - 配置里的地址。
 * @returns {string} 完整 endpoint。
 */
export function normalizeEndpoint(raw) {
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
export function customRow(name, spec) {
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

/**
 * 把配置里的 customProviders 归一化成 provider 行。
 * 非法条目抛可读错误（宁可在调用时明确失败，也不要静默降级到别的通道）。
 * @param {unknown} raw - 配置里的原始表。
 * @returns {Map<string, ResolvedProvider>} 名字 → 归一化行。
 */
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

/**
 * 未在表里声明的 provider 名 → 错误对象（含可用名字提示）。
 * @param {string} name - 请求的通道名。
 * @param {string[]} available - 当前可用通道名。
 * @returns {Error} 错误。
 */
export function unknownProviderError(name, available) {
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
export async function generateImages(options) {
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

  const response = await fetchWithRetry(provider.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, options.signal)
  return decodeImageResponse(response, `${provider.name} ${provider.model}`, options.signal)
}

/** 内置 provider 的环境变量回退名。 */
const BUILTIN_KEY_ENV = {
  doubao: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'ALIYUN_API_KEY'],
}

/** 自定义 provider 的环境变量回退名（含全局兜底）。 */
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

/**
 * 取完整 API key：provider 直填 > apiKeyEnv > 内置/全局环境变量。
 * 缺失时给出可读错误（不含任何秘密）；免鉴权本地端点直接返回 undefined。
 * @param {ResolvedProvider} provider - 归一化行。
 * @returns {string | undefined} key。
 */
export function resolveApiKey(provider) {
  const direct = provider.apiKey?.trim()
  if (direct !== undefined && direct !== '') return direct
  const fromEnv = envValue(provider.apiKeyEnv)
  if (fromEnv !== undefined) return fromEnv
  const names = provider.builtin ? (BUILTIN_KEY_ENV[provider.name] ?? []) : GLOBAL_KEY_ENV
  const fallback = envValue(names)
  if (fallback !== undefined) return fallback
  if (provider.apiKeyOptional) return undefined
  const hint = provider.builtin
    ? `环境变量 ${(BUILTIN_KEY_ENV[provider.name] ?? ['ARK_API_KEY'])[0]}`
    : 'customProviders 里的 apiKey / apiKeyEnv，或环境变量 IMAGE_API_KEY'
  throw new Error(`[imagegen] 通道「${provider.name}」未配置 API key（设置页填写，或 ${hint}）`)
}

/**
 * 供设置页/诊断用的能力摘要。
 * @param {ResolvedProvider} row - 归一化行。
 * @returns {string} 一行描述。
 */
export function describeRow(row) {
  return `${row.name} (${row.builtin ? 'builtin' : 'custom'}) ${row.model} @ ${row.endpoint}`
}
