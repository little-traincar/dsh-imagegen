/**
 * providers.ts —— 生图 HTTP 适配层（豆包 Seedream / 阿里 qwen-image）。
 *
 * 两家均为 OpenAI 风格 POST /images/generations；endpoint/model/key 全部可配置，
 * 默认指向官方地址（因此任意兼容网关都能即插即用）。
 *
 * 防御性约定：
 *   - watermark 一律显式 false；qwen 额外 prompt_extend:false（防止改写用户文案）。
 *   - 网络错误 / 429 / 5xx 自动退避重试（最多 3 次尝试）；4xx 与用户取消不重试
 *     （4xx 重试可能重复计费，取消是调用方意图）。
 *   - 图片格式按字节签名嗅探，不信任 API 元数据（豆包 b64 实际常为 JPEG）。
 *   - 错误消息透出服务端原文（截断），但绝不含 API key。
 */

export type Provider = 'doubao' | 'qwen'

export type Aspect = '1:1' | '2:3' | '3:4' | '9:16' | '16:9'

export type ImageMediaType = 'image/png' | 'image/jpeg'

export interface GeneratedImage {
  /** 解码后的图片字节。 */
  data: Uint8Array
  mediaType: ImageMediaType
}

/** 每家默认 endpoint；可在配置 baseUrls 里覆盖。 */
export const DEFAULT_ENDPOINTS: Record<Provider, string> = {
  doubao: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations',
}

/** 每家按长宽比的默认分辨率（豆包 1152x2048 ≈ 236 万像素，落在 0.3 元档）。 */
export const DEFAULT_SIZES: Record<Provider, Record<Aspect, string>> = {
  doubao: {
    '1:1': '2048x2048',
    '2:3': '1152x2048',
    '3:4': '1536x2048',
    '9:16': '1080x1920',
    '16:9': '1920x1080',
  },
  qwen: {
    '1:1': '2048*2048',
    '2:3': '1152*2048',
    '3:4': '1536*2048',
    '9:16': '1080*1920',
    '16:9': '1920*1080',
  },
}

const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 400
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const MAX_ERROR_TEXT = 400

/** 可被 signal 打断的延迟。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'))
    if (signal?.aborted) { abort(); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    void timer
  })
}

/** 带退避重试的 fetch：仅重试可重试状态与网络错误，取消立即失败。 */
async function fetchWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    let response: Response
    try {
      response = await fetch(url, { ...init, signal })
    } catch (error: unknown) {
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
function sniffImageType(data: Uint8Array): ImageMediaType {
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  return 'image/png'
}

interface ImageResponse {
  data?: Array<{ b64_json?: string; url?: string }>
}

/** 解析响应：优先 b64_json，其次下载 url；非法/缺失数据给出可读错误。 */
async function decodeImageResponse(response: Response, label: string, signal?: AbortSignal): Promise<GeneratedImage> {
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, MAX_ERROR_TEXT)
    throw new Error(`[imagegen] ${label} 请求失败 (HTTP ${response.status}): ${detail}`)
  }
  let payload: ImageResponse
  try {
    payload = await response.json() as ImageResponse
  } catch {
    throw new Error(`[imagegen] ${label} 响应不是合法 JSON`)
  }
  const item = payload.data?.[0]
  if (item?.b64_json) {
    const data = new Uint8Array(Buffer.from(item.b64_json.trim(), 'base64'))
    if (data.byteLength === 0) throw new Error(`[imagegen] ${label} 返回了空的图片数据`)
    return { data, mediaType: sniffImageType(data) }
  }
  if (item?.url) {
    const download = await fetchWithRetry(item.url, { method: 'GET' }, signal)
    if (!download.ok) throw new Error(`[imagegen] 图片下载失败 (HTTP ${download.status})`)
    const bytes = new Uint8Array(await download.arrayBuffer())
    if (bytes.byteLength === 0) throw new Error('[imagegen] 下载到空的图片数据')
    return { data: bytes, mediaType: sniffImageType(bytes) }
  }
  throw new Error(`[imagegen] ${label} 响应里没有图片数据: ${JSON.stringify(payload).slice(0, 300)}`)
}

/** 豆包 Seedream 单张生成。 */
export async function doubaoGenerateImage(options: {
  apiKey: string
  model: string
  prompt: string
  size: string
  endpoint?: string
  signal?: AbortSignal
}): Promise<GeneratedImage> {
  const response = await fetchWithRetry(options.endpoint ?? DEFAULT_ENDPOINTS.doubao, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      prompt: options.prompt,
      size: options.size,
      response_format: 'b64_json',
      watermark: false, // 硬性要求：不加水印
    }),
  }, options.signal)
  return decodeImageResponse(response, `豆包 ${options.model}`, options.signal)
}

/** 阿里 qwen-image 单张生成。 */
export async function qwenGenerateImage(options: {
  apiKey: string
  model: string
  prompt: string
  size: string
  seed?: number
  negativePrompt?: string
  endpoint?: string
  signal?: AbortSignal
}): Promise<GeneratedImage> {
  const body: Record<string, unknown> = {
    model: options.model,
    prompt: options.prompt,
    size: options.size,
    n: 1,
    response_format: 'b64_json',
    watermark: false, // 默认即 false，显式声明防回归
    prompt_extend: false, // 禁止平台改写提示词，保证文字逐字呈现
  }
  if (options.seed !== undefined) body.seed = options.seed
  if (options.negativePrompt !== undefined) body.negative_prompt = options.negativePrompt
  const response = await fetchWithRetry(options.endpoint ?? DEFAULT_ENDPOINTS.qwen, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(body),
  }, options.signal)
  return decodeImageResponse(response, `qwen ${options.model}`, options.signal)
}

/** 从环境变量读取 provider 的 key（配置缺省时的回退）。 */
export function apiKeyFromEnv(provider: Provider): string | undefined {
  if (provider === 'doubao') {
    return process.env.ARK_API_KEY ?? process.env.VOLCENGINE_API_KEY
  }
  return process.env.DASHSCOPE_API_KEY ?? process.env.ALIYUN_API_KEY
}

/** 取完整 API key：配置优先，其次环境变量；缺失时给出不含任何秘密的可读错误。 */
export function resolveApiKey(provider: Provider, configured?: string): string {
  const value = configured?.trim() || apiKeyFromEnv(provider)?.trim()
  if (!value) {
    const providerName = provider === 'doubao' ? '豆包' : 'qwen'
    const envName = provider === 'doubao' ? 'ARK_API_KEY' : 'DASHSCOPE_API_KEY'
    throw new Error(`[imagegen] 未配置 ${providerName} 的 API key（设置页填写，或环境变量 ${envName}）`)
  }
  return value
}
