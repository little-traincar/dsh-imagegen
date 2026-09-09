/**
 * imagegen —— DSH 生图工具插件（双半侧 Cordis 插件）。
 *
 * Host 半侧职责：
 *   - 注册 generate_image 工具：双 provider（豆包 Seedream 5.0 Pro / 阿里 qwen-image-3.0-pro），
 *     文案逐字嵌入、显式关水印、落盘 + 会话附件、seed 迭代。
 *   - 把配置注册为 imagegen 设置命名空间（GUI 设置页可写，保存即生效）。
 *   - 通过 GUI 的 webServer 开放同源 /imagegen/<文件名> 只读路由 + 在工具结果里附带
 *     Markdown 图片链接，模型内嵌后图片直接显示在对话里（不依赖客户端工具卡渲染）。
 *
 * 防御性工程：
 *   - 所有入参做边界校验（长度/数量/枚举/范围），错误信息可读且不含密钥。
 *   - 并发生成用 allSettled：部分失败保留成功图并逐条标注，全部失败才报错。
 *   - 路由只读、单段文件名白名单（杜绝路径穿越）、nosniff、no-store、HEAD 支持。
 *   - 超时与 exec.signal 合并（AbortSignal.any），取消即停止等待。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
// Type-only：拉取 ctx.settings 的 Context 合并。
import type {} from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_ENDPOINTS,
  DEFAULT_SIZES,
  doubaoGenerateImage,
  qwenGenerateImage,
  resolveApiKey,
  type Aspect,
  type GeneratedImage,
  type Provider,
} from './providers.ts'

export const name = 'imagegen'

/** 工具注册表服务需在 apply 顶层可见。 */
export const inject = ['tools']

/** 设置命名空间（与浏览器半侧卡片、设置 API 配对）。 */
export const IMAGEGEN_SETTINGS_NS = 'imagegen'

/** 入参边界（超过即拒绝并给出明确提示，而不是让远端 API 去试错）。 */
const LIMITS = {
  prompt: 4000,
  textLines: 20,
  textLineLen: 200,
  minCount: 1,
  maxCount: 4,
  seedMin: 0,
  seedMax: 2_147_483_647,
  /** 参考图：本地文件读取上限。 */
  imageFileBytes: 10 * 1024 * 1024,
  /** 参考图：base64 data URI 长度上限。 */
  imageDataUri: 15 * 1024 * 1024,
} as const

export interface Config {
  defaultProvider: Provider
  apiKeys?: { doubao?: string; qwen?: string }
  baseUrls?: { doubao?: string; qwen?: string }
  models?: { doubao?: string; qwen?: string }
  outDir: string
  attachToConversation: boolean
  count: number
  aspect: Aspect
  requestTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  defaultProvider: Schema.union(['doubao', 'qwen']).default('doubao'),
  apiKeys: Schema.object({
    // role('secret')：值不出现在任何响应里，卡片只显示“已配置/未配置”。
    doubao: Schema.string().role('secret'),
    qwen: Schema.string().role('secret'),
  }).default({}),
  baseUrls: Schema.object({
    doubao: Schema.string(),
    qwen: Schema.string(),
  }).default({}),
  models: Schema.object({
    doubao: Schema.string(),
    qwen: Schema.string(),
  }).default({}),
  outDir: Schema.string().default(''),
  attachToConversation: Schema.boolean().default(true),
  count: Schema.number().default(2),
  aspect: Schema.union(['1:1', '2:3', '3:4', '9:16', '16:9']).default('2:3'),
  requestTimeoutMs: Schema.number().default(300_000),
})

const DEFAULT_MODELS: Record<Provider, string> = {
  // 别名会 404；快照 ID 实测可用。
  doubao: 'doubao-seedream-5-0-pro-260628',
  qwen: 'qwen-image-3.0-pro',
}

/** qwen 专用质量负面提示词（豆包不支持该参数）。 */
const NEGATIVE_PROMPT = '低分辨率、模糊、畸变、肢体错误、多余手指、文字乱码或错字、水印、重复元素、低质量'

/** 追加到提示词末尾的质量要求（豆包默认偏浅色 PPT 风，必须显式压风格与细节）。 */
const QUALITY_SUFFIX = '\n画面要求：专业级商业设计，构图完整、光影自然、细节精致、色彩协调；风格与主色调以用户指定为准。'

