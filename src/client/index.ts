/**
 * imagegen 浏览器半侧 —— 把 imagegen 命名空间的设置卡片挂进
 * “设置”侧栏的一页（slot: settings.section，id = imagegen，
 * 与 ui-agent-preset 的 Agent presets 页同一入口约定）。
 *
 * 运行时只依赖平台已提供的服务（slots / locale / settingsScope）；
 * 对其它包的引用全部是 type-only（import type 会被构建擦除），
 * 因此客户端 bundle 不产生任何跨插件值导入（bundle 纯净度要求）。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：拉取各客户端包的 Context/slot 声明合并（构建期全部擦除）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ImagegenCard } from './ImagegenCard.tsx'
import { GenerateImageToolview } from './imagegen-toolview.tsx'
import { IMAGEGEN_NS, ImagegenCardController } from './imagegen-card-controller.ts'
import { en, zh } from './locales.ts'

/** 本卡片文案字典的命名空间。 */
const COPY_NS = 'settings.imagegen'

/** 需要的客户端服务（cordis fiber inject）。 */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * 挂载生图 API 设置卡片。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  const controller = new ImagegenCardController(ctx.settingsScope.bind({ namespace: IMAGEGEN_NS }))
  const t = ctx.locale.bind(COPY_NS)

  ctx.effect(
    () => ctx.locale.register(COPY_NS, { zh, en }),
    'imagegen: card dictionaries',
  )

  // 标准入口：设置侧栏一页（shell 每行 = 一条注册：id/order/label）。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'imagegen',
    order: 60,
    label: () => t('title'),
    locale: COPY_NS,
    inject: () => controller.face(),
  }, ImagegenCard))

  // 会话展示：keyed toolview（key = 线工具名）。没有它，generate_image 的
  // 结果走通用行，image 内容块只被压成 JSON 文本。声明只在 ui-tool 的
  // ToolTree 出口存在时生效（无会话组成的部署自动跳过）。
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'generate_image',
  }, GenerateImageToolview))
}
