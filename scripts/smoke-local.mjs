// scripts/smoke-local.mjs —— 本地部署形态的端到端自检（不需要任何 API key）。
//
// 起三个假服务器，分别模拟本地生图服务常见的三种响应形态，然后用插件的
// generate_image 工具真实调用它们（走完整 HTTP + 解码 + 落盘链路）：
//   1) 二进制直出（Content-Type: image/png）
//   2) JSON images[] 数组（SD-WebUI 兼容网关风格）
//   3) NDJSON 流（每行一个对象，最后一行带 b64）
// 并验证免鉴权端点不发 Authorization、自定义响应头/尺寸/额外字段都按配置生效。
//
// 用法：node scripts/smoke-local.mjs

import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 真实依赖在 profile 里；这里用替身让自检可独立运行。
const stubs = `const node = (t, e = {}) => new Proxy({ t, ...e }, { get(x, k) { if (k === 'toJSON') return () => ({ type: x.t }); if (k in x) return x[k]; return (...a) => node(x.t, { ...x, [k]: a }) } }); export default { object: () => node('object'), dict: () => node('dict'), array: () => node('array'), union: () => node('union'), string: () => node('string'), number: () => node('number'), boolean: () => node('boolean'), any: () => node('any') }`
const hook = `export async function resolve(s, c, n) { if (s === '@deepseek-ai/schemastery') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(stubs)}), shortCircuit: true }; if (s === '@deepseek-ai/dsh-tools') return { url: 'data:text/javascript,' + encodeURIComponent('export const defineTool = (o) => o'), shortCircuit: true }; return n(s, c) }`
register(`data:text/javascript,${encodeURIComponent(hook)}`)

const host = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

// 1×1 PNG（base64）。
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0zaAAAAAElFTkSuQmCC',
  'base64',
)

/** 请求记录：每个服务器单独收集，用于断言请求体与请求头。 */
const requests = []
/** 起一个假服务器，返回 { url, close }。 */
const startServer = (name, respond) => new Promise((resolveReady) => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ name, url: req.url, headers: req.headers, body: body === '' ? undefined : JSON.parse(body) })
      respond(res)
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolveReady({ url: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(done)) })
  })
})

const binary = await startServer('binary', (res) => {
  res.writeHead(200, { 'content-type': 'image/png' })
  res.end(pngBytes)
})
const arrayServer = await startServer('array', (res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ images: [pngBytes.toString('base64')], info: 'sd-webui style' }))
})
const ndjson = await startServer('ndjson', (res) => {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  res.end('{"progress": 10}\n{"progress": 90}\n' + JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] }) + '\n')
})

const outDir = await mkdtemp(join(tmpdir(), 'imagegen-local-'))

/** 用给定 provider 配置跑一次 generate_image。 */
const generate = async (customProviders, defaultProvider = 'local', args = {}, modelsOverride = {}) => {
  let tool
  const ctx = {
    inject(names, callback) {
      if (names.includes('attachments')) callback({ tools: { register: (definition) => { tool = definition } }, get: () => undefined })
    },
    effect: () => () => {},
  }
  host.apply(ctx, {
    defaultProvider,
    apiKeys: {},
    baseUrls: {},
    models: modelsOverride,
    customProviders,
    outDir,
    attachToConversation: false,
    count: 1,
    aspect: '1:1',
    requestTimeoutMs: 10_000,
  })
  return tool.execute({ prompt: '本地部署测试图', ...args }, { signal: undefined })
}