/** 内联路由支持的扩展名 → 响应 Content-Type。 */
const INLINE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/** 把用户文案逐字嵌入提示词，禁止模型/平台改写。 */
function buildPrompt(description: string, textLines?: string[]): string {
  const parts = [description]
  if (textLines !== undefined && textLines.length > 0) {
    const verbatim = textLines.map((line) => `「${line}」`).join('')
    parts.push(
      `图内需要出现的文字（必须逐字精确渲染，顺序、标点、换行一致，严禁增删改字或用同义替换）：${verbatim}`,
    )
  }
  return parts.join('\n') + QUALITY_SUFFIX
}

/** 校验工具入参；违规即抛可读错误（发生在任何 IO 之前）。 */
function validateRequest(args: Record<string, unknown>, outDir: string): { count: number; seed?: number } {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (prompt.length === 0) throw new Error('generate_image: prompt 不能为空')
  if (prompt.length > LIMITS.prompt) throw new Error(`generate_image: prompt 过长（上限 ${LIMITS.prompt} 字符）`)

  if (args.text_lines !== undefined) {
    if (!Array.isArray(args.text_lines) || args.text_lines.some((l) => typeof l !== 'string')) {
      throw new Error('generate_image: text_lines 必须是字符串数组')
    }
    if (args.text_lines.length > LIMITS.textLines) throw new Error(`generate_image: text_lines 最多 ${LIMITS.textLines} 行`)
    for (const line of args.text_lines as string[]) {
      if (line.length > LIMITS.textLineLen) throw new Error(`generate_image: 单行文字超过 ${LIMITS.textLineLen} 字符（逐字渲染成功率下降，请精简）`)
    }
  }

  const count = args.count
  if (count !== undefined && (!Number.isInteger(count) || (count as number) < LIMITS.minCount || (count as number) > LIMITS.maxCount)) {
    throw new Error(`generate_image: count 必须是 ${LIMITS.minCount}–${LIMITS.maxCount} 的整数`)
  }

  if (args.seed !== undefined
    && (!Number.isInteger(args.seed) || (args.seed as number) < LIMITS.seedMin || (args.seed as number) > LIMITS.seedMax)) {
    throw new Error(`generate_image: seed 必须在 ${LIMITS.seedMin}–${LIMITS.seedMax} 之间（仅 qwen 生效）`)
  }

  if (outDir.length === 0) throw new Error('generate_image: 未配置落盘目录（cordis.yml 的 config.outDir）')
  if (!isAbsolute(outDir)) throw new Error(`generate_image: outDir 必须是绝对路径，当前为 ${outDir}`)
  return { count: (count ?? 2) as number, seed: args.seed as number | undefined }
}

