// scripts/verify-install.mjs —— 在 profile 目录里用真实依赖验证安装结果：
// 加载 lib/index.js（真实 schemastery + dsh-tools）、检查工具注册与 schema 兼容性。
// 用法：node scripts/verify-install.mjs（需在 profile 的 node_modules 解析域内运行）。

const host = await import('@little-traincar/dsh-imagegen')
console.log('✓ 包可加载')
console.log('  name =', host.name)
console.log('  inject =', JSON.stringify(host.inject))
console.log('  导出:', Object.keys(host).join(', '))

// 真实 schemastery：Config 必须能 toJSON（设置页 schema 由它生成）。
const schema = host.Config.toJSON()
console.log('✓ Config.toJSON() 正常，顶层属性:', Object.keys(schema.dict ?? {}).join(', '))
const custom = schema.dict?.customProviders
console.log('  customProviders schema type =', custom?.type, '| default =', JSON.stringify(custom?.meta?.default))

// 真实 dsh-tools：用假 ctx 注册一次，确认 defineTool 接受本工具的参数/输出 schema。
let registered
const ctx = {
  inject(names, callback) {
    if (names.includes('attachments')) {
      callback({ tools: { register: (definition) => { registered = definition } }, get: () => undefined })
    }
  },
  effect: () => () => {},
}
host.apply(ctx, {
  defaultProvider: 'local',
  apiKeys: {},
  baseUrls: {},
  models: {},
  customProviders: { local: { baseUrl: 'http://127.0.0.1:11434', model: 'flux', apiKeyOptional: true, size: '1024x1024' } },
  outDir: process.cwd(),
  attachToConversation: false,
  count: 1,
  aspect: '2:3',
  requestTimeoutMs: 5000,
})
console.log('✓ 工具已注册:', registered?.name)
console.log('  描述前缀:', String(registered?.description).slice(0, 90))
console.log('  参数键:', Object.keys(registered?.parameters?.properties ?? {}).join(', '))
console.log('  参数校验可用:', Array.isArray(registered?.validate?.({ prompt: 'x' })) || typeof registered?.output?.schema === 'object')
