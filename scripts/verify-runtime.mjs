// scripts/verify-runtime.mjs —— 用**真实** DSH 运行时包校验产物（不需要启动 dsh）。
//
// 为什么需要它：smoke.mjs 用替身跑，能验证逻辑，但验证不了「宿主 API 是否真的存在」
// —— 正是 0.1.x → 0.2.x 那次迁移翻车的地方（installSection 被删、settingsScope 消失）。
// 本脚本用真实包做四件事：
//   1) 打印运行时版本，并检查关键 API 的真实存在性；
//   2) 用真实 schemastery 检查 Config 的字段、volatile 标记与可序列化性；
//   3) 用假 ctx + 真 defineTool 走一遍 apply，确认工具注册、设置面关闭、内联路由注册；
//   4) 确认产物里不再出现已删除的旧 API（installSection / settingsNamespace / settingsScope）。
//
// 用法（推荐把脚本复制到 profile 目录里运行，这样 Node 用原生解析找到真实包）：
//   node verify-runtime.mjs --plugin <插件目录>
//   node verify-runtime.mjs --plugin <插件目录> --require-volatile   # 目标宿主必须支持热更配置
// 可用 --runtime <目录> 指定运行时包所在的 @deepseek-ai 目录。

import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginIndex = process.argv.indexOf('--plugin')
const pluginRoot = pluginIndex === -1 ? root : resolve(process.argv[pluginIndex + 1])
const runtimeIndex = process.argv.indexOf('--runtime')
const runtimeDir = runtimeIndex === -1
  ? join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai')
  : resolve(process.argv[runtimeIndex + 1])
const requireVolatile = process.argv.includes('--require-volatile')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}
const skip = (label, detail) => { console.log(`SKIP  ${label}${detail === '' ? '' : ` — ${detail}`}`) }

