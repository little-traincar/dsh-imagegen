export const IMAGEGEN_NS = 'imagegen'

export const IMAGEGEN_FIELDS = [
  { path: 'apiKeys.doubao', kind: 'secret' },
  { path: 'apiKeys.qwen', kind: 'secret' },
  { path: 'baseUrls.doubao', kind: 'url' },
  { path: 'baseUrls.qwen', kind: 'url' },
]

export const BUILTIN_ENDPOINTS = {
  doubao: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations',
}

export const BUILTIN_MODELS = {
  doubao: 'doubao-seedream-5-0-pro-260628',
  qwen: 'qwen-image-3.0-pro',
}

export const BUILTIN_KEY_ENV = {
  doubao: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'ALIYUN_API_KEY'],
}

export const BUILTIN_CHANNELS = ['doubao', 'qwen']

export const MODEL_ID_SUFFIX = 'model'
export const MODEL_LABEL_SUFFIX = 'label'

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

function pathValue(root, path) {
  let node = root
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = node[key]
  }
  return node
}

export function draftFromSnapshot(snapshot, path) {
  const value = pathValue(snapshot.value, path)
  return typeof value === 'string' ? value : ''
}

export function isOverridden(snapshot, path) {
  return pathValue(snapshot.user, path) !== undefined
}

export function isConfigured(snapshot, path) {
  return hasNonEmpty(snapshot.base, path) || hasNonEmpty(snapshot.user, path) || hasNonEmpty(snapshot.value, path)
}

function hasNonEmpty(root, path) {
  const value = pathValue(root, path)
  return typeof value === 'string' && value.trim() !== ''
}

export function envFallbackNames(channel) {
  return BUILTIN_KEY_ENV[channel] ?? []
}

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

export function customProvidersText(snapshot) {
  const value = pathValue(snapshot.value, 'customProviders')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  if (Object.keys(value).length === 0) return ''
  return JSON.stringify(value, null, 2)
}

export function customChannelNames(snapshot) {
  const value = pathValue(snapshot.value, 'customProviders')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  return Object.keys(value)
}

export function customProvidersProblem(raw) {
  if (raw.trim() === '') return false
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
  } catch {
    return true
  }
}

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

function segments(path) {
  return path.split('.')
}

function modelPath(channel) {
  return channel
}

function legacyModelPath(channel) {
  return `${channel}/${MODEL_ID_SUFFIX}`
}

export function modelOverridePresent(snapshot, channel) {
  const user = snapshot.user
  if (typeof user !== 'object' || user === null) return false
  const models = user.models
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return false
  return models[modelPath(channel)] !== undefined
    || models[`${channel}/default`] !== undefined
    || models[legacyModelPath(channel)] !== undefined
}

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

    const draft = (drafts[`models.${channel}`] ?? '').trim()

    if (draft !== '') {
      ops.push({ op: 'set', path: ['models', modelPath(channel)], value: draft })

      if (legacyOverridePresent(snapshot, channel)) {
        ops.push({ op: 'unset', path: ['models', legacyModelPath(channel)] })
        ops.push({ op: 'unset', path: ['models', `${channel}/${MODEL_LABEL_SUFFIX}`] })
      }
    } else if (modelOverridePresent(snapshot, channel)) {

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

    ops.push({ op: 'set', path: ['models'], value: JSON.parse(rawModels) })
  }

  return { ops }
}

function modelRowChannels(snapshot, drafts) {
  const channels = [...BUILTIN_CHANNELS]
  for (const channel of customChannelNamesFrom(snapshot, drafts)) {
    if (!channels.includes(channel)) channels.push(channel)
  }
  return channels
}

function customChannelNamesFrom(snapshot, drafts) {
  const raw = typeof drafts.customProviders === 'string' ? drafts.customProviders.trim() : ''
  if (raw !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return Object.keys(parsed)
    } catch {

    }
  }
  return customChannelNames(snapshot)
}

function legacyOverridePresent(snapshot, channel) {
  const user = snapshot.user
  if (typeof user !== 'object' || user === null) return false
  const models = user.models
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return false
  return models[legacyModelPath(channel)] !== undefined
}
