// 由 scripts/build.mjs 生成，请勿直接编辑（改 src/ 下的源码后重新构建）。
window.__ModuleLoader__.load({
	id: "@little-traincar/dsh-imagegen",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		;(() => {
		const dep_h = require("react").createElement;
		const dep_useEffect = require("react").useEffect;
		const dep_useRef = require("react").useRef;
		const dep_useState = require("react").useState;
		// —— client/imagegen-card-core.js ——
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
		const m0_IMAGEGEN_NS = 'imagegen'

		/** 卡片可编辑的字符串字段（路径即设置文档里的字段路径）。 */
		const m0_IMAGEGEN_FIELDS = [
		  { path: 'apiKeys.doubao', kind: 'secret' },
		  { path: 'apiKeys.qwen', kind: 'secret' },
		  { path: 'baseUrls.doubao', kind: 'url' },
		  { path: 'baseUrls.qwen', kind: 'url' },
		]

		/** 每个内置通道的默认 endpoint（与 Host 半侧 providers.js 一致，仅用于占位提示）。 */
		const m0_BUILTIN_ENDPOINTS = {
		  doubao: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
		  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations',
		}

		/** 每个内置通道的默认模型 id（未配置 models 时生效）。 */
		const m0_BUILTIN_MODELS = {
		  doubao: 'doubao-seedream-5-0-pro-260628',
		  qwen: 'qwen-image-3.0-pro',
		}

		/** 内置通道的 API key 环境变量回退名（Host 半侧同源）。 */
		const m0_BUILTIN_KEY_ENV = {
		  doubao: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'],
		  qwen: ['DASHSCOPE_API_KEY', 'ALIYUN_API_KEY'],
		}

		/** 内置通道名。 */
		const m0_BUILTIN_CHANNELS = ['doubao', 'qwen']

		/** 模型单元格里的键名（`<通道>/model`、`<通道>/label`）。 */
		const m0_MODEL_ID_SUFFIX = 'model'
		const m0_MODEL_LABEL_SUFFIX = 'label'

		/**
		 * 空白草稿：值与用户输入一一对应。
		 * secret 为空 = 保持不变 / 清除覆盖；普通字符串为空 = 清除覆盖；models 为空 = 保持不变。
		 * @returns {Record<string, string>} 草稿。
		 */
		function m0_emptyDrafts() {
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
		function m0_pathValue(root, path) {
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
		function m0_draftFromSnapshot(snapshot, path) {
		  const value = m0_pathValue(snapshot.value, path)
		  return typeof value === 'string' ? value : ''
		}

		/**
		 * 字段当前是否被用户层覆盖（覆盖 = 该路径在 user 里「出现」，与值无关）。
		 * @param {object} snapshot - ConfigForm 快照。
		 * @param {string} path - 点分路径。
		 * @returns {boolean} 是否被覆盖。
		 */
		function m0_isOverridden(snapshot, path) {
		  return m0_pathValue(snapshot.user, path) !== undefined
		}

		/**
		 * 三层任一路径存在非空字符串即视为已配置（空串默认占位不算）。
		 * @param {object} snapshot - ConfigForm 快照。
		 * @param {string} path - 点分路径。
		 * @returns {boolean} 是否已配置。
		 */
		function m0_isConfigured(snapshot, path) {
		  return m0_hasNonEmpty(snapshot.base, path) || m0_hasNonEmpty(snapshot.user, path) || m0_hasNonEmpty(snapshot.value, path)
		}

		function m0_hasNonEmpty(root, path) {
		  const value = m0_pathValue(root, path)
		  return typeof value === 'string' && value.trim() !== ''
		}

		/**
		 * secret 字段是否有「非空的环境变量兜底」。
		 * 快照里读不到 secret 是否已存（脱敏），所以只能报告环境变量的存在性。
		 * @param {string} channel - 通道名。
		 * @returns {boolean} 是否存在该通道的环境变量兜底名。
		 */
		function m0_envFallbackNames(channel) {
		  return m0_BUILTIN_KEY_ENV[channel] ?? []
		}

		/**
		 * 从配置值里读一个通道当前的模型声明。
		 * @param {unknown} models - 配置的 models 字典。
		 * @param {string} channel - 通道名。
		 * @returns {{ id: string, label?: string } | undefined} 声明。
		 */
		function m0_modelOf(models, channel) {
		  return m0_readModelEntry(models, channel) ?? m0_readModelEntry(models, `${channel}/default`)
		}

		function m0_readModelEntry(models, key) {
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
		 * @param {unknown} models - 配置的 models 字典。
		 * @returns {{ channel: string, alias: string, id: string, label?: string }[]} 别名行。
		 */
		function m0_modelAliasRows(models) {
		  if (typeof models !== 'object' || models === null || Array.isArray(models)) return []
		  const rows = []
		  for (const [key, value] of Object.entries(models)) {
		    const [channel, ...rest] = String(key).split('/')
		    const alias = rest.join('/')
		    if (channel === '' || alias === '' || alias === 'default') continue
		    const spec = m0_readModelEntry({ [key]: value }, key)
		    if (spec === undefined) continue
		    rows.push({ channel, alias, ...spec })
		  }
		  return rows
		}

		/** 自定义通道的 JSON 文本（空对象显示为空串）。 */
		function m0_customProvidersText(snapshot) {
		  const value = m0_pathValue(snapshot.value, 'customProviders')
		  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
		  if (Object.keys(value).length === 0) return ''
		  return JSON.stringify(value, null, 2)
		}

		/** 自定义通道名列表（用于卡片上的模型行）。 */
		function m0_customChannelNames(snapshot) {
		  const value = m0_pathValue(snapshot.value, 'customProviders')
		  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
		  return Object.keys(value)
		}

		/** 判断文本是否是可接受的 customProviders 形状（空串 = 清空）。 */
		function m0_customProvidersProblem(raw) {
		  if (raw.trim() === '') return false
		  try {
		    const parsed = JSON.parse(raw)
		    return typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
		  } catch {
		    return true
		  }
		}

		/** 判断文本是否是可接受的 models 形状（空串 = 不改）。 */
		function m0_modelsProblem(raw) {
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
		function m0_segments(path) {
		  return path.split('.')
		}

		/** models 字典的键：`<通道>/model` 与 `<通道>/label`。 */
		function m0_modelKey(channel, suffix) {
		  return `${channel}/${suffix}`
		}

		/**
		 * 某个通道的默认模型是否在用户层被覆盖过（`<通道>/model` 或 `<通道>/default`）。
		 * @param {object} snapshot - ConfigForm 快照。
		 * @param {string} channel - 通道名。
		 * @returns {boolean} 是否被覆盖。
		 */
		function m0_modelOverridePresent(snapshot, channel) {
		  const user = snapshot.user
		  if (typeof user !== 'object' || user === null) return false
		  const models = user.models
		  if (typeof models !== 'object' || models === null || Array.isArray(models)) return false
		  return models[m0_modelKey(channel, m0_MODEL_ID_SUFFIX)] !== undefined || models[channel] !== undefined
		}

		/**
		 * 把草稿翻译成 Host 写操作序列。
		 *
		 * 规则（逐字段）：
		 *   - 非空草稿 → set 到该路径（models 子键用 `<通道>/model` / `<通道>/label`）；
		 *   - 空草稿 + 曾覆盖 → unset 该路径；
		 *   - 空草稿 + 未曾覆盖 → 什么都不做（保持继承值）。
		 * customProviders 是整块替换：非空 set 对象，空 + 覆盖 unset，空 + 未覆盖不写。
		 * @param {object} snapshot - ConfigForm 快照（提供 user 层用于判断覆盖）。
		 * @param {Record<string, string>} drafts - 表单草稿。
		 * @returns {{ ops: object[], error?: string }} 操作序列或校验错误。
		 */
		function m0_buildSaveOps(snapshot, drafts) {
		  if (m0_customProvidersProblem(drafts.customProviders)) {
		    return { ops: [], error: 'customProviders 必须是 JSON 对象' }
		  }
		  if (m0_modelsProblem(drafts.models)) {
		    return { ops: [], error: 'models 必须是 JSON 对象，且每个值是字符串或 { id, label } 对象' }
		  }

		  const ops = []
		  for (const field of m0_IMAGEGEN_FIELDS) {
		    const draft = drafts[field.path].trim()
		    if (draft !== '') ops.push({ op: 'set', path: m0_segments(field.path), value: draft })
		    else if (m0_isOverridden(snapshot, field.path)) ops.push({ op: 'unset', path: m0_segments(field.path) })
		  }

		  for (const channel of m0_BUILTIN_CHANNELS) {
		    const draft = drafts[`models.${channel}`].trim()
		    // 注意：models 的键本身就含 `/`（`<通道>/<别名>`），必须作为**单个键**写在
		    // `models` 之下，不能按点分路径拆段。
		    if (draft !== '') ops.push({ op: 'set', path: ['models', m0_modelKey(channel, m0_MODEL_ID_SUFFIX)], value: draft })
		    else if (m0_modelOverridePresent(snapshot, channel)) {
		      // 清掉这个通道的默认模型：id 与展示名一起撤。
		      ops.push({ op: 'unset', path: ['models', m0_modelKey(channel, m0_MODEL_ID_SUFFIX)] })
		      ops.push({ op: 'unset', path: ['models', m0_modelKey(channel, m0_MODEL_LABEL_SUFFIX)] })
		    }
		  }

		  const rawCustom = drafts.customProviders.trim()
		  if (rawCustom !== '') {
		    ops.push({ op: 'set', path: ['customProviders'], value: JSON.parse(rawCustom) })
		  } else if (m0_isOverridden(snapshot, 'customProviders')) {
		    ops.push({ op: 'unset', path: ['customProviders'] })
		  }

		  const rawModels = drafts.models.trim()
		  if (rawModels !== '') {
		    // 高级写法：整块覆盖 models（与上面的单选行可能冲突时，以整块为准，写在最后）。
		    ops.push({ op: 'set', path: ['models'], value: JSON.parse(rawModels) })
		  }

		  return { ops }
		}
		// —— client/ImagegenCard.js ——
		// m1_ImagegenCard.js —— 「设置 → imagegen」卡片。
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

		const __ns_0 = { IMAGEGEN_NS: m0_IMAGEGEN_NS, IMAGEGEN_FIELDS: m0_IMAGEGEN_FIELDS, BUILTIN_ENDPOINTS: m0_BUILTIN_ENDPOINTS, BUILTIN_MODELS: m0_BUILTIN_MODELS, BUILTIN_KEY_ENV: m0_BUILTIN_KEY_ENV, BUILTIN_CHANNELS: m0_BUILTIN_CHANNELS, MODEL_ID_SUFFIX: m0_MODEL_ID_SUFFIX, MODEL_LABEL_SUFFIX: m0_MODEL_LABEL_SUFFIX, emptyDrafts: m0_emptyDrafts, draftFromSnapshot: m0_draftFromSnapshot, isOverridden: m0_isOverridden, isConfigured: m0_isConfigured, envFallbackNames: m0_envFallbackNames, modelOf: m0_modelOf, modelAliasRows: m0_modelAliasRows, customProvidersText: m0_customProvidersText, customChannelNames: m0_customChannelNames, customProvidersProblem: m0_customProvidersProblem, modelsProblem: m0_modelsProblem, modelOverridePresent: m0_modelOverridePresent, buildSaveOps: m0_buildSaveOps };

		/** 卡片样式表。 */
		const m1_cardStyles = {
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
		const m1_FIELD_COPY = {
		  'apiKeys.doubao': { label: 'keyDoubao', hint: 'keyDoubaoHint' },
		  'apiKeys.qwen': { label: 'keyQwen', hint: 'keyQwenHint' },
		  'baseUrls.doubao': { label: 'urlDoubao', hint: 'urlDoubaoHint' },
		  'baseUrls.qwen': { label: 'urlQwen', hint: 'urlQwenHint' },
		}

		/** 自定义通道文本域的 DOM id。 */
		const m1_CUSTOM_FIELD_ID = 'imagegen-customProviders'
		/** models 明细文本域的 DOM id。 */
		const m1_MODELS_FIELD_ID = 'imagegen-models'

		/** 渲染生图 API 设置卡片。 */
		function m1_ImagegenCard(props) {
		  const { t } = props
		  // useImagegenCard 是渲染机制从注入面 hooks 绑定的选择器钩子（订阅已内置）。
		  const snapshot = props.useImagegenCard((value) => value)

		  const [drafts, setDrafts] = dep_useState(__ns_0.emptyDrafts)
		  const [modelsDraft, setModelsDraft] = dep_useState('')
		  const [busy, setBusy] = dep_useState(false)
		  const [result, setResult] = dep_useState('')
		  const [errorText, setErrorText] = dep_useState('')
		  const seeded = dep_useRef(undefined)

		  // 快照 revision 变化（首次就绪或别处写入）时重新播种：草稿归零、明细文本跟随刷新。
		  const revision = snapshot.revision
		  dep_useEffect(() => {
		    if (snapshot.status !== 'ready' || revision === undefined) return
		    if (seeded.current === revision) return
		    seeded.current = revision
		    setDrafts(__ns_0.emptyDrafts())
		    setModelsDraft('')
		    setResult('')
		    setErrorText('')
		    // eslint-disable-next-line react-hooks/exhaustive-deps
		  }, [snapshot.status, revision])

		  if (snapshot.status === 'loading') {
		    return dep_h('section', { style: m1_cardStyles.card },
		      dep_h('h3', { style: m1_cardStyles.title }, t('title')),
		      dep_h('p', { style: m1_cardStyles.hint }, t('loading')))
		  }

		  const editable = snapshot.status === 'ready' && snapshot.writable
		  const unavailable = snapshot.status === 'unavailable'
		  const currentModels = snapshot.value === undefined ? undefined : snapshot.value.models
		  const draftOf = (path) => drafts[path]
		  const setDraft = (path, text) => setDrafts((draft) => ({ ...draft, [path]: text }))

		  const stringField = (path) => {
		    const spec = __ns_0.IMAGEGEN_FIELDS.find((field) => field.path === path)
		    const copy = m1_FIELD_COPY[path]
		    const secret = spec.kind === 'secret'
		    const configured = secret && __ns_0.isConfigured(snapshot, path)
		    const overridden = __ns_0.isOverridden(snapshot, path)
		    const text = draftOf(path)
		    // secret 行永远渲染草稿文本（快照里是脱敏值，回显无意义）；普通字段在草稿为空时回显解析值。
		    const resolved = __ns_0.draftFromSnapshot(snapshot, path)
		    const shown = secret ? text : (text !== '' || resolved === '' ? text : resolved)
		    const badge = secret
		      ? dep_h('span', { style: { ...m1_cardStyles.badge, ...(configured ? m1_cardStyles.badgeOn : {}) } },
		        t(configured ? 'configured' : 'unconfigured'))
		      : (overridden ? dep_h('span', { style: { ...m1_cardStyles.badge, ...m1_cardStyles.badgeOn } }, 'override') : null)
		    return dep_h('div', { key: path, style: m1_cardStyles.field },
		      dep_h('div', { style: m1_cardStyles.fieldHead },
		        dep_h('label', { style: m1_cardStyles.label, htmlFor: `imagegen-${path}` }, t(copy.label)),
		        badge),
		      dep_h('input', {
		        id: `imagegen-${path}`,
		        style: m1_cardStyles.input,
		        type: secret ? 'password' : 'text',
		        autoComplete: secret ? 'off' : undefined,
		        spellCheck: false,
		        value: shown,
		        placeholder: secret ? t('keyPlaceholder') : (resolved || undefined),
		        disabled: !editable,
		        onChange: (event) => setDraft(path, event.target.value),
		      }),
		      dep_h('p', { style: m1_cardStyles.hint }, t(copy.hint)))
		  }

		  /** 一个通道的模型行：模型 id 可自由填写。 */
		  const modelField = (channel) => {
		    const configured = __ns_0.modelOf(currentModels, channel)
		    const text = draftOf(`models.${channel}`)
		    const fallback = __ns_0.BUILTIN_MODELS[channel]
		    const shown = text !== '' ? text : (configured?.id ?? '')
		    const isCustom = !__ns_0.BUILTIN_CHANNELS.includes(channel)
		    return dep_h('div', { key: `model-${channel}`, style: m1_cardStyles.field },
		      dep_h('div', { style: m1_cardStyles.fieldHead },
		        dep_h('label', { style: m1_cardStyles.label, htmlFor: `imagegen-model-${channel}` }, `${channel} ${t('modelLabel')}`),
		        isCustom ? dep_h('span', { style: m1_cardStyles.badge }, t('customBadge')) : null,
		        configured !== undefined
		          ? dep_h('span', { style: { ...m1_cardStyles.badge, ...m1_cardStyles.badgeOn } }, 'override')
		          : null),
		      dep_h('input', {
		        id: `imagegen-model-${channel}`,
		        style: m1_cardStyles.input,
		        type: 'text',
		        spellCheck: false,
		        value: shown,
		        placeholder: fallback ?? t('modelPlaceholder'),
		        disabled: !editable,
		        onChange: (event) => setDraft(`models.${channel}`, event.target.value),
		      }),
		      dep_h('p', { style: m1_cardStyles.hint },
		        `${t('modelHint')}${fallback === undefined ? '' : ` ${t('modelDefaultHint')}${fallback}`}`))
		  }

		  const aliases = __ns_0.modelAliasRows(currentModels)
		  const customNames = __ns_0.customChannelNames(snapshot)

		  const onSave = async () => {
		    const built = __ns_0.buildSaveOps(snapshot, { ...drafts, models: modelsDraft })
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
		      setDrafts(__ns_0.emptyDrafts())
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
		    setDrafts(__ns_0.emptyDrafts())
		    setModelsDraft('')
		    setResult('')
		    setErrorText('')
		  }

		  const customBad = __ns_0.customProvidersProblem(drafts.customProviders)
		  const modelsBad = __ns_0.customProvidersProblem(modelsDraft) && modelsDraft.trim() !== '' && modelsDraft.trim() !== '{}'
		  const customCurrent = __ns_0.customProvidersText(snapshot)
		  const customShown = drafts.customProviders !== '' ? drafts.customProviders : customCurrent

		  return dep_h('section', { style: m1_cardStyles.card },
		    dep_h('header', { style: m1_cardStyles.head },
		      dep_h('h3', { style: m1_cardStyles.title }, t('title')),
		      dep_h('p', { style: m1_cardStyles.description }, t('description'))),

		    unavailable ? dep_h('p', { style: m1_cardStyles.warn }, t('unavailable')) : null,

		    dep_h('div', { style: m1_cardStyles.group },
		      dep_h('h4', { style: m1_cardStyles.groupTitle }, t('modelsTitle')),
		      dep_h('p', { style: m1_cardStyles.hint }, t('modelsDescription')),
		      __ns_0.BUILTIN_CHANNELS.map((channel) => modelField(channel)),
		      customNames.map((channel) => modelField(channel)),
		      aliases.length > 0
		        ? dep_h('p', { style: m1_cardStyles.hint },
		          `${t('aliasesLabel')}${aliases.map((row) => `${row.channel}/${row.alias} → ${row.id}`).join('；')}`)
		        : null),

		    dep_h('div', { style: m1_cardStyles.divider }),

		    dep_h('div', { style: m1_cardStyles.group },
		      dep_h('h4', { style: m1_cardStyles.groupTitle }, t('builtinTitle')),
		      __ns_0.IMAGEGEN_FIELDS.map((field) => stringField(field.path))),

		    dep_h('div', { style: m1_cardStyles.divider }),

		    dep_h('div', { style: m1_cardStyles.group },
		      dep_h('h4', { style: m1_cardStyles.groupTitle }, t('customTitle')),
		      dep_h('textarea', {
		        id: m1_CUSTOM_FIELD_ID,
		        style: m1_cardStyles.textarea,
		        spellCheck: false,
		        value: customShown,
		        placeholder: t('customPlaceholder'),
		        disabled: !editable,
		        onChange: (event) => setDraft('customProviders', event.target.value),
		      }),
		      customBad
		        ? dep_h('p', { style: m1_cardStyles.warn }, t('customInvalid'))
		        : dep_h('div', { style: m1_cardStyles.fieldHead },
		          __ns_0.isOverridden(snapshot, 'customProviders')
		            ? dep_h('span', { style: { ...m1_cardStyles.badge, ...m1_cardStyles.badgeOn } }, 'override')
		            : null,
		          dep_h('p', { style: m1_cardStyles.hint }, t('customHint'))),
		      dep_h('p', { style: m1_cardStyles.hint },
		        `${t('envHint')}${__ns_0.BUILTIN_CHANNELS.map((channel) => `${channel}: ${__ns_0.BUILTIN_KEY_ENV[channel][0]}`).join('；')}`)),

		    dep_h('div', { style: m1_cardStyles.group },
		      dep_h('h4', { style: m1_cardStyles.groupTitle }, t('modelsJsonTitle')),
		      dep_h('textarea', {
		        id: m1_MODELS_FIELD_ID,
		        style: { ...m1_cardStyles.textarea, minHeight: 96 },
		        spellCheck: false,
		        value: modelsDraft,
		        placeholder: t('modelsJsonPlaceholder'),
		        disabled: !editable,
		        onChange: (event) => setModelsDraft(event.target.value),
		      }),
		      modelsBad
		        ? dep_h('p', { style: m1_cardStyles.warn }, t('modelsJsonInvalid'))
		        : dep_h('p', { style: m1_cardStyles.hint }, t('modelsJsonHint'))),

		    dep_h('div', { style: m1_cardStyles.actions },
		      result === 'ok' ? dep_h('span', { style: m1_cardStyles.status }, t('saved')) : null,
		      result === 'error' ? dep_h('span', { style: { ...m1_cardStyles.status, ...m1_cardStyles.warn } }, t('error') + errorText) : null,
		      dep_h('button', { type: 'button', style: m1_cardStyles.button, disabled: !editable || busy, onClick: onDiscard }, t('discard')),
		      dep_h('button', {
		        type: 'button',
		        style: { ...m1_cardStyles.button, ...m1_cardStyles.primary },
		        disabled: !editable || busy,
		        onClick: onSave,
		      }, busy ? t('saving') : t('save'))))
		}

		/** 供自检断言：卡片渲染引用的文案键必须都在字典里。 */
		const m1_CARD_COPY_KEYS = [
		  'title', 'description', 'loading', 'unavailable', 'modelsTitle', 'modelsDescription',
		  'modelLabel', 'modelHint', 'modelDefaultHint', 'modelPlaceholder', 'customBadge', 'aliasesLabel',
		  'builtinTitle', 'customTitle', 'customHint', 'customPlaceholder', 'customInvalid', 'envHint',
		  'modelsJsonTitle', 'modelsJsonHint', 'modelsJsonPlaceholder', 'modelsJsonInvalid',
		  'keyDoubao', 'keyDoubaoHint', 'keyQwen', 'keyQwenHint',
		  'urlDoubao', 'urlDoubaoHint', 'urlQwen', 'urlQwenHint',
		  'save', 'discard', 'saving', 'saved', 'error', 'conflict',
		  'configured', 'unconfigured', 'keyPlaceholder',
		]
		// —— client/imagegen-toolview.js ——
		// imagegen-toolview.js —— web 会话里 generate_image 调用/结果的专属行。
		//
		// 背景：会话里工具结果默认走通用行，image 内容块会被压成 JSON 文本；只有注册了
		// keyed toolview（槽 tool.call.toolview，key = 工具名）的工具才有自己的行。本行仿
		// ui-tool 的 read-image-row：从 settled 结果里提取 [text envelope, image...] 内容块
		// 的附件引用，用 owner 提供的会话授权 loadImage 拉 URL 内联展示。
		//
		// 不声明子槽（官方 tool.call.images 只能被一个入口声明，已被 read_image 占用）。
		// 纯 React + 内联样式，bundle 零外部依赖（除 react）。


		/**
		 * 从结果内容块里抽 [text…] 与带附件的 image 块（与 output.render 产出形状对应）。
		 * @param {unknown} content - 工具结果的 content 块数组。
		 * @returns {{ text: string, images: object[] }} 文本与图片引用。
		 */
		function m2_parseResult(content) {
		  const text = []
		  const images = []
		  if (!Array.isArray(content)) return { text: '', images }
		  for (const block of content) {
		    if (block === null || typeof block !== 'object') continue
		    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
		      text.push(block.text)
		    } else if (block.type === 'image' && block.attachment !== undefined && block.attachment !== null) {
		      images.push(block.attachment)
		    }
		  }
		  return { text: text.join('\n'), images }
		}

		/** 会话行样式表。 */
		const m2_viewStyles = {
		  card: {
		    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))',
		    borderRadius: 12,
		    padding: '12px 16px',
		    display: 'flex',
		    flexDirection: 'column',
		    gap: 10,
		    background: 'var(--dsw-alias-bg-module-plain, transparent)',
		    fontFamily: 'inherit',
		  },
		  head: { display: 'flex', flexDirection: 'column', gap: 4 },
		  title: { margin: 0, fontSize: 13.5, fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
		  meta: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
		  gallery: { display: 'flex', flexWrap: 'wrap', gap: 10 },
		  img: { maxWidth: 300, maxHeight: 400, borderRadius: 8, objectFit: 'contain', border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))' },
		  placeholder: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', margin: 0 },
		  error: { color: 'var(--dsw-alias-label-danger, #d03050)' },
		}

		/** 单张图：peek 同步命中直接显示，否则异步 loadImage 拉 URL。 */
		function m2_GalleryImage(props) {
		  const imageRef = props.imageRef
		  const loader = props.loader
		  const initial = typeof loader.peek === 'function' ? loader.peek(imageRef) : undefined
		  const [url, setUrl] = dep_useState(initial)
		  const [failed, setFailed] = dep_useState(false)

		  dep_useEffect(() => {
		    if (url !== undefined) return undefined
		    let stale = false
		    Promise.resolve(loader(imageRef)).then(
		      (next) => { if (!stale) setUrl(next) },
		      () => { if (!stale) setFailed(true) },
		    )
		    return () => { stale = true }
		    // eslint-disable-next-line react-hooks/exhaustive-deps
		  }, [imageRef.attachmentId])

		  if (failed) return dep_h('p', { style: m2_viewStyles.placeholder }, '图片加载失败（附件可能已过期）')
		  if (url === undefined) return dep_h('p', { style: m2_viewStyles.placeholder }, '图片加载中…')
		  return dep_h('img', {
		    src: url,
		    alt: imageRef.name ?? `generated ${imageRef.width ?? ''}x${imageRef.height ?? ''}`,
		    style: m2_viewStyles.img,
		  })
		}

		/**
		 * generate_image 会话行：运行中显示轻量摘要；settled 结果展开画廊 + 元信息；
		 * 错误与无图结果回退到文本。
		 * @param {object} props - keyed toolview 的 owner 运行时 share（toolName/block/loadImage…）。
		 * @returns {object} 会话行元素。
		 */
		function m2_GenerateImageToolview(props) {
		  const block = props.block
		  // RunningToolCall（无 kind）与 ToolResultNode（kind='tool-result'）的判别。
		  const settled = block?.kind === 'tool-result' ? block : undefined

		  if (settled === undefined) {
		    return dep_h('section', { style: m2_viewStyles.card },
		      dep_h('h4', { style: m2_viewStyles.title }, `🎨 ${props.toolName ?? 'generate_image'} · 生成中…`))
		  }

		  const loader = props.loadImage
		  const parsed = m2_parseResult(settled.content)
		  const failed = settled.isError === true

		  return dep_h('section', { style: m2_viewStyles.card },
		    dep_h('header', { style: m2_viewStyles.head },
		      dep_h('h4', { style: { ...m2_viewStyles.title, ...(failed ? m2_viewStyles.error : {}) } },
		        failed ? '🎨 generate_image 失败' : '🎨 生图完成'),
		      failed && settled.error !== undefined
		        ? dep_h('p', { style: m2_viewStyles.meta },
		          (settled.error.name ?? 'tool-error') + (settled.error.code === undefined ? '' : ` (${settled.error.code})`))
		        : null),
		    parsed.images.length > 0 && loader !== undefined
		      ? dep_h('div', { style: m2_viewStyles.gallery },
		        parsed.images.map((imageRef) => dep_h(m2_GalleryImage, {
		          key: imageRef.attachmentId,
		          imageRef: imageRef,
		          loader: loader,
		        })))
		      : null,
		    parsed.text !== '' ? dep_h('p', { style: m2_viewStyles.meta }, parsed.text) : null,
		    parsed.images.length === 0 && parsed.text === ''
		      ? dep_h('p', { style: m2_viewStyles.placeholder }, '（无结果内容）')
		      : null)
		}
		// —— client/locales.js ——
		// 设置卡片文案字典（m3_zh/m3_en），命名空间 settings.imagegen。

		const m3_zh = {
		  title: 'imagegen',
		  description: '内置豆包 Seedream 与阿里 qwen-image；每个通道用哪个模型由你自由填写，本地部署或中转站模型写进下面的“自定义通道”，保存后对下一次生图调用即时生效。',
		  loading: '正在读取配置…',
		  unavailable: '当前 profile 没有可写的 imagegen 配置节（entry id 不是 imagegen？）。请把它装成 id = imagegen 的 bundle，或用 cordis.patch.yml 直接配置。',

		  modelsTitle: '模型',
		  modelsDescription: '每个通道使用哪个模型：直接填模型 id 即可（内置通道填空前，用的是各家的默认快照 id）。',
		  modelLabel: '模型 id',
		  modelHint: '可自由填写任意模型 id；留空并保存 = 清除覆盖、回到默认。',
		  modelDefaultHint: '内置默认：',
		  modelPlaceholder: '模型 id',
		  customBadge: '自定义',
		  aliasesLabel: '已声明别名：',

		  builtinTitle: '内置通道',
		  customTitle: '自定义通道（customProviders）',
		  customHint: '一个 JSON 对象：{ "名字": { "baseUrl": "http://127.0.0.1:11434/v1", "model": "…", "apiKeyOptional": true } }。baseUrl 可写裸主机或完整 /images/generations 地址；本地免鉴权端点加 apiKeyOptional:true。',
		  customPlaceholder: '{\n  "local": {\n    "baseUrl": "http://127.0.0.1:11434/v1",\n    "model": "flux",\n    "apiKeyOptional": true,\n    "sendWatermark": false,\n    "size": "1024x1024"\n  }\n}',
		  customInvalid: '自定义通道不是合法 JSON 对象，未保存该字段。',
		  envHint: '也可用环境变量兜底：',

		  modelsJsonTitle: '模型明细（models，可选）',
		  modelsJsonHint: '高级写法：整块覆盖 models。键可以是 "doubao"（该通道默认模型），也可以是 "relay/gpt-image"（别名，工具入参 model 可用别名）。值是模型 id 字符串，或 { "id": "…", "label": "…" }。',
		  modelsJsonPlaceholder: '{\n  "doubao": "doubao-seedream-5-0-pro-260628",\n  "relay/gpt-image": { "id": "gpt-image-1", "label": "中转站 GPT-Image" }\n}',
		  modelsJsonInvalid: 'models 不是合法 JSON 对象（每个值应为字符串或 { id, label } 对象）。',

		  keyDoubao: '豆包 API Key',
		  keyDoubaoHint: '火山方舟控制台创建；留空并保存 = 不改动已存 key。也可用环境变量 ARK_API_KEY。',
		  keyQwen: 'qwen API Key（阿里百炼）',
		  keyQwenHint: '百炼/DashScope 控制台创建；留空并保存 = 不改动已存 key。也可用环境变量 DASHSCOPE_API_KEY。',
		  urlDoubao: '豆包 API 地址',
		  urlDoubaoHint: '默认 https://ark.cn-beijing.volces.com/api/v3/images/generations',
		  urlQwen: 'qwen API 地址',
		  urlQwenHint: '默认 https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations',

		  save: '保存',
		  discard: '放弃修改',
		  saving: '保存中…',
		  saved: '已保存',
		  error: '保存失败：',
		  conflict: '配置已被其它地方改动，请重读后再保存。',
		  configured: '已配置',
		  unconfigured: '未配置',
		  keyPlaceholder: 'sk-…（留空保持不变）',
		}

		const m3_en = {
		  title: 'imagegen',
		  description: 'Built-in Doubao Seedream and Alibaba qwen-image; the model of every channel is yours to fill in, and local deployments or gateway models go under "Custom providers" below. Changes apply to the next generation call.',
		  loading: 'Reading configuration…',
		  unavailable: 'This profile serves no writable imagegen configuration entry (is its entry id "imagegen"?). Install it as a bundle whose id is imagegen, or configure it in cordis.patch.yml.',

		  modelsTitle: 'Models',
		  modelsDescription: 'Which model each channel uses: type the model id directly (an empty built-in field keeps that vendor\u2019s default snapshot id).',
		  modelLabel: 'model id',
		  modelHint: 'Any model id is accepted; saving an empty field clears the override and restores the default.',
		  modelDefaultHint: 'Built-in default:',
		  modelPlaceholder: 'model id',
		  customBadge: 'custom',
		  aliasesLabel: 'Declared aliases: ',

		  builtinTitle: 'Built-in providers',
		  customTitle: 'Custom providers (customProviders)',
		  customHint: 'A JSON object: { "name": { "baseUrl": "http://127.0.0.1:11434/v1", "model": "…", "apiKeyOptional": true } }. baseUrl may be a bare host or a full /images/generations URL; keyless local endpoints need apiKeyOptional:true.',
		  customPlaceholder: '{\n  "local": {\n    "baseUrl": "http://127.0.0.1:11434/v1",\n    "model": "flux",\n    "apiKeyOptional": true,\n    "sendWatermark": false,\n    "size": "1024x1024"\n  }\n}',
		  customInvalid: 'Custom providers is not a valid JSON object; that field was not saved.',
		  envHint: 'Environment fallbacks: ',

		  modelsJsonTitle: 'Model details (models, optional)',
		  modelsJsonHint: 'Advanced form: replaces the whole models map. A key is either "doubao" (that channel\u2019s default model) or "relay/gpt-image" (an alias the tool\u2019s model argument accepts). A value is a model id string or { "id": "…", "label": "…" }.',
		  modelsJsonPlaceholder: '{\n  "doubao": "doubao-seedream-5-0-pro-260628",\n  "relay/gpt-image": { "id": "gpt-image-1", "label": "Gateway GPT-Image" }\n}',
		  modelsJsonInvalid: 'models is not a valid JSON object (each value must be a string or an { id, label } object).',

		  keyDoubao: 'Doubao API key',
		  keyDoubaoHint: 'Create in the Volcengine Ark console; saving an empty field keeps the stored key. Env fallback: ARK_API_KEY.',
		  keyQwen: 'qwen API key (Alibaba Bailian)',
		  keyQwenHint: 'Create in the Bailian/DashScope console; saving an empty field keeps the stored key. Env fallback: DASHSCOPE_API_KEY.',
		  urlDoubao: 'Doubao API endpoint',
		  urlDoubaoHint: 'Default https://ark.cn-beijing.volces.com/api/v3/images/generations',
		  urlQwen: 'qwen API endpoint',
		  urlQwenHint: 'Default https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations',

		  save: 'Save',
		  discard: 'Discard',
		  saving: 'Saving…',
		  saved: 'Saved',
		  error: 'Save failed: ',
		  conflict: 'The configuration changed elsewhere; reload and save again.',
		  configured: 'Configured',
		  unconfigured: 'Not configured',
		  keyPlaceholder: 'sk-… (leave blank to keep)',
		}
		// —— client/index.js ——
		// imagegen 浏览器半侧 —— 把 imagegen 配置页挂进「设置」侧栏（slot: settings.section，
		// id = imagegen），并给 generate_image 注册会话内的专属行（slot: tool.call.toolview）。
		//
		// 运行时只依赖平台已提供的服务（slots / locale / configForms）；不 import 任何其它
		// 插件的值，因此客户端 bundle 不产生跨插件值导入。
		//
		// 与上游 0.1.x 版本的差异：注入的服务从 settingsScope 换成 configForms —— 现行宿主
		// 把插件配置暴露为 ctx.configForms.get(entryId)（读快照 + 原子 mutate）。

		const __ns_1 = { ImagegenCard: m1_ImagegenCard, CARD_COPY_KEYS: m1_CARD_COPY_KEYS };
		const __ns_2 = { GenerateImageToolview: m2_GenerateImageToolview };
		const __ns_3 = { IMAGEGEN_NS: m0_IMAGEGEN_NS, IMAGEGEN_FIELDS: m0_IMAGEGEN_FIELDS, BUILTIN_ENDPOINTS: m0_BUILTIN_ENDPOINTS, BUILTIN_MODELS: m0_BUILTIN_MODELS, BUILTIN_KEY_ENV: m0_BUILTIN_KEY_ENV, BUILTIN_CHANNELS: m0_BUILTIN_CHANNELS, MODEL_ID_SUFFIX: m0_MODEL_ID_SUFFIX, MODEL_LABEL_SUFFIX: m0_MODEL_LABEL_SUFFIX, emptyDrafts: m0_emptyDrafts, draftFromSnapshot: m0_draftFromSnapshot, isOverridden: m0_isOverridden, isConfigured: m0_isConfigured, envFallbackNames: m0_envFallbackNames, modelOf: m0_modelOf, modelAliasRows: m0_modelAliasRows, customProvidersText: m0_customProvidersText, customChannelNames: m0_customChannelNames, customProvidersProblem: m0_customProvidersProblem, modelsProblem: m0_modelsProblem, modelOverridePresent: m0_modelOverridePresent, buildSaveOps: m0_buildSaveOps };
		const __ns_4 = { zh: m3_zh, en: m3_en };

		/** 本卡片文案字典的命名空间。 */
		const m4_COPY_NS = 'settings.imagegen'

		/** 文案字典（先在模块顶层取好，避免对象字面量里出现被内联改写的简写属性）。 */
		const m4_dictionaries = { zh: __ns_4.zh, en: __ns_4.en }

		/** 需要的客户端服务（cordis fiber inject）。常量名刻意避开 inject：源码里
		 *  `inject:` 是槽位注册的对象键，同名会让打包器的标识符重命名改坏键位。 */
		const m4_PLUGIN_INJECT = ['slots', 'locale', 'configForms']



		/**
		 * 挂载生图配置页与会话行。
		 * @param {object} ctx - 浏览器插件上下文。
		 */
		function m4_apply(ctx) {
		  // 一个 namespace 一份 ConfigForm：读写都走它自己的队列与 revision 栅。
		  const form = ctx.configForms.get(__ns_3.IMAGEGEN_NS)
		  const t = ctx.locale.bind(m4_COPY_NS)

		  ctx.effect(
		    () => ctx.locale.register(m4_COPY_NS, m4_dictionaries),
		    'imagegen: card m4_dictionaries',
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
		    id: __ns_3.IMAGEGEN_NS,
		    order: 60,
		    label: () => t('title'),
		    locale: m4_COPY_NS,
		    inject: face,
		  }, __ns_1.ImagegenCard))

		  // 会话展示：keyed toolview（key = 线工具名）。没有它，generate_image 的结果走
		  // 通用行，image 内容块只被压成 JSON 文本。
		  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
		    name: 'tool.call.toolview',
		    key: 'generate_image',
		    locale: m4_COPY_NS,
		  }, __ns_2.GenerateImageToolview))
		}

		/** 供自检断言：卡片保存路径能被独立复算出来。 */
		module.exports.inject = m4_PLUGIN_INJECT;
		module.exports.buildSaveOps = __ns_3.buildSaveOps;
		module.exports.apply = m4_apply;

		})();
		return module.exports;
	},
});