try {
  // —— 1) 二进制直出 + 免鉴权 ——
  const binaryResult = await generate({
    local: { baseUrl: binary.url, model: 'flux-local', apiKeyOptional: true, sendWatermark: false, size: '768x768' },
  })
  check('二进制直出：拿到 1 张图', binaryResult.images.length === 1)
  check('二进制直出：落盘为 .png', binaryResult.images[0].path.endsWith('.png'), binaryResult.images[0].path)
  const savedBytes = await readFile(binaryResult.images[0].path)
  check('二进制直出：字节与上游一致', savedBytes.equals(pngBytes), `${savedBytes.length} bytes`)
  const binaryRequest = requests.find((entry) => entry.name === 'binary')
  check('免鉴权端点不发 Authorization', binaryRequest.headers.authorization === undefined, JSON.stringify(binaryRequest.headers))
  check('自定义 size 生效', binaryRequest.body.size === '768x768', binaryRequest.body.size)
  check('sendWatermark=false 时不发 watermark', binaryRequest.body.watermark === undefined, JSON.stringify(binaryRequest.body))
  check('endpoint 自动补全路径', binaryRequest.url === '/v1/images/generations', binaryRequest.url)

  // —— 2) images[] 数组形态 ——
  const arrayResult = await generate({
    sd: { baseUrl: `${arrayServer.url}/v1`, model: 'sd_xl_base_1.0', apiKeyOptional: true, sendWatermark: false },
  }, 'sd')
  check('images[] 形态：拿到 1 张图', arrayResult.images.length === 1)
  const arrayRequest = requests.find((entry) => entry.name === 'array')
  check('baseUrl 以 /v1 结尾时不重复拼接', arrayRequest.url === '/v1/images/generations', arrayRequest.url)
  check('未配置 sizes 时用兜底尺寸表', arrayRequest.body.size === '1024x1024', arrayRequest.body.size)

  // —— 3) NDJSON 流 ——
  const ndjsonResult = await generate({
    stream: { baseUrl: ndjson.url, model: 'flux-stream', apiKeyOptional: true },
  }, 'stream')
  check('NDJSON 形态：拿到 1 张图', ndjsonResult.images.length === 1)

  // —— 4) 一次出多张（supportsN） ——
  const multi = await startServer('multi', (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      data: [
        { b64_json: pngBytes.toString('base64') },
        { b64_json: pngBytes.toString('base64') },
        { b64_json: pngBytes.toString('base64') },
      ],
    }))
  })
  const multiResult = await generate({
    multi: { baseUrl: multi.url, model: 'flux-batch', apiKeyOptional: true, supportsN: true, maxN: 4 },
  }, 'multi', { count: 3 })
  check('supportsN：一次请求拿到 3 张', multiResult.images.length === 3, `count=${multiResult.images.length}`)
  const multiRequest = requests.find((entry) => entry.name === 'multi')
  check('supportsN：请求体 n=3', multiRequest.body.n === 3, JSON.stringify(multiRequest.body.n))

  // —— 5) 自定义鉴权头 ——
  const authServer = await startServer('auth', (res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(pngBytes)
  })
  await generate({
    custom: {
      baseUrl: authServer.url,
      model: 'vendor-pro',
      apiKey: 'secret-token',
      authHeader: 'x-api-key',
      authScheme: '',
      sendWatermark: false,
    },
  }, 'custom')
  const authRequest = requests.find((entry) => entry.name === 'auth')
  check('自定义鉴权头生效', authRequest.headers['x-api-key'] === 'secret-token', JSON.stringify(authRequest.headers))
  check('自定义鉴权方案为空时不加前缀', authRequest.headers.authorization === undefined)

  // —— 6) 回归：历史遗留键 `<通道>/model` 与规范键 `models.<通道>` ——
  // 老配置（0.3.1 设置页写下的键）必须继续生效；规范键存在时优先级更高。
  const legacyModels = await generate({
    local: { baseUrl: binary.url, model: 'flux-local', apiKeyOptional: true, sendWatermark: false },
  }, 'local', {}, { 'local/model': 'flux-legacy' })
  check('遗留键 models[通道/model] 仍能改变实际请求模型',
    legacyModels.model === 'flux-legacy', legacyModels.model)
  const legacyRequest = requests.filter((entry) => entry.name === 'binary').at(-1)
  check('遗留键生效时请求体不带内置模型',
    legacyRequest.body.model === 'flux-legacy', legacyRequest.body.model)

  const canonicalModels = await generate({
    local: { baseUrl: binary.url, model: 'flux-local', apiKeyOptional: true, sendWatermark: false },
  }, 'local', {}, { local: 'flux-canonical', 'local/model': 'flux-legacy' })
  check('规范键优先于遗留键', canonicalModels.model === 'flux-canonical', canonicalModels.model)

  await multi.close()
  await authServer.close()
} finally {
  await binary.close()
  await arrayServer.close()
  await ndjson.close()
  await rm(outDir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
