// ImagegenCard.js —— 「设置 → imagegen」卡片。
//
// 独立外观（不导入其它插件的卡片组件，遵守客户端 bundle 纯净度门禁）：
// 用 ConfigForm 快照播种草稿，保存时把所有变更一次写回（非空 set、
// 空串+曾覆盖 unset）。样式全部内联，无 CSS 管道。
//
// 与上游 0.1.x 版本的差异：
//   - 不再走 ctx.settingsScope，改为 ctx.configForms.get('imagegen') 的
//     getSnapshot / mutate（见 imagegen-card-core.js 顶部说明）。
//   - 新增「模型」编辑行：每个通道的模型 id 都能自由填写（含自定义通道与别名）。
//   - models 明细用整块 JSON 文本域兜底，支持别名与多模型声明。
//
// 注入面契约（scoped-slots bindInjectSources）：面里 hooks 分栏的每个成员由渲染
// 机制绑定成 use<Name> 选择器钩子，其它成员原样透传为 props。

import { createElement as h, useEffect, useRef, useState } from 'react'
import {
  BUILTIN_CHANNELS,
  BUILTIN_KEY_ENV,
  BUILTIN_MODELS,
  buildSaveOps,
  customChannelNames,
  customProvidersProblem,
  customProvidersText,
  draftFromSnapshot,
  emptyDrafts,
  IMAGEGEN_FIELDS,
  isConfigured,
  isOverridden,
  modelAliasRows,
  modelOf,
} from './imagegen-card-core.js'

/** 卡片样式表。 */
const cardStyles = {
  card: {
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))',
    borderRadius: 12,
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    background: 'var(--dsw-alias-bg-module-plain, transparent)',
  },
  head: { display: 'flex', flexDirection: 'column', gap: 4 },
  title: { color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 15, fontWeight: 600, margin: 0 },
  description: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12.5, margin: 0 },
  group: { display: 'flex', flexDirection: 'column', gap: 12 },
  groupTitle: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 13, fontWeight: 600, margin: 0 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  fieldHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  label: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 13, fontWeight: 500 },
  badge: {
    fontSize: 11,
    padding: '1px 8px',
    borderRadius: 999,
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))',
    color: 'var(--dsw-alias-label-tertiary, #999)',
  },
  badgeOn: { background: 'var(--dsw-alias-bg-module-hover, rgba(128,128,128,.12))' },
  input: {
    boxSizing: 'border-box',
    width: '100%',
    font: 'inherit',
    fontSize: 13,
    padding: '7px 10px',
    borderRadius: 8,
    border: '0.5px solid var(--dsw-alias-border-input, rgba(128,128,128,.45))',
    background: 'var(--dsw-alias-bg-input, transparent)',
    color: 'var(--dsw-alias-label-primary, inherit)',
  },
  textarea: {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 132,
    resize: 'vertical',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12.5,
    lineHeight: 1.5,
    padding: '8px 10px',
    borderRadius: 8,
    border: '0.5px solid var(--dsw-alias-border-input, rgba(128,128,128,.45))',
    background: 'var(--dsw-alias-bg-input, transparent)',
    color: 'var(--dsw-alias-label-primary, inherit)',
  },
  hint: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12, margin: 0 },
  warn: { color: 'var(--dsw-alias-label-danger, #d03050)', fontSize: 12, margin: 0 },
  actions: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' },
  button: {
    font: 'inherit',
    fontSize: 13,
    padding: '6px 14px',
    borderRadius: 8,
    cursor: 'pointer',
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.45))',
    background: 'var(--dsw-alias-bg-module-hover, rgba(128,128,128,.1))',
    color: 'var(--dsw-alias-label-primary, inherit)',
  },
  primary: {
    border: '0',
    background: 'var(--dsw-alias-interactive-bg-primary, #2456e6)',
    color: '#fff',
  },
  status: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' },
  divider: { height: 1, background: 'var(--dsw-alias-border-l2, rgba(128,128,128,.2))', margin: '2px 0' },
}

/** 一个字段编辑行的文案键集合（字段顺序即渲染顺序）。 */
const FIELD_COPY = {
  'apiKeys.doubao': { label: 'keyDoubao', hint: 'keyDoubaoHint' },
  'apiKeys.qwen': { label: 'keyQwen', hint: 'keyQwenHint' },
  'baseUrls.doubao': { label: 'urlDoubao', hint: 'urlDoubaoHint' },
  'baseUrls.qwen': { label: 'urlQwen', hint: 'urlQwenHint' },
}

/** 自定义通道文本域的 DOM id。 */
const CUSTOM_FIELD_ID = 'imagegen-customProviders'
/** models 明细文本域的 DOM id。 */
const MODELS_FIELD_ID = 'imagegen-models'

