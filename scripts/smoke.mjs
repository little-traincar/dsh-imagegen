// scripts/smoke.mjs —— 零依赖自检：不需要 DSH 运行时，验证两个产物能被加载、
// provider 表能解析自定义通道、请求体与响应解码都符合预期、模型可自由配置，
// 且客户端能在假 __ModuleLoader__ 里注册并渲染设置卡片。
//
// 用法：node scripts/smoke.mjs
//
// 说明：Host 产物里的 @deepseek-ai/* 在本地没有 node_modules，因此这里用
// module.register 的自定义解析钩子把它们指向内置替身（profile 里跑的是真包）。

import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// —— 极简 schemastery / dsh-tools 替身：任何链式调用都返回可继续链式的节点 ——
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
const schemasteryUrl = 'data:text/javascript,' + encodeURIComponent(stubs)
const toolsUrl = 'data:text/javascript,' + encodeURIComponent(toolsStub)
// 注册解析钩子：@deepseek-ai/* 在本地没有 node_modules，指向内置替身。
const hook = [
  'const schemastery = ' + JSON.stringify(schemasteryUrl),
  'const tools = ' + JSON.stringify(toolsUrl),
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

// —— 1) Host 产物加载与导出面 ——
const host = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)
check('host 产物可加载', true)
check('导出 apply/inject/name/Config',
  typeof host.apply === 'function' && Array.isArray(host.inject) && host.name === 'imagegen' && host.Config !== undefined)
check('inject 只声明 tools（其余靠 ctx.inject 探测）',
  JSON.stringify(host.inject) === '["tools"]', JSON.stringify(host.inject))

// —— 2) provider 归一化 ——
const table = host.normalizeCustomProviders({
  relay: { baseUrl: 'https://gw.example.com/v1', model: 'gpt-image-1', apiKey: 'sk-test' },
  local: { baseUrl: 'http://127.0.0.1:11434', model: 'flux', apiKeyOptional: true, size: '1024x1024' },
})
check('自定义通道数量', table.size === 2, `size=${table.size}`)
const relay = table.get('relay')
check('relay endpoint 补全 /images/generations', relay.endpoint === 'https://gw.example.com/v1/images/generations', relay.endpoint)
check('relay 带 key', relay.apiKey === 'sk-test')
check('relay 默认尺寸 2:3', relay.sizeFor('2:3') === '832x1216', relay.sizeFor('2:3'))
const local = table.get('local')
check('local 裸主机补 /v1/images/generations', local.endpoint === 'http://127.0.0.1:11434/v1/images/generations', local.endpoint)
check('local 固定尺寸生效', local.sizeFor('16:9') === '1024x1024', `${local.sizeFor('16:9')}`)
check('local 尺寸表可覆盖单档', table.get('relay').sizeFor('1:1') === '1024x1024', table.get('relay').sizeFor('1:1'))
check('local 免鉴权', local.apiKeyOptional === true)

let bad = ''
try {
  host.normalizeCustomProviders({ broken: { model: 'x' } })
} catch (error) {
  bad = error.message
}
check('缺 baseUrl 报可读错误', bad.includes('缺少 baseUrl'), bad)

let badBuiltin = ''
try {
  host.normalizeCustomProviders({ doubao: { baseUrl: 'https://x.example.com', model: 'y' } })
} catch (error) {
  badBuiltin = error.message
}
check('禁止覆盖内置通道', badBuiltin.includes('不能覆盖内置通道'), badBuiltin)

// —— 3) describeProviders（诊断入口）——
const described = host.describeProviders({
  defaultProvider: 'doubao',
  apiKeys: {},
  baseUrls: {},
  models: { qwen: 'my-qwen-model' },
  customProviders: { relay: { baseUrl: 'https://gw.example.com/v1', model: 'gpt-image-1' } },
  outDir: process.cwd(),
  count: 1,
  aspect: '2:3',
  requestTimeoutMs: 1000,
  attachToConversation: false,
})
check('describeProviders 三行', described.length === 3, described.join(' | '))
check('describeProviders 反映 models 覆盖', described.some((line) => line.includes('my-qwen-model')), described.join(' | '))

