// imagegen-card-core.js —— 设置卡片的纯逻辑层（浏览器半侧，无 React 依赖）。
//
// 这一层把「表单草稿」翻译成 Host 设置面的写操作，并做所有可以离线测试的
// 归一化/校验。渲染只发生在 ImagegenCard.js。
//
// 与旧版（DSH 0.1.x）的关键差异：不再有 `ctx.settingsScope.bind(...)`。
// 现行宿主把每个插件的配置暴露成 `ctx.configForms.get(entryId)`：
//   - 读：form.getSnapshot().value / .base / .user / .revision / .writable
//   - 写：form.mutate([{ op: 'set', path, value } | { op: 'unset', path }], revision)
// secret 字段在快照里恒为脱敏值，所以「留空 = 保持、输入 = 覆盖」必须靠
// 路径级 set/unset 表达，绝不能整节回写。

/** 设置命名空间 = profile 里的 entry id（与 Host 半侧 IMAGEGEN_SETTINGS_NS 配对）。 */
export const IMAGEGEN_NS = 'imagegen'

/** 卡片可编辑的字符串字段（路径即设置文档里的字段路径）。 */
export const IMAGEGEN_FIELDS = [
  { path: 'apiKeys.doubao', kind: 'secret' },
  { path: 'apiKeys.qwen', kind: 'secret' },
  { path: 'baseUrls.doubao', kind: 'url' },
  { path: 'baseUrls.qwen', kind: 'url' },
]

/** 每个内置通道的默认 endpoint（与 Host 半侧 providers.js 一致，仅用于占位提示）。 */
export const BUILTIN_ENDPOINTS = {
  doubao: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations',
}

/** 每个内置通道的默认模型 id（未配置 models 时生效）。 */
export const BUILTIN_MODELS = {
  doubao: 'doubao-seedream-5-0-pro-260628',
  qwen: 'qwen-image-3.0-pro',
}

/** 内置通道的 API key 环境变量回退名（Host 半侧同源）。 */
export const BUILTIN_KEY_ENV = {
  doubao: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'ALIYUN_API_KEY'],
}

/** 内置通道名。 */
export const BUILTIN_CHANNELS = ['doubao', 'qwen']

/**
 * 旧版卡片写在模型单元格里的键后缀（`<通道>/model`、`<通道>/label`）。
 *
 * 这两个键是 0.3.1 的缺陷产物：GUI 写的是 `<通道>/model`，而 Host 与卡片自己
 * 都只读 `<通道>` / `<通道>/default`，于是「在设置页填了模型」永远不生效。
 * 现在的规范键是 `models.<通道>`（见 modelPath）；这两个后缀只用于**读取**历史
 * 配置、并在保存时把它迁移掉，不再作为写入目标。
 */
export const MODEL_ID_SUFFIX = 'model'
export const MODEL_LABEL_SUFFIX = 'label'

/**
 * 空白草稿：值与用户输入一一对应。
 * secret 为空 = 保持不变 / 清除覆盖；普通字符串为空 = 清除覆盖；models 为空 = 保持不变。
 * @returns {Record<string, string>} 草稿。
 */
export function emptyDrafts() {
  return {
    'apiKeys.doubao': '',
    'apiKeys.qwen': '',
    'baseUrls.doubao': '',
    'baseUrls.qwen': '',
    'models.doubao': '',
    'models.qwen': '',
    customProviders: '',
  }
}

/** 按 . 分隔的路径读 JSON 值；只处理这层表单用到的对象路径。 */
function pathValue(root, path) {
  let node = root
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = node[key]
  }
  return node
}

/**
 * 从快照读取字段的解析值（用户层/组装层合并后）。
 * @param {object} snapshot - ConfigForm 快照。
 * @param {string} path - 点分路径。
 * @returns {string} 文本值（非字符串一律空串）。
 */
export function draftFromSnapshot(snapshot, path) {
  const value = pathValue(snapshot.value, path)
  return typeof value === 'string' ? value : ''
}

/**
 * 字段当前是否被用户层覆盖（覆盖 = 该路径在 user 里「出现」，与值无关）。
 * @param {object} snapshot - ConfigForm 快照。
 * @param {string} path - 点分路径。
 * @returns {boolean} 是否被覆盖。
 */
export function isOverridden(snapshot, path) {
  return pathValue(snapshot.user, path) !== undefined
}

/**
 * 三层任一路径存在非空字符串即视为已配置（空串默认占位不算）。
 * @param {object} snapshot - ConfigForm 快照。
 * @param {string} path - 点分路径。
 * @returns {boolean} 是否已配置。
 */
export function isConfigured(snapshot, path) {
  return hasNonEmpty(snapshot.base, path) || hasNonEmpty(snapshot.user, path) || hasNonEmpty(snapshot.value, path)
}

