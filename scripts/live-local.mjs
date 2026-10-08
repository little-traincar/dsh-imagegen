// scripts/live-local.mjs —— 真实图片链路：起一个真的会生成 PNG 的本地 OpenAI 兼容服务，
// 再用插件真调用一次，断言：请求体、落盘字节、尺寸、附件元数据、以及「模型可自由配置」。
//
// 用法：node scripts/live-local.mjs [--plugin <插件目录>]
// 说明：图片用 zlib 手工编码成合法 PNG（不依赖任何图像库）。

import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginIndex = process.argv.indexOf('--plugin')
const root = pluginIndex === -1 ? here : resolve(process.argv[pluginIndex + 1])

// @deepseek-ai/* 替身（本脚本只关心链路，不校验 DSH API 面）。
const stubs = `
const node = (type, extra = {}) => new Proxy({ type, ...extra }, {
  get(target, key) {
    if (key === 'toJSON') return () => ({ type: target.type })
    if (key in target) return target[key]
    return (...args) => node(target.type, { ...target, [key]: args })
  },
})
export default { object: () => node('object'), dict: (i) => node('dict'), array: (i) => node('array'), union: (l) => node('union'), string: () => node('string'), number: () => node('number'), boolean: () => node('boolean'), any: () => node('any') }
`
register('data:text/javascript,' + encodeURIComponent([
  'export async function resolve(specifier, context, next) {',
  `  if (specifier === "@deepseek-ai/schemastery") return { url: "data:text/javascript,${encodeURIComponent(stubs)}", shortCircuit: true }`,
  '  if (specifier === "@deepseek-ai/dsh-tools") return { url: "data:text/javascript,export const defineTool = (o) => o", shortCircuit: true }',
  '  return next(specifier, context)',
  '}',
].join('\n')))

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** 生成一张 w×h 的真 PNG（真 zlib 压缩、真 CRC、真 IHDR/IDAT/IEND）。 */
function makePng(width, height) {
  const crcTable = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buffer) => {
    let c = 0xffffffff
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < width; x += 1) {
      raw[offset] = (x * 255 / width) | 0
      raw[offset + 1] = (y * 255 / height) | 0
      raw[offset + 2] = 128
      offset += 3
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const png = makePng(832, 1216)
const requests = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    requests.push({ url: req.url, headers: req.headers, body: body === '' ? undefined : JSON.parse(body) })
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) })
    res.end(png)
  })
})
await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const port = server.address().port
const outDir = await mkdtemp(join(tmpdir(), 'imagegen-live-'))

const host = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)
let tool
const savedAttachments = []
const ctx = {
  inject(names, callback) {
    if (names.includes('attachments')) {
      callback({
        tools: { register: (definition) => { tool = definition } },
        get: (name) => (name === 'attachments'
          ? {
              saveImage: async (input) => {
                savedAttachments.push(input)
                return { attachmentId: `att-${savedAttachments.length}`, mediaType: input.mediaType, bytes: input.data.byteLength, width: 832, height: 1216, name: input.name }
              },
            }
          : undefined),
      })
    }
  },
  effect: () => () => {},
}

host.apply(ctx, {
  defaultProvider: 'local',
  apiKeys: {},
  baseUrls: {},
  models: { local: 'flux-live-1' },
  customProviders: {
    local: { baseUrl: `http://127.0.0.1:${port}`, model: 'ignored-by-models', apiKeyOptional: true, sendWatermark: false, sizes: { '2:3': '832x1216' } },
  },
  outDir,
  attachToConversation: true,
  count: 1,
  aspect: '2:3',
  requestTimeoutMs: 10_000,
})

const result = await tool.execute({ prompt: '厦门咖啡节海报', text_lines: ['厦门冰咖节', '第二杯半价'] }, { signal: undefined })
const request = requests[0]
const saved = await readFile(result.images[0].path)

check('模型配置生效（models.local 覆盖通道 model）', request.body.model === 'flux-live-1', request.body.model)
check('长宽比映射到真实尺寸', request.body.size === '832x1216', request.body.size)
check('文案逐字进入提示词', request.body.prompt.includes('「厦门冰咖节」') && request.body.prompt.includes('「第二杯半价」'))
check('免鉴权端点不发 Authorization', request.headers.authorization === undefined)
check('落盘字节与上游逐字节一致', saved.equals(png), `${saved.length} vs ${png.length}`)
check('单次调用覆盖模型', (await tool.execute({ prompt: 'x', model: 'flux-override' }, { signal: undefined })).model === 'flux-override')
check('别名字面透传（未声明的模型名）', requests[1].body.model === 'flux-override', requests[1].body.model)
check('附件已保存（会话内嵌的准备条件）', savedAttachments.length === 2 && savedAttachments[0].mediaType === 'image/png', `count=${savedAttachments.length}`)
check('附件元数据与真实尺寸一致', savedAttachments[0].data.byteLength === png.length)
check('结果 output 里带附件引用（前端内嵌显示用）',
  result.images[0].attached === true && result.images[0].image?.attachmentId === 'att-1',
  JSON.stringify(result.images[0].image ?? {}))

await new Promise((done) => server.close(done))
await rm(outDir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
