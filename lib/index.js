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
const m0_BUILTIN_PROVIDERS = ['doubao', 'qwen']

const m0_DEFAULT_ENDPOINTS = {
  doubao: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations',
}

const m0_DEFAULT_MODELS = {

  doubao: 'doubao-seedream-5-0-pro-260628',
  qwen: 'qwen-image-3.0-pro',
}

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

function m0_sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'))
    if (signal?.aborted) { abort(); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    void timer
  })
}

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
    await response.arrayBuffer().catch(() => {})
    await m0_sleep(m0_RETRY_BASE_MS * 2 ** (attempt - 1), signal)
  }
}

function m0_sniffImageType(data, fallback = 'image/png') {
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.byteLength >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  return fallback
}

function m0_extractItems(payload) {
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

async function m0_decodeImageResponse(response, label, signal) {
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, m0_MAX_ERROR_TEXT)
    throw new Error(`[imagegen] ${label} 请求失败 (HTTP ${response.status}): ${detail}`)
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error(`[imagegen] ${label} 返回了空响应体`)

  const sniffed = m0_sniffImageType(bytes, 'image/png')
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
    && payload.error !== undefined && m0_extractItems(payload).length === 0) {
    throw new Error(`[imagegen] ${label} 返回错误: ${JSON.stringify(payload.error).slice(0, m0_MAX_ERROR_TEXT)}`)
  }
  const items = m0_extractItems(payload)
  if (items.length === 0) {
    throw new Error(`[imagegen] ${label} 响应里没有图片数据: ${JSON.stringify(payload).slice(0, 300)}`)
  }
  return Promise.all(items.map((item) => m0_materialize(item, label, signal)))
}

function m0_normalizeEndpoint(raw) {
  const value = raw.trim().replace(/\/+$/u, '')
  if (value === '') return value
  if (/\/images\/generations$/iu.test(value)) return value
  if (/\/v\d+$/iu.test(value)) return `${value}/images/generations`
  return `${value}/v1/images/generations`
}

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

    sendPromptExtend: !isDoubao,

    sendN: true,
    sendSeed: !isDoubao,
    sendNegativePrompt: !isDoubao,
    imageField: 'image',
    responseFormat: 'b64_json',
    extraBody: {},
  }
}

function m0_customRow(name, spec) {

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

function m0_unknownProviderError(name, available) {
  return new Error(
    `[imagegen] 未知 provider「${name}」。可用：${available.join(' / ')}`
    + '（新增通道请在设置页 customProviders 或 cordis.patch.yml 里声明 baseUrl + model）',
  )
}

async function m0_generateImages(options) {
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

  const response = await m0_fetchWithRetry(provider.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, options.signal)
  return m0_decodeImageResponse(response, `${provider.name} ${provider.model}`, options.signal)
}

const m0_BUILTIN_KEY_ENV = {
  doubao: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'ALIYUN_API_KEY'],
}

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

function m0_describeRow(row) {
  return `${row.name} (${row.builtin ? 'builtin' : 'custom'}) ${row.model} @ ${row.endpoint}`
}

// —— index.js ——
const __ns_0 = { BUILTIN_PROVIDERS: m0_BUILTIN_PROVIDERS, DEFAULT_ENDPOINTS: m0_DEFAULT_ENDPOINTS, DEFAULT_MODELS: m0_DEFAULT_MODELS, DEFAULT_SIZES: m0_DEFAULT_SIZES, DEFAULT_CUSTOM_SIZES: m0_DEFAULT_CUSTOM_SIZES, fetchWithRetry: m0_fetchWithRetry, decodeImageResponse: m0_decodeImageResponse, normalizeEndpoint: m0_normalizeEndpoint, builtinRow: m0_builtinRow, customRow: m0_customRow, normalizeCustomProviders: m0_normalizeCustomProviders, unknownProviderError: m0_unknownProviderError, generateImages: m0_generateImages, resolveApiKey: m0_resolveApiKey, describeRow: m0_describeRow };

const m1_exportNormalizeCustomProviders = __ns_0.normalizeCustomProviders
const m1_exportNormalizeEndpoint = __ns_0.normalizeEndpoint


const m1_PLUGIN_NAME = 'imagegen'

const m1_PLUGIN_INJECT = ['tools']