function hasNonEmpty(root, path) {
  const value = pathValue(root, path)
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * secret 字段是否有「非空的环境变量兜底」。
 * 快照里读不到 secret 是否已存（脱敏），所以只能报告环境变量的存在性。
 * @param {string} channel - 通道名。
 * @returns {boolean} 是否存在该通道的环境变量兜底名。
 */
export function envFallbackNames(channel) {
  return BUILTIN_KEY_ENV[channel] ?? []
}

/**
 * 从配置值里读一个通道当前的模型声明（规范键优先，旧键兜底）。
 * @param {unknown} models - 配置的 models 字典。
 * @param {string} channel - 通道名。
 * @returns {{ id: string, label?: string } | undefined} 声明。
 */
export function modelOf(models, channel) {
  return readModelEntry(models, modelPath(channel))
    ?? readModelEntry(models, `${channel}/default`)
    ?? readModelEntry(models, legacyModelPath(channel))
}

function readModelEntry(models, key) {
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return undefined
  const value = models[key]
  if (typeof value === 'string') {
    const id = value.trim()
    return id === '' ? undefined : { id }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const id = typeof value.id === 'string' ? value.id.trim() : ''
    if (id === '') return undefined
    const label = typeof value.label === 'string' && value.label.trim() !== '' ? value.label.trim() : undefined
    return label === undefined ? { id } : { id, label }
  }
  return undefined
}

/**
 * 把 models 字典里的 `<通道>/<别名>` 条目读成别名行。
 *
 * `<通道>/model` 与 `<通道>/label` 是旧版卡片的实现细节键，不是别名；它们对应的
 * 模型已经在通道行里显示，这里必须跳过，否则设置页会多出一条重名的假别名。
 * @param {unknown} models - 配置的 models 字典。
 * @returns {{ channel: string, alias: string, id: string, label?: string }[]} 别名行。
 */
export function modelAliasRows(models) {
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return []
  const rows = []
  for (const [key, value] of Object.entries(models)) {
    const [channel, ...rest] = String(key).split('/')
    const alias = rest.join('/')
    if (channel === '' || alias === '' || alias === 'default') continue
    if (alias === MODEL_ID_SUFFIX || alias === MODEL_LABEL_SUFFIX) continue
    const spec = readModelEntry({ [key]: value }, key)
    if (spec === undefined) continue
    rows.push({ channel, alias, ...spec })
  }
  return rows
}

/** 自定义通道的 JSON 文本（空对象显示为空串）。 */
export function customProvidersText(snapshot) {
  const value = pathValue(snapshot.value, 'customProviders')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  if (Object.keys(value).length === 0) return ''
  return JSON.stringify(value, null, 2)
}

/** 自定义通道名列表（用于卡片上的模型行）。 */
export function customChannelNames(snapshot) {
  const value = pathValue(snapshot.value, 'customProviders')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  return Object.keys(value)
}

/** 判断文本是否是可接受的 customProviders 形状（空串 = 清空）。 */
export function customProvidersProblem(raw) {
  if (raw.trim() === '') return false
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
  } catch {
    return true
  }
}

/** 判断文本是否是可接受的 models 形状（空串 = 不改）。 */
export function modelsProblem(raw) {
  if (raw.trim() === '') return false
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return true
    return Object.values(parsed).some((value) => typeof value !== 'string'
      && (typeof value !== 'object' || value === null || Array.isArray(value)))
  } catch {
    return true
  }
}

/** 点分路径 → 设置操作路径段。 */
function segments(path) {
  return path.split('.')
}

/** 模型行的规范键：`models.<通道>`（与 Host 的 defaultModelFor 读法一致）。 */
function modelPath(channel) {
  return channel
}

/** 旧版卡片写下的遗留键：`models.<通道>/model`，仅用于读取与迁移。 */
function legacyModelPath(channel) {
  return `${channel}/${MODEL_ID_SUFFIX}`
}

/**
 * 某个通道的默认模型是否在用户层被覆盖过（规范键 `<通道>`、`<通道>/default`，
 * 或 0.3.1 写下的遗留键 `<通道>/model`）。
 * @param {object} snapshot - ConfigForm 快照。
 * @param {string} channel - 通道名。
 * @returns {boolean} 是否被覆盖。
 */
export function modelOverridePresent(snapshot, channel) {
  const user = snapshot.user
  if (typeof user !== 'object' || user === null) return false
  const models = user.models
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return false
  return models[modelPath(channel)] !== undefined
    || models[`${channel}/default`] !== undefined
    || models[legacyModelPath(channel)] !== undefined
}

