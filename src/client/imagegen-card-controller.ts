/**
 * imagegen-card-controller.ts —— 设置卡片控制器（浏览器半侧）。
 *
 * 一个极简的 staged 表单：草稿存在组件里，只有点“保存”才通过
 * settingsScope 写入（set/unset），Revision 栅由 scope 自己保证；
 * 卡片不依赖任何 UI 库，样式内联，因此 bundle 零外部依赖（除 React）。
 */

// Type-only（构建时擦除）：只借类型，不产生跨插件运行时依赖。
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** 与 Host 半侧 installSection 使用的命名空间一致（配对键）。 */
export const IMAGEGEN_NS = 'imagegen'

/** 卡片可编辑的四个字段（路径即设置文档里的字段路径）。 */
export type ImagegenFieldPath =
  | 'apiKeys.doubao'
  | 'apiKeys.qwen'
  | 'baseUrls.doubao'
  | 'baseUrls.qwen'

export type ImagegenFieldKind = 'secret' | 'url'

export interface ImagegenFieldSpec {
  path: ImagegenFieldPath
  kind: ImagegenFieldKind
}

export const IMAGEGEN_FIELDS: readonly ImagegenFieldSpec[] = [
  { path: 'apiKeys.doubao', kind: 'secret' },
  { path: 'apiKeys.qwen', kind: 'secret' },
  { path: 'baseUrls.doubao', kind: 'url' },
  { path: 'baseUrls.qwen', kind: 'url' },
]

/** 组件持有的草稿：值与用户输入一一对应（secret 为空 = 保持不变/清除覆盖）。 */
export interface ImagegenDrafts {
  'apiKeys.doubao': string
  'apiKeys.qwen': string
  'baseUrls.doubao': string
  'baseUrls.qwen': string
}

export function emptyDrafts(): ImagegenDrafts {
  return { 'apiKeys.doubao': '', 'apiKeys.qwen': '', 'baseUrls.doubao': '', 'baseUrls.qwen': '' }
}

export type ImagegenSnapshot = SettingsScopeSnapshot<unknown>

/** 从快照读取字段的解析值（用户层/组装层合并后）。 */
export function draftFromSnapshot(snapshot: ImagegenSnapshot, path: ImagegenFieldPath): string {
  const value = pathValue(snapshot.value, path)
  return typeof value === 'string' ? value : ''
}

/** 字段当前是否被用户层覆盖（覆盖 = 该路径在 user 里“出现”，与值无关）。 */
export function isOverridden(snapshot: ImagegenSnapshot, path: ImagegenFieldPath): boolean {
  return pathValue(snapshot.user, path) !== undefined
}

/** 三层任一路径存在“非空字符串”即视为已配置（空串默认占位不算）。 */
export function isConfigured(snapshot: ImagegenSnapshot, path: ImagegenFieldPath): boolean {
  return hasNonEmpty(snapshot.base, path) || hasNonEmpty(snapshot.user, path) || hasNonEmpty(snapshot.value, path)
}

function hasNonEmpty(root: unknown, path: string): boolean {
  const value = pathValue(root, path)
  return typeof value === 'string' && value.trim() !== ''
}

/** 按 . 分隔的路径读 JSON 值；只处理这层表单用到的对象路径。 */
function pathValue(root: unknown, path: string): unknown {
  let node: unknown = root
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

export interface ImagegenCardFace {
  hooks: {
    /** 快照订阅源；渲染机制会把它绑成 use<Name> 选择器钩子交给组件。 */
    imagegenCard: { getSnapshot(): ImagegenSnapshot; subscribe(listener: () => void): () => void }
  }
  /** 保存草稿：非空 set；空串且此前有用户覆盖则 unset（回退到入口配置/环境变量）。 */
  save(drafts: ImagegenDrafts): Promise<void>
  /** 放弃草稿：无副作用（组件会重新从快照播种）。 */
  discard(): void
}

/** 桥接 imagegen 命名空间 scope 与卡片。 */
export class ImagegenCardController {
  constructor(private readonly scope: SettingsScope<unknown>) {}

  private readonly getSnapshot = (): ImagegenSnapshot => this.scope.getSnapshot()
  private readonly subscribe = (listener: () => void): (() => void) => this.scope.subscribe(listener)

  /**
   * 卡片槽位注册时注入的面。注入面契约（scoped-slots bindInjectSources）：
   * `hooks` / `keyedHooks` 是仅有的两个保留分栏（成员绑定成 use<Name> 钩子），
   * 其余成员（这里的 save / discard）必须平铺在面上，原样透传成组件 props。
   */
  face(): ImagegenCardFace {
    return {
      hooks: { imagegenCard: { getSnapshot: this.getSnapshot, subscribe: this.subscribe } },
      save: async (drafts) => {
        const snapshot = this.scope.getSnapshot()
        for (const field of IMAGEGEN_FIELDS) {
          const draft = drafts[field.path].trim()
          // 写路径必须按嵌套段寻址：scope.set() 只生成 [field] 单段，而
          // 'apiKeys.doubao' 这类点号路径需要拆成 ['apiKeys','doubao']，
          // 否则 host 端会把它当成一个字面键写进 section（schema 校验时被
          // 丢弃，保存看似成功实则无效）。
          const segments = field.path.split('.')
          if (draft !== '') {
            await this.scope.mutate([{ op: 'set', path: segments, value: draft }])
          } else if (isOverridden(snapshot, field.path)) {
            await this.scope.mutate([{ op: 'unset', path: segments }])
          }
        }
      },
      discard: () => {},
    }
  }
}