const m1_IMAGEGEN_SETTINGS_NS = 'imagegen'

const m1_LEGACY_MODEL_SUFFIXES = ['model', 'label']

const m1_LIMITS = {
  prompt: 4000,
  textLines: 20,
  textLineLen: 200,
  minCount: 1,
  maxCount: 4,
  model: 200,
  seedMin: 0,
  seedMax: 2_147_483_647,

  imageFileBytes: 10 * 1024 * 1024,

  imageDataUri: 15 * 1024 * 1024,
}

const m1_volatileFields = typeof dep_Schema.object({}).volatile === 'function'

function m1_live(field) {
  return m1_volatileFields ? field.volatile() : field
}

const m1_Config = dep_Schema.object({

  defaultProvider: m1_live(dep_Schema.string().default('doubao')),

  apiKeys: m1_live(dep_Schema.dict(dep_Schema.string().role('secret')).default({})),

  baseUrls: m1_live(dep_Schema.dict(dep_Schema.string()).default({})),

  models: m1_live(dep_Schema.dict(dep_Schema.any()).default({})),

  customProviders: m1_live(dep_Schema.dict(dep_Schema.any()).default({})),

  outDir: m1_live(dep_Schema.string().default('')),

  attachToConversation: m1_live(dep_Schema.boolean().default(true)),

  count: m1_live(dep_Schema.number().step(1).min(m1_LIMITS.minCount).max(m1_LIMITS.maxCount).default(m1_LIMITS.minCount)),

  aspect: m1_live(dep_Schema.union(['1:1', '2:3', '3:4', '9:16', '16:9']).default('2:3')),

  requestTimeoutMs: m1_live(dep_Schema.number().default(300_000)),
})

const m1_NEGATIVE_PROMPT = '低分辨率、模糊、畸变、肢体错误、多余手指、文字乱码或错字、水印、重复元素、低质量'

const m1_QUALITY_SUFFIX = '\n画面要求：专业级商业设计，构图完整、光影自然、细节精致、色彩协调；风格与主色调以用户指定为准。'

const m1_INLINE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

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

function m1_unbox(field, fallback) {
  if (field === undefined || field === null) return fallback
  if (typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined || value === null ? fallback : value
  }
  return field
}

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

function m1_defaultModelFor(name, table) {
  const key = name.toLowerCase()
  return table.get(key)?.id
    ?? table.get(`${key}/default`)?.id
    ?? table.get(`${key}/model`)?.id
}

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

function m1_apply(ctx, config) {

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

  const providerTable = () => {
    const cfg = imagegenConfig()
    const models = m1_modelEntries(cfg.models)
    const rows = new Map()
    for (const builtin of __ns_0.BUILTIN_PROVIDERS) {
      const configured = m1_defaultModelFor(builtin, models)
      rows.set(builtin, __ns_0.builtinRow(builtin, {
        endpoint: cfg.baseUrls?.[builtin],

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

  const resolveProvider = (providerName) => {
    const table = providerTable()
    const row = table.rows.get(providerName)
    if (row === undefined) throw __ns_0.unknownProviderError(providerName, table.names)
    return { row, models: table.models }
  }

  const providerCatalog = () => {
    try {
      const { rows } = providerTable()
      return [...rows.values()].map((row) => `${row.name}${row.builtin ? '' : '(自定义)'} → ${row.model}`).join('；')
    } catch (error) {
      return `配置有误：${error instanceof Error ? error.message : String(error)}`
    }
  }

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

        const preferred = validated.count ?? cfg.count
        const requestedCount = Math.min(Math.max(preferred, m1_LIMITS.minCount), m1_LIMITS.maxCount)

        const { row, models } = resolveProvider(providerName)
        const apiKey = __ns_0.resolveApiKey(row)
        const model = validated.model === undefined
          ? row.model
          : m1_resolveRequestedModel(validated.model, row.name, row.model, models)
        const size = row.sizeFor(aspect)
        const prompt = m1_buildPrompt(args.prompt.trim(), args.text_lines)

        const imageInput = await m1_resolveImageInput(args.image)

        const signal = AbortSignal.any([
          exec.signal ?? new AbortController().signal,
          AbortSignal.timeout(cfg.requestTimeoutMs),
        ])

        await dep_mkdir(outDir, { recursive: true })

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

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })
}

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