// —— 4) 工具注册 + 中转站请求体 ——
const registrations = []
const fakeCtx = {
  inject(names, callback) {
    if (names.includes('attachments')) {
      callback({
        tools: { register: (definition) => registrations.push(definition) },
        get: () => undefined,
      })
    }
  },
  effect: () => () => {},
}
const baseConfig = {
  defaultProvider: 'relay',
  apiKeys: {},
  baseUrls: {},
  models: {},
  customProviders: { relay: { baseUrl: 'https://gw.example.com/v1', model: 'gpt-image-1', apiKey: 'sk-test' } },
  outDir: resolve(root, 'tmp-smoke'),
  attachToConversation: false,
  count: 1,
  aspect: '1:1',
  requestTimeoutMs: 5000,
}
host.apply(fakeCtx, baseConfig)
check('generate_image 已注册',
  registrations.length === 1 && registrations[0].name === 'generate_image',
  `count=${registrations.length} names=${registrations.map((item) => item?.name).join('|')}`)
const tool = registrations[0]
check('工具描述含自定义通道', String(tool.description).includes('relay'), String(tool.description).slice(0, 140))
check('入参含 model 覆盖位', tool.parameters?.model !== undefined, JSON.stringify(Object.keys(tool.parameters ?? {})))

const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0zaAAAAAElFTkSuQmCC'
let seenRequest
globalThis.fetch = async (url, init) => {
  seenRequest = { url, init }
  return new Response(JSON.stringify({ data: [{ b64_json: pngB64 }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
const result = await tool.execute({ prompt: '一张测试海报' }, { signal: undefined })
check('生成结果落盘 1 张', result.images.length === 1, JSON.stringify(result).slice(0, 200))
check('结果 provider/model 正确', result.provider === 'relay' && result.model === 'gpt-image-1')
check('落盘文件真实存在', await readFile(result.images[0].path).then(() => true, () => false))
const sent = JSON.parse(seenRequest.init.body)
check('请求体 model/prompt/size', sent.model === 'gpt-image-1' && typeof sent.prompt === 'string' && sent.size === '1024x1024', JSON.stringify(sent).slice(0, 200))
check('请求体 n=1', sent.n === 1)
check('请求体 watermark=false', sent.watermark === false)
check('请求体 response_format=b64_json', sent.response_format === 'b64_json')
check('Authorization 头', seenRequest.init.headers.authorization === 'Bearer sk-test')
check('POST 到归一化 endpoint', seenRequest.url === 'https://gw.example.com/v1/images/generations', seenRequest.url)

// —— 4b) 模型可自由配置：models 覆盖 + 单次调用 model 覆盖 ——
registrations.length = 0
host.apply(fakeCtx, {
  ...baseConfig,
  apiKeys: { qwen: 'sk-qwen' },
  models: { relay: 'my-gateway-model', 'relay/gpt-image': { id: 'gpt-image-1', label: '别名' } },
})
const modelTool = registrations[0]
const overrideResult = await modelTool.execute({ prompt: '模型覆盖测试' }, { signal: undefined })
check('models[通道] 改变默认模型', overrideResult.model === 'my-gateway-model', overrideResult.model)
check('请求体用配置的模型', JSON.parse(seenRequest.init.body).model === 'my-gateway-model', JSON.parse(seenRequest.init.body).model)
const aliasResult = await modelTool.execute({ prompt: '别名测试', model: 'gpt-image' }, { signal: undefined })
check('别名解析到 model id', aliasResult.model === 'gpt-image-1', aliasResult.model)
const literalResult = await modelTool.execute({ prompt: '字面 id 测试', model: '任意未声明的模型' }, { signal: undefined })
check('未声明的模型名按字面透传', literalResult.model === '任意未声明的模型', literalResult.model)
const providerOverride = await modelTool.execute({ prompt: '内置通道覆盖', provider: 'qwen', model: 'qwen-max-lite' }, { signal: undefined })
check('内置通道也能被 model 覆盖',
  providerOverride.provider === 'qwen' && providerOverride.model === 'qwen-max-lite',
  `${providerOverride.provider}/${providerOverride.model}`)

// —— 4c) 回归：0.3.1 的遗留键 `<通道>/model` ——
// 缺陷背景：旧卡片把「模型」输入框的值写到 models['<通道>/model']，而 Host 与卡片
// 自己都只读 models['<通道>']，导致设置页填的模型永远不生效。修复后：读取期仍兼容
// 遗留键（老配置不会突然掉回内置默认），但不再把它当别名暴露给工具入参。
registrations.length = 0
host.apply(fakeCtx, {
  ...baseConfig,
  apiKeys: { qwen: 'sk-qwen' },
  models: { 'qwen/model': 'qwen-legacy-lite', 'qwen/flash': 'qwen-flash' },
})
const legacyTool = registrations[0]
const legacyResult = await legacyTool.execute({ prompt: '遗留键兼容测试', provider: 'qwen' }, { signal: undefined })
check('遗留键 models[qwen/model] 仍被读作默认模型',
  legacyResult.model === 'qwen-legacy-lite', legacyResult.model)
const legacyAlias = await legacyTool.execute({ prompt: '遗留键不当别名', provider: 'qwen', model: 'model' }, { signal: undefined })
check('保留后缀 model 不再作为别名解析',
  legacyAlias.model === 'model', legacyAlias.model)
const realAlias = await legacyTool.execute({ prompt: '真别名仍可用', provider: 'qwen', model: 'flash' }, { signal: undefined })
check('普通别名仍然可用', realAlias.model === 'qwen-flash', realAlias.model)

// —— 4d) 回归：规范键与别名行并存 ——
registrations.length = 0
host.apply(fakeCtx, {
  ...baseConfig,
  apiKeys: { qwen: 'sk-qwen' },
  models: { qwen: 'qwen-lite', 'qwen/flash': 'qwen-flash' },
})
const cleanTool = registrations[0]
const cleanResult = await cleanTool.execute({ prompt: '规范键测试', provider: 'qwen' }, { signal: undefined })
check('规范键 models[qwen] 生效', cleanResult.model === 'qwen-lite', cleanResult.model)
const cleanAlias = await cleanTool.execute({ prompt: '规范键 + 别名', provider: 'qwen', model: 'flash' }, { signal: undefined })
check('规范键存在时别名仍解析', cleanAlias.model === 'qwen-flash', cleanAlias.model)

// —— 5) 本地通道：二进制直出 + 免鉴权 + 可关 watermark ——
registrations.length = 0
host.apply(fakeCtx, {
  ...baseConfig,
  defaultProvider: 'local',
  customProviders: { local: { baseUrl: 'http://127.0.0.1:11434', model: 'flux', apiKeyOptional: true, sendWatermark: false, size: '512x512' } },
})
const localTool = registrations[0]
globalThis.fetch = async (url, init) => {
  seenRequest = { url, init }
  return new Response(Buffer.from(pngB64, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } })
}
const localResult = await localTool.execute({ prompt: '本地模型测试' }, { signal: undefined })
check('本地二进制响应可用', localResult.images.length === 1 && localResult.images[0].path.endsWith('.png'))
check('本地通道不发 Authorization', seenRequest.init.headers.authorization === undefined, JSON.stringify(seenRequest.init.headers))
check('本地通道可关 watermark 字段', JSON.parse(seenRequest.init.body).watermark === undefined)

// —— 6) 未知 provider 报错列出可用通道 ——
let unknown = ''
try {
  await tool.execute({ prompt: 'x', provider: 'nope' }, { signal: undefined })
} catch (error) {
  unknown = error.message
}
check('未知 provider 报错含可用列表', unknown.includes('未知 provider') && unknown.includes('relay'), unknown)

// —— 7) 客户端产物加载 ——
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
check('客户端向 __ModuleLoader__ 注册',
  handoff?.id === '@little-traincar/dsh-imagegen' && typeof handoff.factory === 'function', String(handoff?.id))
const clientExports = handoff.factory((spec) => {
  if (spec === 'react') return reactStub
  throw new Error(`客户端产物请求了未知模块 ${spec}`)
})
check('客户端导出 apply/inject',
  typeof clientExports.apply === 'function' && Array.isArray(clientExports.inject), Object.keys(clientExports).join(','))
check('客户端 inject 已从 settingsScope 换成 configForms',
  clientExports.inject.includes('configForms') && !clientExports.inject.includes('settingsScope'),
  JSON.stringify(clientExports.inject))

// —— 8) 客户端 apply 挂载设置卡片与 toolview（现行 configForms 面） ——
const slotRegistrations = []
const mutations = []
const snapshot = {
  status: 'ready',
  value: { apiKeys: {}, baseUrls: {}, models: {}, customProviders: {} },
  user: {},
  writable: true,
  revision: 3,
}
const configForm = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  mutate: async (operations) => { mutations.push(operations); return true },
}
const fakeClientCtx = {
  configForms: { get: (entryId) => (entryId === 'imagegen' ? configForm : undefined) },
  locale: { bind: () => (key) => key, register: () => {} },
  slots: {
    inject: (name, callback) => callback(),
    register: (options, component) => {
      slotRegistrations.push({ name: options.name, id: options.id, key: options.key, component, face: options.inject })
      return () => {}
    },
  },
  effect: (callback) => { callback(); return () => {} },
}
clientExports.apply(fakeClientCtx)
check('注册 settings.section=imagegen', slotRegistrations.some((row) => row.name === 'settings.section' && row.id === 'imagegen'))
check('注册 tool.call.toolview=generate_image', slotRegistrations.some((row) => row.name === 'tool.call.toolview' && row.key === 'generate_image'))
const cardSlot = slotRegistrations.find((row) => row.name === 'settings.section')
const face = cardSlot.face()
check('注入面含 save/discard/hooks',
  typeof face.save === 'function' && typeof face.discard === 'function' && face.hooks.imagegenCard !== undefined)
const cardElement = cardSlot.component({
  t: (key) => key,
  useImagegenCard: (selector) => selector(snapshot),
  save: face.save,
  discard: face.discard,
})
check('卡片可渲染（返回元素树）', cardElement?.type === 'section', String(cardElement?.type))
const cardJson = JSON.stringify(cardElement)
check('卡片包含模型组', cardJson.includes('modelsTitle'), '')
check('卡片包含内置通道组', cardJson.includes('builtinTitle'), '')
check('卡片包含自定义通道组', cardJson.includes('customTitle'), '')
check('卡片渲染出模型输入行', cardJson.includes('imagegen-model-doubao'), '')

await face.save([
  { op: 'set', path: ['apiKeys', 'doubao'], value: 'ark-xxx' },
  { op: 'set', path: ['models', 'doubao'], value: 'doubao-x' },
  { op: 'set', path: ['customProviders'], value: { x: { baseUrl: 'http://127.0.0.1:1', model: 'm' } } },
])
const flat = mutations.flat()
check('保存写了 apiKeys.doubao 的嵌套路径',
  flat.some((op) => op.op === 'set' && op.path.join('.') === 'apiKeys.doubao' && op.value === 'ark-xxx'),
  JSON.stringify(flat))
check('保存写了 models.doubao',
  flat.some((op) => op.op === 'set' && op.path.join('.') === 'models.doubao' && op.value === 'doubao-x'),
  JSON.stringify(flat))
check('保存写了 customProviders 对象',
  flat.some((op) => op.op === 'set' && op.path.join('.') === 'customProviders' && typeof op.value === 'object'),
  JSON.stringify(flat))

// —— 9) 卡片纯逻辑（buildSaveOps）：set/unset 规则与 JSON 校验 ——
const { buildSaveOps } = clientExports
check('客户端导出 buildSaveOps 便于独立复算', typeof buildSaveOps === 'function')

const overridden = {
  ...snapshot,
  user: { apiKeys: { qwen: 'old' }, customProviders: { old: { baseUrl: 'http://x', model: 'm' } } },
}
const blankDrafts = {
  'apiKeys.doubao': '', 'apiKeys.qwen': '', 'baseUrls.doubao': '', 'baseUrls.qwen': '',
  'models.doubao': '', 'models.qwen': '', customProviders: '', models: '',
}
const opsBlank = buildSaveOps(overridden, blankDrafts).ops
check('空草稿 + 曾覆盖 → unset', opsBlank.some((op) => op.op === 'unset' && op.path.join('.') === 'apiKeys.qwen'), JSON.stringify(opsBlank))
check('空草稿 + 未覆盖 → 不写', !opsBlank.some((op) => op.path.join('.') === 'baseUrls.doubao'), JSON.stringify(opsBlank))
check('空草稿 + 曾覆盖的 customProviders → unset',
  opsBlank.some((op) => op.op === 'unset' && op.path.join('.') === 'customProviders'), JSON.stringify(opsBlank))

const opsSet = buildSaveOps(snapshot, {
  ...blankDrafts,
  'apiKeys.doubao': 'ark-1',
  'models.qwen': 'qwen-lite',
  customProviders: '{"local":{"baseUrl":"http://127.0.0.1:11434","model":"flux","apiKeyOptional":true}}',
}).ops
check('非空草稿 → set 嵌套路径',
  opsSet.some((op) => op.op === 'set' && op.path.join('.') === 'apiKeys.doubao' && op.value === 'ark-1'), JSON.stringify(opsSet))
check('模型行写到「models.<通道>」规范键',
  opsSet.some((op) => op.op === 'set' && op.path.join('.') === 'models.qwen' && op.value === 'qwen-lite'), JSON.stringify(opsSet))
check('customProviders 解析成对象',
  opsSet.some((op) => op.op === 'set' && op.path.join('.') === 'customProviders' && op.value.local?.model === 'flux'), JSON.stringify(opsSet))

const badOps = buildSaveOps(snapshot, { ...blankDrafts, customProviders: '{ 不是 JSON' })
check('非法 customProviders JSON 被拦下', badOps.error !== undefined && badOps.ops.length === 0, String(badOps.error))

// —— 10) 回归：模型键的旧写法兼容与迁移（0.3.1 写入 / 读取键不一致） ——
const legacySnapshot = {
  ...snapshot,
  user: { ...(snapshot.user ?? {}), models: { 'doubao/model': 'legacy-doubao-id', 'doubao/label': '旧展示名' } },
}
const legacyOps = buildSaveOps(legacySnapshot, { ...blankDrafts, 'models.doubao': 'doubao-new-id' }).ops
check('写规范键时顺手清掉遗留 <通道>/model',
  legacyOps.some((op) => op.op === 'unset' && op.path.join('.') === 'models.doubao/model'), JSON.stringify(legacyOps))
check('清遗留键时连带清掉 <通道>/label',
  legacyOps.some((op) => op.op === 'unset' && op.path.join('.') === 'models.doubao/label'), JSON.stringify(legacyOps))
check('规范键写入不被遗留清理破坏',
  legacyOps.some((op) => op.op === 'set' && op.path.join('.') === 'models.doubao' && op.value === 'doubao-new-id'),
  JSON.stringify(legacyOps))

const legacyBlankOps = buildSaveOps(legacySnapshot, { ...blankDrafts }).ops
check('留空 + 仅有遗留键 → 撤掉遗留覆盖',
  legacyBlankOps.some((op) => op.op === 'unset' && op.path.join('.') === 'models.doubao/model'),
  JSON.stringify(legacyBlankOps))

check('卡片行能读到遗留键的模型 id（老配置不回落到默认）',
  clientExports.modelOf({ 'doubao/model': 'legacy-doubao-id' }, 'doubao')?.id === 'legacy-doubao-id',
  JSON.stringify(clientExports.modelOf({ 'doubao/model': 'legacy-doubao-id' }, 'doubao')))
check('遗留键不再被当成别名行展示',
  clientExports.modelAliasRows({ 'doubao/model': 'legacy-doubao-id', 'relay/gpt-image': { id: 'gpt-image-1' } }).length === 1,
  JSON.stringify(clientExports.modelAliasRows({ 'doubao/model': 'x', 'relay/gpt-image': { id: 'gpt-image-1' } })))

const legacyPresent = { ...snapshot, user: { models: { 'qwen/model': 'old-qwen' } } }
check('modelOverridePresent 认遗留键',
  clientExports.modelOverridePresent(legacyPresent, 'qwen') === true,
  String(clientExports.modelOverridePresent(legacyPresent, 'qwen')))
check('modelOverridePresent 认规范键',
  clientExports.modelOverridePresent({ ...snapshot, user: { models: { qwen: 'new-qwen' } } }, 'qwen') === true,
  '')
check('未覆盖时 modelOverridePresent 为 false',
  clientExports.modelOverridePresent(snapshot, 'qwen') === false,
  '')

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
