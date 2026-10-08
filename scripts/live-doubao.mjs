// scripts/live-doubao.mjs —— 真实出图验收：用已配置的豆包 key 走一遍完整工具链路。
//
// 只读用户设置里的 imagegen.apiKeys.doubao（不打印 key），生成 1 张后校验字节格式。
// 用法：在 profile 目录下 node <此文件>（需能解析 @little-traincar/dsh-imagegen）。

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { readFile as readText } from 'node:fs/promises'

const settingsPath = join(process.env.USERPROFILE ?? '', '.dsh', 'settings.yaml')
const settings = load(await readText(settingsPath, 'utf8')) ?? {}
const apiKey = settings?.imagegen?.apiKeys?.doubao
if (typeof apiKey !== 'string' || apiKey.trim() === '') {
  console.log('SKIP: 设置里没有豆包 key')
  process.exit(0)
}
console.log('使用设置里的豆包 key（长度', apiKey.length, '，不回显）')

const host = await import('@little-traincar/dsh-imagegen')

const outDir = await mkdtemp(join(tmpdir(), 'imagegen-live-'))
const attachments = []
let tool
const ctx = {
  inject(names, callback) {
    if (names.includes('attachments')) {
      callback({
        tools: { register: (definition) => { tool = definition } },
        get: () => ({
          saveImage: async ({ data, mediaType, name }) => {
            attachments.push({ mediaType, name, bytes: data.byteLength })
            // 只要 1×1 元数据即可，真实 DSH 会算尺寸；这里返回占位值。
            return { attachmentId: `live-${attachments.length}`, mediaType, bytes: data.byteLength, width: 1, height: 1, name }
          },
        }),
      })
    }
  },
  effect: () => () => {},
}

host.apply(ctx, {
  defaultProvider: 'doubao',
  apiKeys: { doubao: apiKey },
  baseUrls: {},
  models: {},
  customProviders: {},
  outDir,
  attachToConversation: true,
  count: 1,
  aspect: '2:3',
  requestTimeoutMs: 300_000,
})

console.log('调用 generate_image（doubao，1 张，2:3）…')
const started = Date.now()
try {
  const result = await tool.execute({
    prompt: '极简产品海报：一只白色陶瓷咖啡杯放在米色背景上，柔和侧光，大量留白，日式侘寂风，低饱和米白与浅灰配色',
  }, { signal: undefined })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log('✓ 生成成功，用时', seconds, 's')
  console.log('  provider/model:', result.provider, '/', result.model)
  console.log('  aspect/size:', result.aspect, '/', result.size)
  console.log('  张数:', result.images.length, '| 失败:', result.failures.length)
  for (const image of result.images) {
    const bytes = await readFile(image.path)
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
    console.log('  文件:', image.path.split(/[\\/]/u).pop(), '|', bytes.byteLength, 'bytes |',
      isJpeg ? 'JPEG' : isPng ? 'PNG' : '未知格式', '| attached:', image.attached)
    if (!isJpeg && !isPng) throw new Error('落盘文件不是图片格式')
  }
  console.log('  会话附件:', attachments.length, '个（', attachments.map((a) => a.mediaType).join(','), '）')
  console.log('LIVE OK')
} catch (error) {
  console.log('✗ 失败:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await rm(outDir, { recursive: true, force: true })
}
