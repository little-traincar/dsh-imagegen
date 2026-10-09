// scripts/regression-model-keys.mjs —— 模型键回归：Host 与客户端卡片必须对同一份
// `models` 配置给出**同一个**答案。
//
// 背景（0.3.1 的缺陷）：设置卡片的「模型」输入行把值写到 `models['<通道>/model']`，
// 而 Host 的 defaultModelFor 与卡片自己的 modelOf 都只读 `models['<通道>']`
// （或 `<通道>/default`）。结果是「在设置页填了模型」永远不生效，还静默回落到内置
// 默认模型。这个脚本把「两侧读法一致」固化成断言，避免以后再写成两套键。
//
// 用法：node scripts/regression-model-keys.mjs（需要先 npm run build）
//
// 说明：与 smoke.mjs 一样，用 module.register 的解析钩子把 @deepseek-ai/* 指向替身，
// 本地没有 node_modules 也能跑。

import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const stubs = `
const node = (type, extra = {}) => new Proxy({ type, ...extra }, {
  get(target, key) {
    if (key === 'toJSON') return () => ({ type: target.type })
    if (key === Symbol.toPrimitive || key === 'toString') return () => '[schema]'
    if (key in target) return target[key]
    return (...args) => node(target.type, { ...target, [key]: args })
  },
})
export default {
  object: (shape) => node('object', { shape }),
  dict: (inner) => node('dict', { inner }),
  array: (inner) => node('array', { inner }),
  union: (list) => node('union', { list }),
  string: () => node('string'),
  number: () => node('number'),
  boolean: () => node('boolean'),
  any: () => node('any'),
}
`
const toolsStub = 'export const defineTool = (options) => options\n'
const hook = [
  'const schemastery = ' + JSON.stringify('data:text/javascript,' + encodeURIComponent(stubs)),
  'const tools = ' + JSON.stringify('data:text/javascript,' + encodeURIComponent(toolsStub)),
  'export async function resolve(specifier, context, next) {',
  '  if (specifier === "@deepseek-ai/schemastery") return { url: schemastery, shortCircuit: true }',
  '  if (specifier === "@deepseek-ai/dsh-tools") return { url: tools, shortCircuit: true }',
  '  return next(specifier, context)',
  '}',
].join('\n')
register('data:text/javascript,' + encodeURIComponent(hook))

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// —— 1) Host 产物：捕获真实请求体里的 model ——
const host = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let seenBody = undefined
globalThis.fetch = async (_url, init) => {
  seenBody = JSON.parse(init.body)
  return new Response(Buffer.from(PNG_B64, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } })
}

/** 用给定的 models 配置 + 通道 model 兜底值跑一次工具，返回实际发出去的模型 id。 */
const hostModelId = async (models, channelModel, customProviders = {}, providerName = 'qwen') => {
  let tool
  const ctx = {
    inject(names, callback) {
      if (names.includes('attachments')) {
        callback({ tools: { register: (definition) => { tool = definition } }, get: () => undefined })
      }
    },
    effect: () => () => {},
  }
  host.apply(ctx, {
    defaultProvider: 'qwen',
    apiKeys: { qwen: 'sk-qwen' },
    baseUrls: {},
    models,
    customProviders,
    outDir: resolve(root, 'tmp-smoke'),
    attachToConversation: false,
    count: 1,
    aspect: '1:1',
    requestTimeoutMs: 10_000,
  })
  await tool.execute({ prompt: '模型键回归', provider: providerName }, { signal: undefined })
  return seenBody.model === channelModel ? `(兜底)${channelModel}` : seenBody.model
}

// —— 2) 客户端产物：加载卡片纯逻辑 ——
const clientSource = await readFile(resolve(root, 'lib/client.js'), 'utf8')
let handoff
globalThis.window = { __ModuleLoader__: { load: (registration) => { handoff = registration } } }
const reactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1] ?? {}, children: args.slice(2) }),
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}
// eslint-disable-next-line no-new-func
new Function('window', clientSource)(globalThis.window)
const client = handoff.factory((spec) => {
  if (spec === 'react') return reactStub
  throw new Error(`客户端产物请求了未知模块 ${spec}`)
})

const BUILTIN_QWEN = 'qwen-image-3.0-pro'

