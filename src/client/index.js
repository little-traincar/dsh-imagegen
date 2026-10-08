// imagegen 浏览器半侧 —— 把 imagegen 配置页挂进「设置」侧栏（slot: settings.section，
// id = imagegen），并给 generate_image 注册会话内的专属行（slot: tool.call.toolview）。
//
// 运行时只依赖平台已提供的服务（slots / locale / configForms）；不 import 任何其它
// 插件的值，因此客户端 bundle 不产生跨插件值导入。
//
// 与上游 0.1.x 版本的差异：注入的服务从 settingsScope 换成 configForms —— 现行宿主
// 把插件配置暴露为 ctx.configForms.get(entryId)（读快照 + 原子 mutate）。

import { ImagegenCard } from './ImagegenCard.js'
import { GenerateImageToolview } from './imagegen-toolview.js'
import { buildSaveOps, IMAGEGEN_NS } from './imagegen-card-core.js'
import * as copy from './locales.js'

/** 本卡片文案字典的命名空间。 */
const COPY_NS = 'settings.imagegen'

/** 文案字典（先在模块顶层取好，避免对象字面量里出现被内联改写的简写属性）。 */
const dictionaries = { zh: copy.zh, en: copy.en }

/** 需要的客户端服务（cordis fiber inject）。常量名刻意避开 inject：源码里
 *  `inject:` 是槽位注册的对象键，同名会让打包器的标识符重命名改坏键位。 */
const PLUGIN_INJECT = ['slots', 'locale', 'configForms']

export { PLUGIN_INJECT as inject }

/**
 * 挂载生图配置页与会话行。
 * @param {object} ctx - 浏览器插件上下文。
 */
export function apply(ctx) {
  // 一个 namespace 一份 ConfigForm：读写都走它自己的队列与 revision 栅。
  const form = ctx.configForms.get(IMAGEGEN_NS)
  const t = ctx.locale.bind(COPY_NS)

  ctx.effect(
    () => ctx.locale.register(COPY_NS, dictionaries),
    'imagegen: card dictionaries',
  )

  /**
   * 卡片注入面。契约（scoped-slots bindInjectSources）：`hooks` 分栏的成员被绑定成
   * use<Name> 选择器钩子；其余成员原样透传成组件 props。
   * @returns {object} 注入面。
   */
  const face = () => ({
    hooks: {
      imagegenCard: {
        getSnapshot: () => form.getSnapshot(),
        subscribe: (listener) => form.subscribe(listener),
      },
    },
    /** 保存：把草稿翻出来的设置操作一次交给宿主；返回是否被接受。 */
    save: (ops) => form.mutate(ops),
    /** 放弃修改：草稿在组件本地，无需写回；保留接口位以便将来做服务端草稿。 */
    discard: () => {},
  })

  // 标准入口：设置侧栏一页（shell 每行 = 一条注册：id/order/label）。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: IMAGEGEN_NS,
    order: 60,
    label: () => t('title'),
    locale: COPY_NS,
    inject: face,
  }, ImagegenCard))

  // 会话展示：keyed toolview（key = 线工具名）。没有它，generate_image 的结果走
  // 通用行，image 内容块只被压成 JSON 文本。
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'generate_image',
    locale: COPY_NS,
  }, GenerateImageToolview))
}

/** 供自检断言：卡片保存路径能被独立复算出来。 */
export { buildSaveOps }