/** 渲染生图 API 设置卡片。 */
export function ImagegenCard(props) {
  const { t } = props
  // useImagegenCard 是渲染机制从注入面 hooks 绑定的选择器钩子（订阅已内置）。
  const snapshot = props.useImagegenCard((value) => value)

  const [drafts, setDrafts] = useState(emptyDrafts)
  const [modelsDraft, setModelsDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [errorText, setErrorText] = useState('')
  const seeded = useRef(undefined)

  // 快照 revision 变化（首次就绪或别处写入）时重新播种：草稿归零、明细文本跟随刷新。
  const revision = snapshot.revision
  useEffect(() => {
    if (snapshot.status !== 'ready' || revision === undefined) return
    if (seeded.current === revision) return
    seeded.current = revision
    setDrafts(emptyDrafts())
    setModelsDraft('')
    setResult('')
    setErrorText('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.status, revision])

  if (snapshot.status === 'loading') {
    return h('section', { style: cardStyles.card },
      h('h3', { style: cardStyles.title }, t('title')),
      h('p', { style: cardStyles.hint }, t('loading')))
  }

  const editable = snapshot.status === 'ready' && snapshot.writable
  const unavailable = snapshot.status === 'unavailable'
  const currentModels = snapshot.value === undefined ? undefined : snapshot.value.models
  const draftOf = (path) => drafts[path]
  const setDraft = (path, text) => setDrafts((draft) => ({ ...draft, [path]: text }))

  const stringField = (path) => {
    const spec = IMAGEGEN_FIELDS.find((field) => field.path === path)
    const copy = FIELD_COPY[path]
    const secret = spec.kind === 'secret'
    const configured = secret && isConfigured(snapshot, path)
    const overridden = isOverridden(snapshot, path)
    const text = draftOf(path)
    // secret 行永远渲染草稿文本（快照里是脱敏值，回显无意义）；普通字段在草稿为空时回显解析值。
    const resolved = draftFromSnapshot(snapshot, path)
    const shown = secret ? text : (text !== '' || resolved === '' ? text : resolved)
    const badge = secret
      ? h('span', { style: { ...cardStyles.badge, ...(configured ? cardStyles.badgeOn : {}) } },
        t(configured ? 'configured' : 'unconfigured'))
      : (overridden ? h('span', { style: { ...cardStyles.badge, ...cardStyles.badgeOn } }, 'override') : null)
    return h('div', { key: path, style: cardStyles.field },
      h('div', { style: cardStyles.fieldHead },
        h('label', { style: cardStyles.label, htmlFor: `imagegen-${path}` }, t(copy.label)),
        badge),
      h('input', {
        id: `imagegen-${path}`,
        style: cardStyles.input,
        type: secret ? 'password' : 'text',
        autoComplete: secret ? 'off' : undefined,
        spellCheck: false,
        value: shown,
        placeholder: secret ? t('keyPlaceholder') : (resolved || undefined),
        disabled: !editable,
        onChange: (event) => setDraft(path, event.target.value),
      }),
      h('p', { style: cardStyles.hint }, t(copy.hint)))
  }

  /** 一个通道的模型行：模型 id 可自由填写。 */
  const modelField = (channel) => {
    const configured = modelOf(currentModels, channel)
    const text = draftOf(`models.${channel}`)
    const fallback = BUILTIN_MODELS[channel]
    const shown = text !== '' ? text : (configured?.id ?? '')
    const isCustom = !BUILTIN_CHANNELS.includes(channel)
    return h('div', { key: `model-${channel}`, style: cardStyles.field },
      h('div', { style: cardStyles.fieldHead },
        h('label', { style: cardStyles.label, htmlFor: `imagegen-model-${channel}` }, `${channel} ${t('modelLabel')}`),
        isCustom ? h('span', { style: cardStyles.badge }, t('customBadge')) : null,
        configured !== undefined
          ? h('span', { style: { ...cardStyles.badge, ...cardStyles.badgeOn } }, 'override')
          : null),
      h('input', {
        id: `imagegen-model-${channel}`,
        style: cardStyles.input,
        type: 'text',
        spellCheck: false,
        value: shown,
        placeholder: fallback ?? t('modelPlaceholder'),
        disabled: !editable,
        onChange: (event) => setDraft(`models.${channel}`, event.target.value),
      }),
      h('p', { style: cardStyles.hint },
        `${t('modelHint')}${fallback === undefined ? '' : ` ${t('modelDefaultHint')}${fallback}`}`))
  }

  const aliases = modelAliasRows(currentModels)
  const customNames = customChannelNames(snapshot)

  const onSave = async () => {
    const built = buildSaveOps(snapshot, { ...drafts, models: modelsDraft })
    if (built.error !== undefined) {
      setResult('error')
      setErrorText(t(built.error === 'customProviders 必须是 JSON 对象' ? 'customInvalid' : 'modelsJsonInvalid'))
      return
    }
    if (built.ops.length === 0) {
      setResult('ok')
      return
    }
    setBusy(true)
    setResult('')
    setErrorText('')
    try {
      const accepted = await props.save(built.ops)
      if (accepted === false) throw new Error(t('conflict'))
      setResult('ok')
      setDrafts(emptyDrafts())
      setModelsDraft('')
    } catch (error) {
      setResult('error')
      setErrorText(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const onDiscard = () => {
    props.discard()
    seeded.current = undefined
    setDrafts(emptyDrafts())
    setModelsDraft('')
    setResult('')
    setErrorText('')
  }

  const customBad = customProvidersProblem(drafts.customProviders)
  const modelsBad = customProvidersProblem(modelsDraft) && modelsDraft.trim() !== '' && modelsDraft.trim() !== '{}'
  const customCurrent = customProvidersText(snapshot)
  const customShown = drafts.customProviders !== '' ? drafts.customProviders : customCurrent

  return h('section', { style: cardStyles.card },
    h('header', { style: cardStyles.head },
      h('h3', { style: cardStyles.title }, t('title')),
      h('p', { style: cardStyles.description }, t('description'))),

    unavailable ? h('p', { style: cardStyles.warn }, t('unavailable')) : null,

    h('div', { style: cardStyles.group },
      h('h4', { style: cardStyles.groupTitle }, t('modelsTitle')),
      h('p', { style: cardStyles.hint }, t('modelsDescription')),
      BUILTIN_CHANNELS.map((channel) => modelField(channel)),
      customNames.map((channel) => modelField(channel)),
      aliases.length > 0
        ? h('p', { style: cardStyles.hint },
          `${t('aliasesLabel')}${aliases.map((row) => `${row.channel}/${row.alias} → ${row.id}`).join('；')}`)
        : null),

    h('div', { style: cardStyles.divider }),

    h('div', { style: cardStyles.group },
      h('h4', { style: cardStyles.groupTitle }, t('builtinTitle')),
      IMAGEGEN_FIELDS.map((field) => stringField(field.path))),

    h('div', { style: cardStyles.divider }),

    h('div', { style: cardStyles.group },
      h('h4', { style: cardStyles.groupTitle }, t('customTitle')),
      h('textarea', {
        id: CUSTOM_FIELD_ID,
        style: cardStyles.textarea,
        spellCheck: false,
        value: customShown,
        placeholder: t('customPlaceholder'),
        disabled: !editable,
        onChange: (event) => setDraft('customProviders', event.target.value),
      }),
      customBad
        ? h('p', { style: cardStyles.warn }, t('customInvalid'))
        : h('div', { style: cardStyles.fieldHead },
          isOverridden(snapshot, 'customProviders')
            ? h('span', { style: { ...cardStyles.badge, ...cardStyles.badgeOn } }, 'override')
            : null,
          h('p', { style: cardStyles.hint }, t('customHint'))),
      h('p', { style: cardStyles.hint },
        `${t('envHint')}${BUILTIN_CHANNELS.map((channel) => `${channel}: ${BUILTIN_KEY_ENV[channel][0]}`).join('；')}`)),

    h('div', { style: cardStyles.group },
      h('h4', { style: cardStyles.groupTitle }, t('modelsJsonTitle')),
      h('textarea', {
        id: MODELS_FIELD_ID,
        style: { ...cardStyles.textarea, minHeight: 96 },
        spellCheck: false,
        value: modelsDraft,
        placeholder: t('modelsJsonPlaceholder'),
        disabled: !editable,
        onChange: (event) => setModelsDraft(event.target.value),
      }),
      modelsBad
        ? h('p', { style: cardStyles.warn }, t('modelsJsonInvalid'))
        : h('p', { style: cardStyles.hint }, t('modelsJsonHint'))),

    h('div', { style: cardStyles.actions },
      result === 'ok' ? h('span', { style: cardStyles.status }, t('saved')) : null,
      result === 'error' ? h('span', { style: { ...cardStyles.status, ...cardStyles.warn } }, t('error') + errorText) : null,
      h('button', { type: 'button', style: cardStyles.button, disabled: !editable || busy, onClick: onDiscard }, t('discard')),
      h('button', {
        type: 'button',
        style: { ...cardStyles.button, ...cardStyles.primary },
        disabled: !editable || busy,
        onClick: onSave,
      }, busy ? t('saving') : t('save'))))
}

/** 供自检断言：卡片渲染引用的文案键必须都在字典里。 */
export const CARD_COPY_KEYS = [
  'title', 'description', 'loading', 'unavailable', 'modelsTitle', 'modelsDescription',
  'modelLabel', 'modelHint', 'modelDefaultHint', 'modelPlaceholder', 'customBadge', 'aliasesLabel',
  'builtinTitle', 'customTitle', 'customHint', 'customPlaceholder', 'customInvalid', 'envHint',
  'modelsJsonTitle', 'modelsJsonHint', 'modelsJsonPlaceholder', 'modelsJsonInvalid',
  'keyDoubao', 'keyDoubaoHint', 'keyQwen', 'keyQwenHint',
  'urlDoubao', 'urlDoubaoHint', 'urlQwen', 'urlQwenHint',
  'save', 'discard', 'saving', 'saved', 'error', 'conflict',
  'configured', 'unconfigured', 'keyPlaceholder',
]