/**
 * 把草稿翻译成 Host 写操作序列。
 *
 * 规则（逐字段）：
 *   - 非空草稿 → set 到该路径（模型行写规范的 `models.<通道>`）；
 *   - 空草稿 + 曾覆盖 → unset 该路径；
 *   - 空草稿 + 未曾覆盖 → 什么都不做（保持继承值）。
 * 模型行额外做一次迁移：写入规范键时顺手清掉 0.3.1 的遗留键 `<通道>/model`
 * 与 `<通道>/label`，保证「在设置页填过的模型」真正生效。
 * customProviders 是整块替换：非空 set 对象，空 + 覆盖 unset，空 + 未覆盖不写。
 * @param {object} snapshot - ConfigForm 快照（提供 user 层用于判断覆盖）。
 * @param {Record<string, string>} drafts - 表单草稿。
 * @returns {{ ops: object[], error?: string }} 操作序列或校验错误。
 */
export function buildSaveOps(snapshot, drafts) {
  if (customProvidersProblem(drafts.customProviders)) {
    return { ops: [], error: 'customProviders 必须是 JSON 对象' }
  }
  if (modelsProblem(drafts.models)) {
    return { ops: [], error: 'models 必须是 JSON 对象，且每个值是字符串或 { id, label } 对象' }
  }

  const ops = []
  for (const field of IMAGEGEN_FIELDS) {
    const draft = drafts[field.path].trim()
    if (draft !== '') ops.push({ op: 'set', path: segments(field.path), value: draft })
    else if (isOverridden(snapshot, field.path)) ops.push({ op: 'unset', path: segments(field.path) })
  }

  for (const channel of modelRowChannels(snapshot, drafts)) {
    // 自定义通道是动态出现的，草稿里可能还没有它的键（用户刚在 JSON 里声明），
    // 这时按「留空」处理，不能在这里抛。
    const draft = (drafts[`models.${channel}`] ?? '').trim()
    // 注意：models 的键本身就含 `/`（`<通道>/<别名>`），必须作为**单个键**写在
    // `models` 之下，不能按点分路径拆段。规范键是纯通道名 `models.<通道>`。
    if (draft !== '') {
      ops.push({ op: 'set', path: ['models', modelPath(channel)], value: draft })
      // 迁移：把 0.3.1 写下的遗留键清掉，否则旧值会继续盖住新值。
      if (legacyOverridePresent(snapshot, channel)) {
        ops.push({ op: 'unset', path: ['models', legacyModelPath(channel)] })
        ops.push({ op: 'unset', path: ['models', `${channel}/${MODEL_LABEL_SUFFIX}`] })
      }
    } else if (modelOverridePresent(snapshot, channel)) {
      // 清掉这个通道的默认模型：规范键与遗留键一起撤。
      ops.push({ op: 'unset', path: ['models', modelPath(channel)] })
      ops.push({ op: 'unset', path: ['models', legacyModelPath(channel)] })
      ops.push({ op: 'unset', path: ['models', `${channel}/${MODEL_LABEL_SUFFIX}`] })
    }
  }

  const rawCustom = drafts.customProviders.trim()
  if (rawCustom !== '') {
    ops.push({ op: 'set', path: ['customProviders'], value: JSON.parse(rawCustom) })
  } else if (isOverridden(snapshot, 'customProviders')) {
    ops.push({ op: 'unset', path: ['customProviders'] })
  }

  const rawModels = drafts.models.trim()
  if (rawModels !== '') {
    // 高级写法：整块覆盖 models（与上面的单选行可能冲突时，以整块为准，写在最后）。
    ops.push({ op: 'set', path: ['models'], value: JSON.parse(rawModels) })
  }

  return { ops }
}

/** 模型行覆盖的通道：内置两家 + 设置页当前列出的自定义通道（草稿优先）。 */
function modelRowChannels(snapshot, drafts) {
  const channels = [...BUILTIN_CHANNELS]
  for (const channel of customChannelNamesFrom(snapshot, drafts)) {
    if (!channels.includes(channel)) channels.push(channel)
  }
  return channels
}

/** 自定义通道名（草稿里的 customProviders JSON 优先，解析失败时回落到快照）。 */
function customChannelNamesFrom(snapshot, drafts) {
  const raw = typeof drafts.customProviders === 'string' ? drafts.customProviders.trim() : ''
  if (raw !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return Object.keys(parsed)
    } catch {
      // 草稿不合法时交给 buildSaveOps 的校验报错，这里不重复处理。
    }
  }
  return customChannelNames(snapshot)
}

/** 用户层是否存在遗留键 `models.<通道>/model`。 */
function legacyOverridePresent(snapshot, channel) {
  const user = snapshot.user
  if (typeof user !== 'object' || user === null) return false
  const models = user.models
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return false
  return models[legacyModelPath(channel)] !== undefined
}
