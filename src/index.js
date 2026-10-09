/**
 * imagegen —— DSH 生图工具插件（宿主半侧）。
 *
 * 目标宿主：DSH 0.2.x（本文件按 dsh-v0.2.0-rc.2 的真实 API 编写）。
 * 与上游 0.1.x 版本的差异：
 *   - 上游用 `settings.installSection(...)`（0.1.2–0.1.6 的命名空间 API），该 API 在
 *     0.1.7+ 已被移除。本版本改为官方现行形态：静态 `Config`（字段级 `.volatile()`）
 *     + `ctx.get('configEditor').edit(...)` 落 profile；读经 apply 入参的 volatile 引用。
 *   - 工具入参新增 `model`：单次调用可临时指定模型，不必改配置。
 *   - 通道（provider）是开放表：内置 doubao / qwen，其余走 `customProviders`；
 *     每个通道的模型 id 由 `models` 自由填写。
 *
 * 运行时只依赖宿主已经提供的服务（tools / attachments / webServer / settings），
 * 缺服务一律干净降级，不在 apply 里抛错。
 *
 * 防御性工程：
 *   - 所有入参做边界校验（长度/数量/枚举/范围），错误信息可读且不含密钥。
 *   - 并发生成用 allSettled：部分失败保留成功图并逐条标注，全部失败才报错。
 *   - 路由只读、单段文件名白名单（杜绝路径穿越）、nosniff、no-store、HEAD 支持。
 *   - 超时与 exec.signal 合并（AbortSignal.any），取消即停止等待。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  BUILTIN_PROVIDERS,
  builtinRow,
  describeRow,
  generateImages,
  normalizeCustomProviders,
  normalizeEndpoint,
  resolveApiKey,
  unknownProviderError,
} from './providers.js'

// 可测试面：这两个纯函数是自检脚本与诊断入口直接调用的部分，显式对外导出。
// 注意：必须先落到本地名字再 export —— 打包器的公共导出块只接受本地标识符，
// 直接把「相对导入得到的绑定」写进 export 会生成非法的 `export { ns.member }`。
const exportNormalizeCustomProviders = normalizeCustomProviders
const exportNormalizeEndpoint = normalizeEndpoint
export { exportNormalizeCustomProviders as normalizeCustomProviders, exportNormalizeEndpoint as normalizeEndpoint }

/** 插件名。刻意不叫 name：打包器给顶层标识符加模块前缀，与对象字面量键同名会互相污染。 */
const PLUGIN_NAME = 'imagegen'

/** 工具注册表服务需在 apply 顶层可见。 */
const PLUGIN_INJECT = ['tools']

export { PLUGIN_NAME as name, PLUGIN_INJECT as inject }

/** 设置命名空间 = profile 里的 entry id；客户端卡片按同一名字读写。 */
export const IMAGEGEN_SETTINGS_NS = 'imagegen'

/**
 * 模型单元格的保留后缀：`<通道>/model` 与 `<通道>/label` 是 0.3.1 卡片写下的
 * 遗留键（写入键与读取键不一致的实现缺陷）。内置通道不再把它们当别名暴露，
 * 只在读取默认模型时兜底识别一次。
 */
const LEGACY_MODEL_SUFFIXES = ['model', 'label']