const runtimeVersion = async (name) => {
  try {
    return JSON.parse(await readFile(join(runtimeDir, name, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

// 解析钩子：先让 Node 原生解析；解析不到再把 @deepseek-ai/<pkg> 指到运行时目录下该包
// 的真实入口。入口表只列 exports map 与默认不同的包（schemastery 是 lib/index.mjs）。
const runtimeBase = pathToFileURL(join(runtimeDir, 'x')).href.slice(0, -1)
const entryPoints = { schemastery: 'lib/index.mjs' }
register('data:text/javascript,' + encodeURIComponent([
  'const base = ' + JSON.stringify(runtimeBase),
  'const entries = ' + JSON.stringify(entryPoints),
  'export async function resolve(specifier, context, next) {',
  '  try { return await next(specifier, context) } catch (error) {',
  '    if (!specifier.startsWith("@deepseek-ai/")) throw error',
  '    const name = specifier.slice("@deepseek-ai/".length).split("/")[0]',
  '    return next(base + name + "/" + (entries[name] ?? "lib/index.js"), context)',
  '  }',
  '}',
].join('\n')))

console.log('plugin dir:', pluginRoot)
console.log('runtime dir:', runtimeDir)
const versions = {}
for (const name of ['dsh-app-boot', 'dsh-tools', 'dsh-settings', 'dsh-attachment', 'schemastery', 'cordis']) {
  versions[name] = await runtimeVersion(name)
  console.log(`  ${name}: ${versions[name] ?? 'MISSING'}`)
}
check('运行时目录存在真实包', versions['dsh-app-boot'] !== undefined)

// —— 1) 真实 schemastery 校验 Config ——
const hostModule = await import(pathToFileURL(resolve(pluginRoot, 'lib/index.js')).href)
check('宿主产物可在真实运行时下加载', typeof hostModule.apply === 'function')
const schema = hostModule.Config
check('Config 是真实的 schemastery 节点', schema !== undefined && typeof schema.toJSON === 'function')

const expectedFields = [
  'defaultProvider', 'apiKeys', 'baseUrls', 'models', 'customProviders',
  'outDir', 'attachToConversation', 'count', 'aspect', 'requestTimeoutMs',
]
const fieldNames = Object.keys(schema.dict ?? {})
check('Config 字段齐全', expectedFields.every((field) => fieldNames.includes(field)), fieldNames.join(','))
check('models 是 dict（可承载 { id, label } 与别名键）', schema.dict.models?.type === 'dict', String(schema.dict.models?.type))
check('apiKeys 是 secret 字典',
  schema.dict.apiKeys?.type === 'dict' && schema.dict.apiKeys?.inner?.meta?.role === 'secret',
  JSON.stringify(schema.dict.apiKeys?.inner?.meta ?? {}))

// volatile 标记：0.2.x 的 schemastery（~3.18.4）才有；老宿主缺这个能力时如实跳过。
const supportsVolatile = typeof schema.volatile === 'function'
if (!supportsVolatile) {
  if (requireVolatile) check('宿主 schemastery 支持 .volatile()（0.2.x 目标）', false, `schemastery ${versions.schemastery}`)
  else skip('volatile 热更标记', `宿主 schemastery ${versions.schemastery} 无 .volatile()，设置页不可用（工具仍可用）`)
} else {
  const volatileFields = expectedFields.filter((field) => schema.dict[field]?.meta?.volatile === true)
  check('配置字段带 volatile 标记（GUI 保存可热更）',
    volatileFields.length === expectedFields.length,
    `${volatileFields.length}/${expectedFields.length}`)
}
const serialized = schema.toJSON()
const refs = serialized.refs ?? {}
const deref = (node) => (typeof node === 'number' ? refs[String(node)] : node)
const rootNode = deref(serialized.uid) ?? serialized
check('Config 可序列化（设置面拿得到 schema）',
  rootNode?.type === 'object' && Object.keys(rootNode.dict ?? {}).length >= expectedFields.length,
  `type=${rootNode?.type} keys=${Object.keys(rootNode.dict ?? {}).length}`)

const schemastery = await import('@deepseek-ai/schemastery')
const parse = new schemastery.default(serialized)
/**
 * 解箱：带 `.volatile()` 的字段解析后是 boxed ref（`{ get() }` 容器），不是裸值。
 * 这正是插件 apply 里 `unbox()` 要处理的东西 —— 校验脚本也必须先解箱再断言，
 * 否则会把「解箱前」的引用当成值来比，误报失败。
 */
const unboxValue = (value) => {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return unboxValue(value.get())
  return value
}
const parsed = parse({})
const defaults = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, unboxValue(value)]))
check('Config 能以默认值解析',
  defaults.defaultProvider === 'doubao' && defaults.attachToConversation === true && defaults.aspect === '2:3' && defaults.count === 1,
  JSON.stringify(defaults).slice(0, 160))
check('volatile 字段确实被装箱成 ref（宿主行为）',
  supportsVolatile ? Object.values(parsed).some((value) => value !== null && typeof value === 'object' && typeof value.get === 'function') : true,
  supportsVolatile ? 'boxed' : 'skipped: no volatile support')
const parsedWithModels = parse({ models: { doubao: 'x-1', 'relay/gpt-image': { id: 'gpt-image-1', label: 'alias' } } })
const modelsValue = unboxValue(parsedWithModels.models)
check('Config 接受 models 覆盖（含别名键）',
  modelsValue.doubao === 'x-1' && modelsValue['relay/gpt-image']?.id === 'gpt-image-1',
  JSON.stringify(modelsValue))

// —— 2) 真实 defineTool 走一遍 apply ——
const toolsModule = await import('@deepseek-ai/dsh-tools')
check('真实运行时导出 defineTool', typeof toolsModule.defineTool === 'function')

const registrations = []
const injected = []
const registeredRoutes = []
let settingsAuto = null
const fakeCtx = {
  fiber: { entry: { id: 'imagegen' } },
  inject(names, callback) {
    injected.push(names.join('+'))
    if (names.includes('attachments')) {
      callback({ tools: { register: (definition) => registrations.push(definition) }, get: () => undefined })
    } else if (names.includes('webServer')) {
      callback({
        get: () => ({ port: 12345, register: (route) => { registeredRoutes.push(route); return () => {} } }),
        effect: (callback) => callback(),
      })
    } else if (names.includes('settings')) {
      callback({
        settings: { configure: (presentation) => { settingsAuto = presentation.auto } },
        effect: (callback) => callback(),
      })
    }
  },
  effect: () => () => {},
}
hostModule.apply(fakeCtx, {
  defaultProvider: 'doubao',
  apiKeys: {},
  baseUrls: {},
  models: {},
  customProviders: {},
  outDir: resolve(pluginRoot, 'tmp-verify'),
  attachToConversation: false,
  count: 1,
  aspect: '2:3',
  requestTimeoutMs: 1000,
})

check('探测了 webServer/attachments/settings',
  ['webServer', 'attachments', 'settings'].every((name) => injected.includes(name)), injected.join(' | '))
check('真实 defineTool 接受了工具定义（含 output.render）',
  registrations.length === 1 && registrations[0].name === 'generate_image' && typeof registrations[0].output?.render === 'function',
  `count=${registrations.length}`)
check('工具输出 schema 是合法 JSON Schema 对象',
  typeof registrations[0]?.output?.schema === 'object' && registrations[0].output.schema.type === 'object')
const rendered = registrations[0].output.render({}, {
  provider: 'doubao',
  model: 'doubao-seedream-5-0-pro-260628',
  aspect: '2:3',
  size: '1152x2048',
  prompt: 'p',
  images: [{ path: 'C:/x/a.png', attached: true, image: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 8, height: 8, name: 'a.png' } }],
  failures: [{ index: 2, message: 'boom' }],
})
check('render 产出 text + image 内容块',
  rendered.some((block) => block.type === 'text') && rendered.some((block) => block.type === 'image' && block.attachment?.attachmentId === 'att-1'),
  JSON.stringify(rendered.map((block) => block.type)))
check('内联路由已注册到 webServer',
  registeredRoutes.length === 1 && registeredRoutes[0].path === '/imagegen',
  JSON.stringify(registeredRoutes.map((route) => route.path)))
check('设置页自动生成已关闭（交给自带卡片）', settingsAuto === false, String(settingsAuto))

// —— 3) 产物里不得残留已删除的旧 API ——
// 先剥掉注释再查，否则「说明本次迁移」的注释会被误判成残留调用。
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
const hostSource = await readFile(resolve(pluginRoot, 'lib/index.js'), 'utf8')
const clientSource = await readFile(resolve(pluginRoot, 'lib/client.js'), 'utf8')
const hostCode = stripComments(hostSource)
const clientCode = stripComments(clientSource)
for (const banned of ['settingsNamespace', 'installSettingsSection']) {
  check(`宿主产物不含已删除的 ${banned}`, !hostCode.includes(banned))
}
check('宿主产物不调用已删除的 settings.installSection', !hostCode.includes('.installSection('))
check('客户端产物不含已删除的 settingsScope', !clientCode.includes('settingsScope'))
check('客户端产物走 configForms', clientCode.includes('configForms'))
check('客户端产物向 __ModuleLoader__ 注册', clientCode.includes('window.__ModuleLoader__.load({'))

// —— 4) 运行时里这些 API 的真实存在性（防止再押错） ——
const settingsPackage = await import('@deepseek-ai/dsh-settings')
const settingsPrototype = settingsPackage.SettingsForms?.prototype
if (typeof settingsPrototype?.configure === 'function') {
  check('运行时 settings 服务有 configure（0.2.x 形态）', true)
} else if (requireVolatile) {
  check('运行时 settings 服务有 configure（0.2.x 形态）', false, `dsh-settings ${versions['dsh-settings']}`)
} else {
  skip('运行时 settings.configure', `本机 dsh-settings ${versions['dsh-settings']} 是 0.1.x 形态`)
}
check('运行时 settings 服务没有已删除的 installSection', settingsPrototype?.installSection === undefined)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