/** 解析参考图入参：URL 原样透传；data URI 校验后透传；本地绝对路径读成 base64。 */
async function resolveImageInput(raw: unknown): Promise<string | undefined> {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new Error('generate_image: image 必须是字符串（URL / 本地绝对路径 / data URI）')
  const value = raw.trim()
  if (value === '') return undefined
  if (/^https?:\/\//iu.test(value)) return value
  if (/^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)) {
    if (value.length > LIMITS.imageDataUri) throw new Error(`generate_image: 参考图 data URI 超过 ${Math.round(LIMITS.imageDataUri / 1024 / 1024)}MB`)
    return value
  }
  if (!isAbsolute(value)) throw new Error(`generate_image: image 本地路径必须是绝对路径，当前为 ${value}`)
  let data: Buffer
  try {
    data = await readFile(value)
  } catch {
    throw new Error(`generate_image: 读取参考图失败（文件不存在或不可读）：${value}`)
  }
  if (data.byteLength === 0) throw new Error(`generate_image: 参考图是空文件：${value}`)
  if (data.byteLength > LIMITS.imageFileBytes) throw new Error(`generate_image: 参考图超过 ${Math.round(LIMITS.imageFileBytes / 1024 / 1024)}MB`)
  const ext = extname(value).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${data.toString('base64')}`
}

/** 单张图片生成结果（落盘 + 可选附件）的规范值片段。 */
interface ImageItemValue {
  path: string
  attached: boolean
  image?: {
    attachmentId: string
    mediaType: 'image/png' | 'image/jpeg'
    bytes: number
    width: number
    height: number
    name?: string
  }
  note?: string
}

const IMAGE_ITEM_SCHEMA = {
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
} as const

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
    aspect: { type: 'string', required: true },
    size: { type: 'string', required: true },
    prompt: { type: 'string', required: true },
    images: { type: 'array', required: true, items: IMAGE_ITEM_SCHEMA },
    // 部分失败的逐条说明；全部失败时工具直接抛错（isError），此字段为 []。
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
} as const

/** webServer 服务的最小运行时契约（避免跨插件值依赖）。 */
interface WebServerLike {
  port: number
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 附件保存返回的最小形态。 */
interface ImageAttachmentRefLike {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg'
  bytes: number
  width: number
  height: number
  name?: string
}

export function apply(ctx: Context, config: Config): void {
  // 运行期配置源：初始为 cordis.yml 入口配置；installSection 挂接后由
  // setSource 换成设置文档的权威读取 thunk。工具每次调用都现读 current()，
  // 因此 GUI 保存的 key/地址即时生效。
  let current: () => Config = () => config

  const providerModel = (provider: Provider): string =>
    current().models?.[provider]?.trim() || DEFAULT_MODELS[provider]
  const providerApiKey = (provider: Provider): string => resolveApiKey(provider, current().apiKeys?.[provider])
  const providerEndpoint = (provider: Provider): string =>
    current().baseUrls?.[provider]?.trim() || DEFAULT_ENDPOINTS[provider]

  // —— 会话内联展示：同源只读 /imagegen/<文件名> 路由 + 结果里的 Markdown 链接。
  // webServer 未组成的部署（CLI/无头）自动跳过；路由带穿越防护与响应加固。
  let inlineBaseUrl: string | undefined
  ctx.inject(['webServer'], (webCtx) => {
    const web = webCtx.get('webServer') as WebServerLike | undefined
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
            const name = decodeURIComponent(pathname.slice('/imagegen/'.length))
            // 单段文件名 + 白名单扩展名：杜绝路径穿越与任意文件读取。
            if (!/^[\w.-]+\.(?:jpg|jpeg|png|webp)$/iu.test(name)) { res.writeHead(404); res.end('not found'); return }
            const file = join(current().outDir, name)
            void readFile(file).then((data) => {
              res.writeHead(200, {
                'content-type': INLINE_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
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

  // 与 read_image 同一姿势：在 attachments 服务的作用域里注册工具，execute
  // 才能看见附件 store。附件服务未挂载的部署不注册本工具。
  ctx.inject(['attachments'], (imageCtx) => {
    imageCtx.tools.register(defineTool({
      name: 'generate_image',
      description: 'Generate one or more high-quality images (default: Doubao Seedream 5.0 Pro; can switch to qwen-image-3.0-pro for denser, more accurate text). '
        + 'Calling rules: (1) if the user has not specified the visual style, palette/atmosphere, composition, or the exact wording to place in the image, ask the user first, then call this tool; '
        + '(2) render in-image text verbatim from the user, never add, drop, or reword characters; '
        + '(3) always state an explicit art style and palette in the description to avoid the model\u2019s default plain light-color look; '
        + '(4) default aspect is portrait 2:3 (poster); pass aspect for other ratios; '
        + '(5) pass count > 1 to produce candidates to choose from; '
        + '(6) the result contains ready-to-use Markdown image links — embed them verbatim in your reply so the images display inline in the conversation; '
        + '(7) to modify, restyle, or reference an existing image (image-to-image), pass it via the image parameter (an http(s) URL, an absolute local file path, or a data URI) and describe the desired change in prompt.',
      parameters: {
        prompt: { type: 'string', required: true, description: '完整画面描述（中文即可）：主体内容、构图、风格、主色调/氛围。必须包含明确的风格与配色描述。图生图时描述期望的修改/风格。' },
        image: { type: 'string', description: '参考图（可选）：http(s) URL、本地文件绝对路径，或 data:image/...;base64,...。提供后为图生图/基于参考图的修改重绘。' },
        provider: { type: 'string', enum: ['doubao', 'qwen'], description: '服务商：doubao（默认，视觉优先）或 qwen（文字更准）。不填用配置默认。' },
        aspect: { type: 'string', enum: ['1:1', '2:3', '3:4', '9:16', '16:9'], description: '长宽比，默认 2:3（竖版海报）。' },
        count: { type: 'integer', description: '生成几张候选（1–4），默认取配置值 2。' },
        text_lines: { type: 'array', items: { type: 'string' }, description: '必须原样出现在图内的文字行（逐字呈现，不得增删改）。没有则为空。' },
        seed: { type: 'integer', description: '随机种子（仅 qwen 生效）：固定后可复现相近构图，用于微调迭代。' },
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value): ContentBlock[] => {
          const blocks: ContentBlock[] = []
          for (const item of value.images) {
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
          // 部分失败逐条告知模型（旧日志回放可能没有该字段，做空值防御）。
          const failures = Array.isArray(value.failures) ? value.failures : []
          for (const failure of failures) {
            blocks.push({ type: 'text', text: `⚠ 第 ${failure.index} 张生成失败：${failure.message}` })
          }
          // 内联展示：同源 Markdown 图片链接（仅成功图）。模型把它们原样写进
          // 回复，GUI 的 Markdown 渲染即显示图片；无 webServer 时整体跳过。
          if (inlineBaseUrl !== undefined && value.images.length > 0) {
            const links = value.images.map((item: ImageItemValue) =>
              `![${basename(item.path)}](${inlineBaseUrl}/imagegen/${encodeURIComponent(basename(item.path))})`)
            blocks.push({
              type: 'text',
              text: '\n会话内联链接（请在你的回复中使用下面的 Markdown 图片语法、逐条原样内嵌，图片会直接显示在对话里）：\n' + links.join('\n'),
            })
          }
          return blocks
        },
        presentationMeta: (_args, value) => ({
          provider: value.provider,
          paths: value.images.map((item: ImageItemValue) => item.path),
          failures: (Array.isArray(value.failures) ? value.failures : []).map((f) => ({ index: f.index, message: f.message })),
        }),
      },
      async execute(args, exec): Promise<unknown> {
        const cfg = current()
        const validated = validateRequest(args, cfg.outDir)
        const provider: Provider = args.provider ?? cfg.defaultProvider
        const aspect: Aspect = args.aspect ?? cfg.aspect
        const requestedCount = validated.count

        const model = providerModel(provider)
        const apiKey = providerApiKey(provider)
        const endpoint = providerEndpoint(provider)
        const size = DEFAULT_SIZES[provider][aspect]
        const prompt = buildPrompt((args.prompt as string).trim(), args.text_lines as string[] | undefined)
        // 参考图一次解析、全量复用（读文件/校验都发生在任何 API 请求之前）。
        const imageInput = await resolveImageInput(args.image)
        const outDir = cfg.outDir
        // 超时与调用方取消合并：任何一方触发即中止所有等待。
        const signal = AbortSignal.any([
          exec.signal ?? new AbortController().signal,
          AbortSignal.timeout(cfg.requestTimeoutMs),
        ])

        await mkdir(outDir, { recursive: true })

        const generateOne = async (index: number): Promise<ImageItemValue> => {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const suffix = `${stamp}-${index + 1}-${randomUUID().slice(0, 4)}`
          const image: GeneratedImage = provider === 'doubao'
            ? await doubaoGenerateImage({ apiKey, model, prompt, size, image: imageInput, endpoint, signal })
            : await qwenGenerateImage({
                apiKey,
                model,
                prompt,
                size,
                image: imageInput,
                endpoint,
                seed: validated.seed === undefined ? undefined : validated.seed + index,
                negativePrompt: NEGATIVE_PROMPT,
                signal,
              })
          // 扩展名跟随真实字节格式（豆包实际返回 JPEG）。
          const name = `${suffix}${image.mediaType === 'image/jpeg' ? '.jpg' : '.png'}`
          const path = join(outDir, name)
          await writeFile(path, image.data)

          if (cfg.attachToConversation) {
            const attachments = imageCtx.get('attachments') as { saveImage(input: { data: Uint8Array; mediaType: 'image/png' | 'image/jpeg'; name?: string }): Promise<ImageAttachmentRefLike> } | undefined
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
              } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error)
                return { path, attached: false, note: `会话附件失败（已保留文件）: ${message.slice(0, 200)}` }
              }
            }
            return { path, attached: false, note: '当前环境未挂载附件服务，仅落盘' }
          }
          return { path, attached: false, note: '配置关闭了会话附加，仅落盘' }
        }

        // 部分失败保留成功图；全部失败才让工具报错（模型可看到完整失败原因）。
        const settled = await Promise.allSettled(Array.from({ length: requestedCount }, (_, i) => generateOne(i)))
        const images: ImageItemValue[] = []
        const failures: Array<{ index: number; message: string }> = []
        settled.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            images.push(result.value)
          } else {
            const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
            failures.push({ index: i + 1, message: message.slice(0, 300) })
          }
        })
        if (images.length === 0) {
          throw new Error(`generate_image: 全部 ${requestedCount} 张生成失败 — ${failures.map((f) => `#${f.index}: ${f.message}`).join('；')}`)
        }
        return { provider, model, aspect, size, prompt, images, failures }
      },
    }))
  })

  // 设置集成：入口层 = cordis.yml 配置，用户层（GUI 设置页）盖在其上。
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, IMAGEGEN_SETTINGS_NS, Config, config, {
      validate: () => {},
      // 契约：setSource 收到的是读取权威值的 thunk；工具每次调用现读。
      setSource: (source) => { current = source },
      onChange: () => {},
    })
  })
}