/** 入参边界（超过即拒绝并给出明确提示，而不是让远端 API 去试错）。 */
const LIMITS = {
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
 * 原地热更，不重启进程；工具每次调用现读（见 apply 里的 imagegenConfig）。
 *
 * 兼容性说明：`.volatile()` 由 schemastery 3.18.3 引入，DSH 0.2.x 提供的是 ~3.18.4。
 * 若宿主自带的是更老的 schemastery（0.1.x 那代是 3.18.2），这里不抛错、只是不加
 * volatile —— 此时插件仍能加载与出图，但设置页（需要 volatile 字段）不可用。
 */
const volatileFields = typeof Schema.object({}).volatile === 'function'

/** 需要热更的字段包一层 volatile；老 schemastery 上原样返回。 */
function live(field) {
  return volatileFields ? field.volatile() : field
}

export const Config = Schema.object({
  /** 默认通道名。不收窄成 union：自定义通道名在运行期解析。 */
  defaultProvider: live(Schema.string().default('doubao')),
  /** 每个通道的 API key，按通道名索引。 */
  apiKeys: live(Schema.dict(Schema.string().role('secret')).default({})),
  /** 每个通道的 endpoint 覆盖（裸主机 / 以 /v1 结尾 / 完整地址都能吃）。 */
  baseUrls: live(Schema.dict(Schema.string()).default({})),
  /**
   * 每个通道使用的模型 id：自由填写。
   * 值是字符串；也可以写 `{ id: '...', label: '...' }` 给个显示名。
   * 键支持 `<通道>` 与 `<通道>/<别名>`（别名供工具入参 model 引用）。
   */
  models: live(Schema.dict(Schema.any()).default({})),
  /** 自定义通道声明（任意 OpenAI 风格 images/generations）。 */
  customProviders: live(Schema.dict(Schema.any()).default({})),
  /** 落盘目录；空串 = 启动目录下的 generated-images。 */
  outDir: live(Schema.string().default('')),
  /** 是否把生成的图片作为会话附件（影响对话内嵌显示）。 */
  attachToConversation: live(Schema.boolean().default(true)),
  /** 默认张数。 */
  count: live(Schema.number().step(1).min(LIMITS.minCount).max(LIMITS.maxCount).default(LIMITS.minCount)),
  /** 默认长宽比。 */
  aspect: live(Schema.union(['1:1', '2:3', '3:4', '9:16', '16:9']).default('2:3')),
  /** 单次请求超时。 */
  requestTimeoutMs: live(Schema.number().default(300_000)),
})

/** qwen 专用质量负面提示词（豆包与多数本地模型不支持该参数）。 */
const NEGATIVE_PROMPT = '低分辨率、模糊、畸变、肢体错误、多余手指、文字乱码或错字、水印、重复元素、低质量'

/** 追加到提示词末尾的质量要求（豆包默认偏浅色 PPT 风，必须显式压风格与细节）。 */
const QUALITY_SUFFIX = '\n画面要求：专业级商业设计，构图完整、光影自然、细节精致、色彩协调；风格与主色调以用户指定为准。'

/** 内联路由支持的扩展名 → 响应 Content-Type。 */
const INLINE_MIME = {
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
function buildPrompt(description, textLines) {
  const parts = [description]
  if (textLines !== undefined && textLines.length > 0) {
    const verbatim = textLines.map((line) => `「${line}」`).join('')
    parts.push(
      `图内需要出现的文字（必须逐字精确渲染，顺序、标点、换行一致，严禁增删改字或用同义替换）：${verbatim}`,
    )
  }
  return parts.join('\n') + QUALITY_SUFFIX
}

/**
 * 读一个「可能是 volatile 引用」的配置字段。
 *
 * 为什么需要它：带 `Config` 导出的插件，apply 入参的 volatile 字段在部分组合形态下
 * 是 boxed ref（`{ get() }` 容器）而非裸值。两种形态都解。
 * @param {unknown} field - 配置字段（裸值或 ref）。
 * @param {unknown} fallback - 两者都取不到时的兜底。
 * @returns {unknown} 解箱后的值。
 */
function unbox(field, fallback) {
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
function modelSpec(value) {
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
function modelEntries(models) {
  const table = new Map()
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return table
  for (const [key, value] of Object.entries(models)) {
    const spec = modelSpec(value)
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
function defaultModelFor(name, table) {
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
function modelOptionsFor(name, table) {
  const key = name.toLowerCase()
  const reservedAliases = BUILTIN_PROVIDERS.includes(key) ? LEGACY_MODEL_SUFFIXES : []
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
function resolveRequestedModel(requested, channel, fallbackId, table) {
  const candidate = requested.trim()
  if (candidate === '') return fallbackId ?? candidate
  const options = modelOptionsFor(channel, table)
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
function validateRequest(args, outDir) {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (prompt.length === 0) throw new Error('generate_image: prompt 不能为空')
  if (prompt.length > LIMITS.prompt) throw new Error(`generate_image: prompt 过长（上限 ${LIMITS.prompt} 字符）`)

  if (args.text_lines !== undefined) {
    if (!Array.isArray(args.text_lines) || args.text_lines.some((line) => typeof line !== 'string')) {
      throw new Error('generate_image: text_lines 必须是字符串数组')
    }
    if (args.text_lines.length > LIMITS.textLines) {
      throw new Error(`generate_image: text_lines 最多 ${LIMITS.textLines} 行`)
    }
    for (const line of args.text_lines) {
      if (line.length > LIMITS.textLineLen) {
        throw new Error(`generate_image: 单行文字超过 ${LIMITS.textLineLen} 字符（逐字渲染成功率下降，请精简）`)
      }
    }
  }

  const count = args.count
  if (count !== undefined && (!Number.isInteger(count) || count < LIMITS.minCount || count > LIMITS.maxCount)) {
    throw new Error(`generate_image: count 必须是 ${LIMITS.minCount}–${LIMITS.maxCount} 的整数`)
  }

  if (args.seed !== undefined
    && (!Number.isInteger(args.seed) || args.seed < LIMITS.seedMin || args.seed > LIMITS.seedMax)) {
    throw new Error(`generate_image: seed 必须在 ${LIMITS.seedMin}–${LIMITS.seedMax} 之间`)
  }

  let model
  if (args.model !== undefined) {
    if (typeof args.model !== 'string' || args.model.trim() === '') {
      throw new Error('generate_image: model 必须是非空字符串（模型 id 或 models 配置里的别名）')
    }
    if (args.model.trim().length > LIMITS.model) {
      throw new Error(`generate_image: model 过长（上限 ${LIMITS.model} 字符）`)
    }
    model = args.model.trim()
  }

  if (outDir.length === 0) throw new Error('generate_image: 未配置落盘目录（config.outDir）')
  if (!isAbsolute(outDir)) throw new Error(`generate_image: outDir 必须是绝对路径，当前为 ${outDir}`)
  return { count, seed: args.seed, model }
}

/**
 * 解析参考图入参：URL 原样透传；data URI 校验后透传；本地绝对路径读成 base64。
 * @param {unknown} raw - image 入参。
 * @returns {Promise<string | undefined>} 可直接发给通道的参考图。
 */
async function resolveImageInput(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new Error('generate_image: image 必须是字符串（URL / 本地绝对路径 / data URI）')
  const value = raw.trim()
  if (value === '') return undefined
  if (/^https?:\/\//iu.test(value)) return value
  if (/^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)) {
    if (value.length > LIMITS.imageDataUri) {
      throw new Error(`generate_image: 参考图 data URI 超过 ${Math.round(LIMITS.imageDataUri / 1024 / 1024)}MB`)
    }
    return value
  }
  if (!isAbsolute(value)) throw new Error(`generate_image: image 本地路径必须是绝对路径，当前为 ${value}`)
  let data
  try {
    data = await readFile(value)
  } catch {
    throw new Error(`generate_image: 读取参考图失败（文件不存在或不可读）：${value}`)
  }
  if (data.byteLength === 0) throw new Error(`generate_image: 参考图是空文件：${value}`)
  if (data.byteLength > LIMITS.imageFileBytes) {
    throw new Error(`generate_image: 参考图超过 ${Math.round(LIMITS.imageFileBytes / 1024 / 1024)}MB`)
  }
  const ext = extname(value).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${data.toString('base64')}`
}

/** 单张图片生成结果（落盘 + 可选附件）的规范值。 */
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
}

/** generate_image 的规范输出（模型看到的内容由 render 投影）。 */
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
export function apply(ctx, config) {
  /** 现读配置：经 apply 入参的 volatile 引用，GUI 保存后无需重启即时生效。 */
  const imagegenConfig = () => ({
    defaultProvider: unbox(config?.defaultProvider, 'doubao'),
    apiKeys: unbox(config?.apiKeys, {}),
    baseUrls: unbox(config?.baseUrls, {}),
    models: unbox(config?.models, {}),
    customProviders: unbox(config?.customProviders, {}),
    outDir: unbox(config?.outDir, ''),
    attachToConversation: unbox(config?.attachToConversation, true),
    count: unbox(config?.count, LIMITS.minCount),
    aspect: unbox(config?.aspect, '2:3'),
    requestTimeoutMs: unbox(config?.requestTimeoutMs, 300_000),
  })

  /** 当前全部通道（内置两家 + 自定义，含 models 配置的模型覆盖）。 */
  const providerTable = () => {
    const cfg = imagegenConfig()
    const models = modelEntries(cfg.models)
    const rows = new Map()
    for (const builtin of BUILTIN_PROVIDERS) {
      const configured = defaultModelFor(builtin, models)
      rows.set(builtin, builtinRow(builtin, {
        endpoint: cfg.baseUrls?.[builtin],
        // 规范键 `models.<通道>` 也覆盖字符串写法（modelSpec 已归一化），
        // 这里不再重复读 cfg.models[builtin]，避免出现第二条读法不一致的路径。
        model: configured,
        apiKey: cfg.apiKeys?.[builtin],
      }))
    }
    for (const [key, row] of normalizeCustomProviders(cfg.customProviders)) {
      const fromSettings = cfg.apiKeys?.[key]
      const configured = defaultModelFor(key, models)
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
    if (row === undefined) throw unknownProviderError(providerName, table.names)
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
            const outDir = cfg.outDir === '' ? join(process.cwd(), 'generated-images') : cfg.outDir
            const file = join(outDir, fileName)
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

  // —— 工具注册。与 read_image 同一刀法：在 attachments 服务的作用域里注册，
  // execute 才能看见附件 store、把图片作为会话附件交给前端内嵌显示。
  ctx.inject(['attachments'], (imageCtx) => {
    imageCtx.tools.register(defineTool({
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
        schema: OUTPUT_SCHEMA,
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
            const links = items.map((item) => `![${basename(item.path)}](${inlineBaseUrl}/imagegen/${encodeURIComponent(basename(item.path))})`)
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
        const outDir = cfg.outDir === '' ? join(process.cwd(), 'generated-images') : cfg.outDir
        const validated = validateRequest(args, outDir)
        const providerName = typeof args.provider === 'string' && args.provider.trim() !== ''
          ? args.provider.trim()
          : cfg.defaultProvider
        const aspect = typeof args.aspect === 'string' && args.aspect.trim() !== '' ? args.aspect.trim() : cfg.aspect
        // 张数：入参优先，缺省用配置默认值，并统一夹到 1–4。
        // 夹取而非抛错：旧会话回放可能带越界入参，配置也可能被手改成越界值。
        const preferred = validated.count ?? cfg.count
        const requestedCount = Math.min(Math.max(preferred, LIMITS.minCount), LIMITS.maxCount)

        const { row, models } = resolveProvider(providerName)
        const apiKey = resolveApiKey(row)
        const model = validated.model === undefined
          ? row.model
          : resolveRequestedModel(validated.model, row.name, row.model, models)
        const size = row.sizeFor(aspect)
        const prompt = buildPrompt(args.prompt.trim(), args.text_lines)
        // 参考图一次解析、全量复用（读文件/校验都发生在任何 API 请求之前）。
        const imageInput = await resolveImageInput(args.image)
        // 超时与调用方取消合并：任意一方触发即让所有等待结束。
        const signal = AbortSignal.any([
          exec.signal ?? new AbortController().signal,
          AbortSignal.timeout(cfg.requestTimeoutMs),
        ])

        await mkdir(outDir, { recursive: true })

        /**
         * 落盘 + 可选附件，返回一条规范值。
         * @param {object} image - 通道返回的图片字节。
         * @param {number} index - 本批次内的序号（用于文件名与失败定位）。
         * @returns {Promise<object>} 规范图片项。
         */
        const commitImage = async (image, index) => {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const suffix = `${stamp}-${index + 1}-${randomUUID().slice(0, 4)}`
          const name = `${suffix}${image.mediaType === 'image/jpeg' ? '.jpg' : '.png'}`
          const path = join(outDir, name)
          await writeFile(path, image.data)

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
          const generated = await generateImages({
            provider: { ...row, apiKey, model },
            prompt,
            aspect,
            n,
            ...(imageInput === undefined ? {} : { image: imageInput }),
            ...(validated.seed === undefined ? {} : { seed: validated.seed + offset }),
            negativePrompt: NEGATIVE_PROMPT,
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
export function describeProviders(config) {
  const models = modelEntries(unbox(config?.models, {}))
  const rows = []
  for (const builtin of BUILTIN_PROVIDERS) {
    rows.push(builtinRow(builtin, {
      endpoint: unbox(config?.baseUrls, {})?.[builtin],
      model: defaultModelFor(builtin, models),
      apiKey: unbox(config?.apiKeys, {})?.[builtin],
    }))
  }
  for (const [, row] of normalizeCustomProviders(unbox(config?.customProviders, {}))) rows.push(row)
  return rows.map((row) => describeRow(row))
}
