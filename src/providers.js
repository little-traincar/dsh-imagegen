export const BUILTIN_PROVIDERS = ['doubao', 'qwen']

export const DEFAULT_ENDPOINTS = {
  doubao: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations',
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
    '1:1': '2048*2048',
    '2:3': '1152*2048',
    '3:4': '1536*2048',
    '9:16': '1080*1920',
    '16:9': '2560*1440',
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
    await response.arrayBuffer().catch(() => {})
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), signal)
  }
}

function sniffImageType(data, fallback = 'image/png') {
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.byteLength >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  return fallback
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

export async function decodeImageResponse(response, label, signal) {
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, MAX_ERROR_TEXT)
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
  return Promise.all(items.map((item) => materialize(item, label, signal)))
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
  return decodeImageResponse(response, `${provider.name} ${provider.model}`, options.signal)
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
  const names = provider.builtin ? (BUILTIN_KEY_ENV[provider.name] ?? []) : GLOBAL_KEY_ENV
  const fallback = envValue(names)
  if (fallback !== undefined) return fallback
  if (provider.apiKeyOptional) return undefined
  const hint = provider.builtin
    ? `环境变量 ${(BUILTIN_KEY_ENV[provider.name] ?? ['ARK_API_KEY'])[0]}`
    : 'customProviders 里的 apiKey / apiKeyEnv，或环境变量 IMAGE_API_KEY'
  throw new Error(`[imagegen] 通道「${provider.name}」未配置 API key（设置页填写，或 ${hint}）`)
}

export function describeRow(row) {
  return `${row.name} (${row.builtin ? 'builtin' : 'custom'}) ${row.model} @ ${row.endpoint}`
}
