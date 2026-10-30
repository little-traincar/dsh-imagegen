// scripts/regression-security.mjs —— 安全回归：两条「静默越权」缺陷的固定断言。
//
// 背景：
//   1) resolveApiKey 曾先查全局环境变量（IMAGE_API_KEY / OPENAI_API_KEY），再判断
//      apiKeyOptional。于是声明为免鉴权的本地/第三方端点仍会被塞上
//      `Authorization: Bearer <无关密钥>`。
//   2) 响应里的图片 URL 曾被无条件下载：不校验主机、不设大小上限、不校验内容，
//      恶意/被攻陷网关可借它探测内网，并把任意内容写成 .png/.jpg。
//
// 本脚本用「替身 fetch」把两条链路都真实跑一遍（不联网、不依赖任何 API key），
// 断言修复后的行为，同时覆盖不该被误伤的正常路径（公网 URL、本地部署私网 URL、
// 显式 apiKey / apiKeyEnv、非 apiKeyOptional 通道的全局兜底）。
//
// 用法：node scripts/regression-security.mjs（需要先 npm run build）

import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { register } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 与 smoke.mjs 相同：本地没有 node_modules，把 @deepseek-ai/* 指向内置替身。
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
// DNS 也换成可控替身：这样「解析到私网 / 解析失败 / 解析到公网」三种分支都能
// 离线、确定性地断言，不依赖真实 DNS。
const dnsStub = `
export const lookup = async (hostname) => {
  const resolver = globalThis.__IMAGE_DNS_RESOLVER__
  if (typeof resolver !== 'function') {
    throw Object.assign(new Error('no test DNS resolver for ' + hostname), { code: 'ENOTFOUND' })
  }
  return resolver(hostname)
}
`
const schemasteryUrl = 'data:text/javascript,' + encodeURIComponent(stubs)
const toolsUrl = 'data:text/javascript,' + encodeURIComponent(toolsStub)
const dnsUrl = 'data:text/javascript,' + encodeURIComponent(dnsStub)
const hook = [
  'const schemastery = ' + JSON.stringify(schemasteryUrl),
  'const tools = ' + JSON.stringify(toolsUrl),
  'const dns = ' + JSON.stringify(dnsUrl),
  'export async function resolve(specifier, context, next) {',
  '  if (specifier === "@deepseek-ai/schemastery") return { url: schemastery, shortCircuit: true }',
  '  if (specifier === "@deepseek-ai/dsh-tools") return { url: tools, shortCircuit: true }',
  '  if (specifier === "node:dns/promises") return { url: dns, shortCircuit: true }',
  '  return next(specifier, context)',
  '}',
].join('\n')
register('data:text/javascript,' + encodeURIComponent(hook))

const host = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0zaAAAAAElFTkSuQmCC',
  'base64',
)
const pngResponse = () => new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } })
const gatewayUrlResponse = (url) => new Response(JSON.stringify({ data: [{ url }] }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

/** 记录每一次 fetch 调用（POST 生成请求 + 后续图片下载）。 */
const realFetch = globalThis.fetch
const installFetch = (handler) => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    calls.push({ url: href, init })
    return handler(href, init)
  }
  return calls
}
const restoreFetch = () => { globalThis.fetch = realFetch }

// —— 工具执行脚手架 ——
const outDir = resolve(root, 'tmp-smoke/security')
let tool
const ctx = {
  inject(names, callback) {
    if (names.includes('attachments')) {
      callback({ tools: { register: (definition) => { tool = definition } }, get: () => undefined })
    }
  },
  effect: () => () => {},
}
const config = (overrides) => ({
  defaultProvider: 'relay',
  apiKeys: {},
  baseUrls: {},
  models: {},
  customProviders: { relay: { baseUrl: 'https://1.1.1.1/v1', model: 'gw-image', apiKey: 'sk-relay' } },
  outDir,
  attachToConversation: false,
  count: 1,
  aspect: '1:1',
  requestTimeoutMs: 5000,
  ...overrides,
})
const runTool = (overrides, args = { prompt: '安全回归' }) => {
  tool = undefined
  host.apply(ctx, config(overrides))
  return tool.execute(args, { signal: undefined })
}