// —— 3) 两侧一致性表：同一份 models 配置，Host 实际用哪个 id、卡片显示哪个 id ——
const cases = [
  {
    name: '规范键 models.qwen（设置卡片现在写入的形态）',
    models: { qwen: 'qwen-lite' },
    host: 'qwen-lite',
    card: 'qwen-lite',
  },
  {
    name: '0.3.1 遗留键 models["qwen/model"]（老配置必须继续生效）',
    models: { 'qwen/model': 'qwen-legacy' },
    host: 'qwen-legacy',
    card: 'qwen-legacy',
  },
  {
    name: '规范键与遗留键并存（规范键优先）',
    models: { qwen: 'qwen-new', 'qwen/model': 'qwen-old' },
    host: 'qwen-new',
    card: 'qwen-new',
  },
  {
    name: '等价写法 models["qwen/default"]',
    models: { 'qwen/default': 'qwen-default-key' },
    host: 'qwen-default-key',
    card: 'qwen-default-key',
  },
  {
    name: '未配置任何键（回落内置默认）',
    models: {},
    host: `(兜底)${BUILTIN_QWEN}`,
    card: undefined,
  },
]

for (const item of cases) {
  const hostId = await hostModelId(item.models, BUILTIN_QWEN)
  const cardId = client.modelOf(item.models, 'qwen')?.id
  check(`Host 读到预期模型：${item.name}`, hostId === item.host, `host=${hostId}`)
  check(`卡片读到预期模型：${item.name}`,
    cardId === item.card, `card=${String(cardId)} expected=${String(item.card)}`)
  // 一致性本身才是回归点：两侧对同一份配置的任何分歧都是缺陷。
  check(`两侧一致：${item.name}`,
    (item.card === undefined ? `(兜底)${BUILTIN_QWEN}` : item.card) === hostId || cardId === hostId,
    `host=${hostId} card=${String(cardId)}`)
}

// —— 4) 别名行不应把保留后缀当别名 ——
const aliasRows = client.modelAliasRows({ 'qwen/model': 'qwen-legacy', 'qwen/label': '旧名', 'qwen/flash': 'qwen-flash' })
check('别名行跳过保留后缀 model / label',
  aliasRows.length === 1 && aliasRows[0].alias === 'flash', JSON.stringify(aliasRows))

// —— 5) 保存路径：写规范键 + 迁移遗留键 ——
const blankDrafts = {
  'apiKeys.doubao': '', 'apiKeys.qwen': '', 'baseUrls.doubao': '', 'baseUrls.qwen': '',
  'models.doubao': '', 'models.qwen': '', customProviders: '', models: '',
}
const legacySnapshot = { status: 'ready', value: {}, base: {}, user: { models: { 'qwen/model': 'qwen-old' } }, revision: 1, writable: true }
const ops = client.buildSaveOps(legacySnapshot, { ...blankDrafts, 'models.qwen': 'qwen-new' }).ops
check('保存写规范键 models.qwen',
  ops.some((op) => op.op === 'set' && op.path.join('.') === 'models.qwen' && op.value === 'qwen-new'), JSON.stringify(ops))
check('保存清掉遗留键 models["qwen/model"]',
  ops.some((op) => op.op === 'unset' && op.path.join('.') === 'models.qwen/model'), JSON.stringify(ops))
check('保存不再写任何 <通道>/model 键',
  !ops.some((op) => op.op === 'set' && op.path.join('.').endsWith('/model')), JSON.stringify(ops))

// —— 6) 自定义通道的模型行 ——
// 卡片给已声明的自定义通道也画一行模型输入框，这一行同样必须落在规范键
// `models.<通道>` 上：Host 恰好也认 `<通道>/model` 这个键，读法对齐后不会错，
// 但把它当别名暴露给工具入参就是错的。
const customOps = client.buildSaveOps(legacySnapshot, {
  ...blankDrafts,
  'models.local': 'flux-row',
  customProviders: '{"local":{"baseUrl":"http://127.0.0.1:11434/v1","model":"flux"}}',
}).ops
check('自定义通道模型行写规范键 models.local',
  customOps.some((op) => op.op === 'set' && op.path.join('.') === 'models.local' && op.value === 'flux-row'),
  JSON.stringify(customOps))
check('自定义通道模型行不留 <通道>/model 写入',
  !customOps.some((op) => op.op === 'set' && op.path.join('.') === 'models.local/model'), JSON.stringify(customOps))

const hostCustom = await hostModelId(
  { local: 'flux-row' },
  '(兜底)flux',
  { local: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'flux', apiKeyOptional: true } },
  'local',
)
check('Host 端自定义通道也用规范键覆盖 model', hostCustom === 'flux-row', hostCustom)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