/** 跑一次工具；成功返回 { ok:true, result }，失败返回 { ok:false, message }。 */
const attemptTool = async (overrides, args) => {
  try {
    return { ok: true, result: await runTool(overrides, args) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
const listOutDir = async () => {
  try {
    return await readdir(outDir)
  } catch {
    return []
  }
}

const LOCAL_PROVIDER = { local: { baseUrl: 'http://127.0.0.1:11434', model: 'flux-local', apiKeyOptional: true } }
const LOCAL_HOST_PROVIDER = { local: { baseUrl: 'http://localhost:11434', model: 'flux-local', apiKeyOptional: true } }
const RELAY_PROVIDER = { relay: { baseUrl: 'https://1.1.1.1/v1', model: 'gw-image', apiKey: 'sk-relay' } }
/** 故意不写 apiKey / apiKeyEnv：用来验证「未声明 apiKeyOptional」通道仍保留全局兜底。 */
const GLOBAL_FALLBACK_PROVIDER = { relay: { baseUrl: 'https://1.1.1.1/v1', model: 'gw-image' } }

// —— 环境变量隔离：这组用例要主动构造 IMAGE_API_KEY / OPENAI_API_KEY ——
const ENV_NAMES = ['IMAGE_API_KEY', 'OPENAI_API_KEY', 'REGRESSION_CHANNEL_KEY']
const savedEnv = new Map(ENV_NAMES.map((name) => [name, process.env[name]]))
const setEnv = (values) => {
  for (const name of ENV_NAMES) {
    if (values[name] === undefined) delete process.env[name]
    else process.env[name] = values[name]
  }
}
const restoreEnv = () => {
  for (const name of ENV_NAMES) {
    const saved = savedEnv.get(name)
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
}

try {
  await mkdir(outDir, { recursive: true })

  // ==========================================================================
  // 1) API key：apiKeyOptional 不再被全局环境变量兜底穿透
  // ==========================================================================
  const keyCase = async (label, overrides, env, expectAuth) => {
    const before = await listOutDir()
    setEnv(env)
    const calls = installFetch(() => pngResponse())
    const outcome = await attemptTool(overrides)
    restoreFetch()
    const authorization = calls[0]?.init?.headers?.authorization
    if (expectAuth === undefined) {
      check(`apiKeyOptional 通道不发 Authorization：${label}`, authorization === undefined && outcome.ok,
        `authorization=${JSON.stringify(authorization)} outcome=${outcome.ok ? 'ok' : outcome.message}`)
    } else {
      check(`鉴权头仍按显式配置发送：${label}`, authorization === expectAuth && outcome.ok,
        `authorization=${JSON.stringify(authorization)} expected=${JSON.stringify(expectAuth)}`)
    }
    return { authorization, outcome, before }
  }

  await keyCase('IMAGE_API_KEY 在环境里', { defaultProvider: 'local', customProviders: LOCAL_PROVIDER },
    { IMAGE_API_KEY: 'sentinel-image-key' }, undefined)
  await keyCase('OPENAI_API_KEY 在环境里', { defaultProvider: 'local', customProviders: LOCAL_PROVIDER },
    { OPENAI_API_KEY: 'sentinel-openai-key' }, undefined)
  await keyCase('两个全局变量同时存在', { defaultProvider: 'local', customProviders: LOCAL_PROVIDER },
    { IMAGE_API_KEY: 'sentinel-image-key', OPENAI_API_KEY: 'sentinel-openai-key' }, undefined)

  // 不能过度修复：没有声明 apiKeyOptional 的自定义通道，仍保留文档化的全局兜底。
  await keyCase('未声明 apiKeyOptional 的通道仍走全局兜底',
    { defaultProvider: 'relay', customProviders: GLOBAL_FALLBACK_PROVIDER }, { IMAGE_API_KEY: 'sentinel-image-key' },
    'Bearer sentinel-image-key')

  // 显式 apiKey / apiKeyEnv 仍然是最高优先级（即使 apiKeyOptional: true）。
  await keyCase('显式 apiKey 优先于全局兜底',
    { defaultProvider: 'local', customProviders: { local: { ...LOCAL_PROVIDER.local, apiKey: 'sk-explicit' } } },
    { IMAGE_API_KEY: 'sentinel-image-key' }, 'Bearer sk-explicit')
  await keyCase('显式 apiKeyEnv 优先于全局兜底',
    {
      defaultProvider: 'local',
      customProviders: { local: { ...LOCAL_PROVIDER.local, apiKeyEnv: 'REGRESSION_CHANNEL_KEY' } },
    },
    { IMAGE_API_KEY: 'sentinel-image-key', REGRESSION_CHANNEL_KEY: 'sk-channel-env' }, 'Bearer sk-channel-env')

  // 内置通道不受全局变量影响：缺 doubao key 时应报缺失，而不是拿 IMAGE_API_KEY 顶上。
  setEnv({ IMAGE_API_KEY: 'sentinel-image-key' })
  installFetch(() => pngResponse())
  const builtinOutcome = await attemptTool({ defaultProvider: 'doubao', customProviders: {} })
  restoreFetch()
  check('内置通道不会误用全局 IMAGE_API_KEY（仍报缺 key）',
    !builtinOutcome.ok && builtinOutcome.message.includes('未配置 API key') && builtinOutcome.message.includes('ARK_API_KEY'),
    builtinOutcome.ok ? 'unexpected ok' : builtinOutcome.message)
  setEnv({})

  // ==========================================================================
  // 2) 图片 URL 下载：主机 / 重定向 / 大小 / 内容
  // ==========================================================================
  /** 网关返回一个图片 URL，后续下载由 downloadHandler 决定。 */
  const urlCase = async (label, overrides, imageUrl, downloadHandler) => {
    const calls = installFetch((href, init) => {
      if (init?.method === 'POST') return gatewayUrlResponse(imageUrl)
      return downloadHandler(href)
    })
    const outcome = await attemptTool(overrides)
    restoreFetch()
    return { calls, outcome }
  }

  // —— 不该误伤的正常路径 ——
  const localAllowed = await urlCase('本地部署：私网生图端点 + 私网图片 URL',
    { defaultProvider: 'local', customProviders: LOCAL_PROVIDER }, 'http://127.0.0.1:8188/view?f=a.png', () => pngResponse())
  check('本地部署允许下载本机图片 URL',
    localAllowed.outcome.ok && localAllowed.outcome.result.images.length === 1,
    localAllowed.outcome.ok ? 'ok' : localAllowed.outcome.message)
  check('本地部署下载落盘文件真实存在',
    localAllowed.outcome.ok && await readFile(localAllowed.outcome.result.images[0].path).then(() => true, () => false))

  const localhostAllowed = await urlCase('本地部署：localhost 端点 + 私网图片 URL',
    { defaultProvider: 'local', customProviders: LOCAL_HOST_PROVIDER }, 'http://127.0.0.1:8188/view?f=b.png', () => pngResponse())
  check('端点写成 localhost 时同样允许本机图片 URL',
    localhostAllowed.outcome.ok && localhostAllowed.outcome.result.images.length === 1,
    localhostAllowed.outcome.ok ? 'ok' : localhostAllowed.outcome.message)

  const publicAllowed = await urlCase('公网网关 + 公网图片 URL',
    { defaultProvider: 'relay', customProviders: RELAY_PROVIDER }, 'http://93.184.216.34/img.png', () => pngResponse())
  check('公网图片 URL 仍可正常下载（不误伤 CDN/预签名 URL）',
    publicAllowed.outcome.ok && publicAllowed.outcome.result.images.length === 1,
    publicAllowed.outcome.ok ? 'ok' : publicAllowed.outcome.message)

  // —— SSRF：公网网关不能把下载指向私网/回环/元数据地址 ——
  const ssrfCases = [
    ['回环 127.0.0.1', 'http://127.0.0.1:8188/secret'],
    ['内网 10/8', 'http://10.0.0.5/secret'],
    ['内网 192.168/16', 'http://192.168.1.10/secret'],
    ['云元数据 169.254.169.254', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['IPv4 映射 IPv6 回环', 'http://[::ffff:127.0.0.1]:8188/secret'],
    ['localhost 主机名', 'http://localhost:8188/secret'],
  ]
  for (const [label, imageUrl] of ssrfCases) {
    const probe = await urlCase(`SSRF：${label}`,
      { defaultProvider: 'relay', customProviders: RELAY_PROVIDER }, imageUrl, () => { throw new Error('不该发起下载') })
    const downloadAttempted = probe.calls.some((call) => call.url === imageUrl)
    check(`公网网关拒绝下载私网地址：${label}`,
      !probe.outcome.ok && probe.outcome.message.includes('拒绝下载') && !downloadAttempted,
      `downloadAttempted=${downloadAttempted} outcome=${probe.outcome.ok ? 'ok' : probe.outcome.message.slice(0, 120)}`)
  }

  // —— 域名解析：解析到私网要拦、解析失败/空结果 fail-closed、解析到公网放行 ——
  globalThis.__IMAGE_DNS_RESOLVER__ = async (hostname) => {
    if (hostname === 'internal.example') return [{ address: '10.9.8.7', family: 4 }]
    if (hostname === 'cdn.example') return [{ address: '93.184.216.34', family: 4 }]
    if (hostname === 'empty.example') return []
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
  }
  const dnsPrivate = await urlCase('DNS：解析到私网',
    { defaultProvider: 'relay', customProviders: RELAY_PROVIDER }, 'http://internal.example/img.png', () => pngResponse())
  check('域名解析到私网地址时拒绝下载',
    !dnsPrivate.outcome.ok && dnsPrivate.outcome.message.includes('内网/回环')
      && !dnsPrivate.calls.some((call) => call.url === 'http://internal.example/img.png'),
    dnsPrivate.outcome.ok ? 'unexpected ok' : dnsPrivate.outcome.message.slice(0, 120))

  const dnsFailure = await urlCase('DNS：解析失败',
    { defaultProvider: 'relay', customProviders: RELAY_PROVIDER }, 'http://broken.invalid/img.png', () => pngResponse())
  check('DNS 解析失败时按拒绝处理（fail-closed，不放行）',
    !dnsFailure.outcome.ok && dnsFailure.outcome.message.includes('无法解析')
      && !dnsFailure.calls.some((call) => call.url === 'http://broken.invalid/img.png'),
    dnsFailure.outcome.ok ? 'unexpected ok' : dnsFailure.outcome.message.slice(0, 120))

  const dnsPublic = await urlCase('DNS：解析到公网',
    { defaultProvider: 'relay', customProviders: RELAY_PROVIDER }, 'http://cdn.example/img.png', () => pngResponse())
  check('域名解析到公网地址仍可下载',
    dnsPublic.outcome.ok && dnsPublic.outcome.result.images.length === 1,
    dnsPublic.outcome.ok ? 'ok' : dnsPublic.outcome.message.slice(0, 120))

  const dnsEmpty = await urlCase('DNS：解析结果为空',
    { defaultProvider: 'relay', customProviders: RELAY_PROVIDER }, 'http://empty.example/img.png', () => pngResponse())
  check('DNS 返回空结果按无法解析处理（fail-closed）',
    !dnsEmpty.outcome.ok && dnsEmpty.outcome.message.includes('无法解析'),
    dnsEmpty.outcome.ok ? 'unexpected ok' : dnsEmpty.outcome.message.slice(0, 120))

  // —— 端点域名解析失败：按「端点不是本机/内网」处理（allowPrivate=false），
  //    不能因此 fail-open 放行私网图片 URL ——
  const UNRESOLVED_ENDPOINT_PROVIDER = { relay: { baseUrl: 'https://relay.invalid/v1', model: 'gw-image', apiKey: 'sk-relay' } }
  const unresolvedEndpointPublic = await urlCase('端点域名解析失败 + 公网图片 URL',
    { defaultProvider: 'relay', customProviders: UNRESOLVED_ENDPOINT_PROVIDER },
    'http://93.184.216.34/img.png', () => pngResponse())
  check('端点域名解析失败时公网图片 URL 仍可下载',
    unresolvedEndpointPublic.outcome.ok && unresolvedEndpointPublic.outcome.result.images.length === 1,
    unresolvedEndpointPublic.outcome.ok ? 'ok' : unresolvedEndpointPublic.outcome.message.slice(0, 120))

  const unresolvedEndpointPrivate = await urlCase('端点域名解析失败 + 私网图片 URL',
    { defaultProvider: 'relay', customProviders: UNRESOLVED_ENDPOINT_PROVIDER },
    'http://127.0.0.1:8188/secret', () => pngResponse())
  check('端点域名解析失败时私网图片 URL 仍被拒绝',
    !unresolvedEndpointPrivate.outcome.ok && unresolvedEndpointPrivate.outcome.message.includes('内网/回环')
      && !unresolvedEndpointPrivate.calls.some((call) => call.url.includes('127.0.0.1:8188')),
    unresolvedEndpointPrivate.outcome.ok ? 'unexpected ok' : unresolvedEndpointPrivate.outcome.message.slice(0, 120))
  delete globalThis.__IMAGE_DNS_RESOLVER__

  // —— 重定向：每一跳都要重新校验，不能 302 进内网 ——
  const redirectBlocked = await urlCase('重定向：公网 → 内网',
    { defaultProvider: 'relay', customProviders: RELAY_PROVIDER }, 'http://93.184.216.34/start',
    (href) => href === 'http://93.184.216.34/start'
      ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8188/secret' } })
      : pngResponse())
  check('重定向到内网被拒绝，且内网地址没有被请求',
    !redirectBlocked.outcome.ok && redirectBlocked.outcome.message.includes('拒绝下载')
      && !redirectBlocked.calls.some((call) => call.url.includes('127.0.0.1:8188')),
    `calls=${redirectBlocked.calls.map((call) => call.url).join(' | ')}`)

  const redirectAllowed = await urlCase('重定向：公网 → 公网',
    { defaultProvider: 'relay', customProviders: RELAY_PROVIDER }, 'http://93.184.216.34/start',
    (href) => href === 'http://93.184.216.34/start'
      ? new Response(null, { status: 302, headers: { location: 'http://93.184.216.35/end.png' } })
      : pngResponse())
  check('公网重定向链仍能正常跟随',
    redirectAllowed.outcome.ok && redirectAllowed.outcome.result.images.length === 1,
    redirectAllowed.outcome.ok ? 'ok' : redirectAllowed.outcome.message)

  const redirectLoop = await urlCase('重定向循环',
    { defaultProvider: 'relay', customProviders: RELAY_PROVIDER }, 'http://93.184.216.34/loop',
    (href) => new Response(null, { status: 302, headers: { location: href } }))
  check('重定向次数有上限（不会无限跟随）',
    !redirectLoop.outcome.ok && redirectLoop.outcome.message.includes('重定向次数过多'),
    redirectLoop.outcome.ok ? 'unexpected ok' : redirectLoop.outcome.message.slice(0, 120))

  // —— 大小上限：Content-Length 预告超限 + 无 Content-Length 的流式超限 ——
  const oversizeDeclared = await urlCase('超大图：Content-Length 预告',
    { defaultProvider: 'local', customProviders: LOCAL_PROVIDER }, 'http://127.0.0.1:8188/huge.png',
    () => new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(64 * 1024 * 1024) } }))
  check('Content-Length 超限时直接拒绝（不下载）',
    !oversizeDeclared.outcome.ok && oversizeDeclared.outcome.message.includes('图片过大'),
    oversizeDeclared.outcome.ok ? 'unexpected ok' : oversizeDeclared.outcome.message.slice(0, 120))

  const oversizeStreamed = await urlCase('超大图：无长度头的流式响应',
    { defaultProvider: 'local', customProviders: LOCAL_PROVIDER }, 'http://127.0.0.1:8188/stream.png',
    () => {
      const chunk = new Uint8Array(1024 * 1024)
      let sent = 0
      return new Response(new ReadableStream({
        pull(controller) {
          if (sent >= 33) {
            controller.close()
            return
          }
          sent += 1
          controller.enqueue(chunk)
        },
      }), { status: 200, headers: { 'content-type': 'image/png' } })
    })
  check('无 Content-Length 时按已读字节中断下载',
    !oversizeStreamed.outcome.ok && oversizeStreamed.outcome.message.includes('图片过大'),
    oversizeStreamed.outcome.ok ? 'unexpected ok' : oversizeStreamed.outcome.message.slice(0, 120))

  // —— 内容校验：不是 PNG/JPEG 的内容不落盘 ——
  const beforeHtml = await listOutDir()
  const htmlCase = await urlCase('非图片内容（HTML）',
    { defaultProvider: 'local', customProviders: LOCAL_PROVIDER }, 'http://127.0.0.1:8188/not-an-image',
    () => new Response('<html><body>internal service</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
  const afterHtml = await listOutDir()
  check('非 PNG/JPEG 内容被拒绝',
    !htmlCase.outcome.ok && htmlCase.outcome.message.includes('不是 PNG/JPEG'),
    htmlCase.outcome.ok ? 'unexpected ok' : htmlCase.outcome.message.slice(0, 120))
  check('内容不合格时没有新增落盘文件', afterHtml.length === beforeHtml.length,
    `before=${beforeHtml.length} after=${afterHtml.length}`)

  const emptyCase = await urlCase('空响应体',
    { defaultProvider: 'local', customProviders: LOCAL_PROVIDER }, 'http://127.0.0.1:8188/empty',
    () => new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'image/png' } }))
  check('空图片数据仍按原错误拒绝',
    !emptyCase.outcome.ok && emptyCase.outcome.message.includes('空的图片数据'),
    emptyCase.outcome.ok ? 'unexpected ok' : emptyCase.outcome.message.slice(0, 120))

  const badUrlCase = await urlCase('非法图片 URL',
    { defaultProvider: 'local', customProviders: LOCAL_PROVIDER }, 'http://[::1', () => pngResponse())
  check('非法图片 URL 被拒绝',
    !badUrlCase.outcome.ok && badUrlCase.outcome.message.includes('图片 URL 不合法'),
    badUrlCase.outcome.ok ? 'unexpected ok' : badUrlCase.outcome.message.slice(0, 120))

  // —— b64 路径不受影响（回归保护） ——
  const b64Calls = installFetch(() => new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  const b64Outcome = await attemptTool({ defaultProvider: 'relay', customProviders: RELAY_PROVIDER })
  restoreFetch()
  check('b64_json 正常路径不受影响',
    b64Outcome.ok && b64Outcome.result.images.length === 1 && b64Calls.length === 1,
    b64Outcome.ok ? `images=${b64Outcome.result.images.length}` : b64Outcome.message)

  // —— 错误响应体限长：5xx 超大错误体不应被全量读进内存 ——
  const errorCalls = installFetch(() => new Response('E'.repeat(1024 * 1024), {
    status: 503,
    headers: { 'content-type': 'text/plain' },
  }))
  const errorOutcome = await attemptTool({ defaultProvider: 'relay', customProviders: RELAY_PROVIDER })
  restoreFetch()
  check('5xx 超大错误体：按重试策略失败且错误信息被截断',
    !errorOutcome.ok && errorOutcome.message.includes('请求失败')
      && errorCalls.length === 3 && errorOutcome.message.length < 800,
    `calls=${errorCalls.length} messageLen=${errorOutcome.ok ? 0 : errorOutcome.message.length}`)
} finally {
  delete globalThis.__IMAGE_DNS_RESOLVER__
  restoreFetch()
  restoreEnv()
  await rm(outDir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
