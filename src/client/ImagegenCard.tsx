/**
 * ImagegenCard.tsx —— “设置 → 生图 API（imagegen）”卡片。
 *
 * 独立外观（不导入其它插件的卡片组件，遵守客户端 bundle 纯净度门禁）：
 * 用 scope 快照播种草稿，保存时把四个字段的变更一次写回（非空 set、
 * 空串+曾覆盖 unset）。样式全部内联，无 CSS 管道。
 *
 * 注入面契约（scoped-slots bindInjectSources）：面里 hooks 分栏的每个成员
 * 由渲染机制绑定成 use<Name> 选择器钩子（内部 uSES），其它成员原样透传为
 * props —— 组件以钩子方式读快照，动作直接以 props.save / props.discard 消费。
 */

import { useEffect, useRef, useState } from 'react'
import type { ImagegenCardCopy } from './locales.ts'
import {
  draftFromSnapshot,
  emptyDrafts,
  IMAGEGEN_FIELDS,
  isConfigured,
  isOverridden,
  type ImagegenCardFace,
  type ImagegenDrafts,
  type ImagegenFieldPath,
  type ImagegenSnapshot,
} from './imagegen-card-controller.ts'

/** 渲染机制绑定的 use<Name> 选择器钩子形态（快照源 → 选择器钩子）。 */
export type ImagegenSnapshotHook = <Selected>(
  selector: (snapshot: ImagegenSnapshot) => Selected,
  equal?: (left: Selected, right: Selected) => boolean,
) => Selected

export interface ImagegenCardProps {
  /** 渲染器注入的文案（settings.imagegen 字典）。 */
  t: (key: keyof ImagegenCardCopy) => string
  /** 注入面 hooks 分栏绑定成的选择器钩子（读取 scope 快照）。 */
  useImagegenCard: ImagegenSnapshotHook
  /** 注入面平铺成员（原样透传）：保存与放弃动作。 */
  save: ImagegenCardFace['save']
  discard: ImagegenCardFace['discard']
}

const style = {
  card: {
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))',
    borderRadius: 12,
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    background: 'var(--dsw-alias-bg-module-plain, transparent)',
  },
  head: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
  title: { color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 15, fontWeight: 600, margin: 0 },
  description: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12.5, margin: 0 },
  field: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
  fieldHead: { display: 'flex', alignItems: 'center', gap: 8 },
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
    boxSizing: 'border-box' as const,
    width: '100%',
    font: 'inherit',
    fontSize: 13,
    padding: '7px 10px',
    borderRadius: 8,
    border: '0.5px solid var(--dsw-alias-border-input, rgba(128,128,128,.45))',
    background: 'var(--dsw-alias-bg-input, transparent)',
    color: 'var(--dsw-alias-label-primary, inherit)',
  },
  hint: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12, margin: 0 },
  actions: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
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
  status: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', alignSelf: 'center' },
} as const

/** 一个字段编辑行的文案键集合（字段顺序即渲染顺序）。 */
const FIELD_COPY: Record<ImagegenFieldPath, { label: keyof ImagegenCardCopy; hint: keyof ImagegenCardCopy }> = {
  'apiKeys.doubao': { label: 'keyDoubao', hint: 'keyDoubaoHint' },
  'apiKeys.qwen': { label: 'keyQwen', hint: 'keyQwenHint' },
  'baseUrls.doubao': { label: 'urlDoubao', hint: 'urlDoubaoHint' },
  'baseUrls.qwen': { label: 'urlQwen', hint: 'urlQwenHint' },
}

/**
 * 渲染生图 API 设置卡片。
 * @param props - 文案、快照面与保存动作。
 * @returns 设置卡片。
 */
export function ImagegenCard(props: ImagegenCardProps): JSX.Element {
  const { t } = props
  // useImagegenCard 是渲染机制从 scope 快照源绑定的选择器钩子（订阅已内置）。
  const snapshot = props.useImagegenCard((value) => value)

  const [drafts, setDrafts] = useState<ImagegenDrafts>(emptyDrafts)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<'' | 'ok' | 'error' | 'offline'>('')
  const seeded = useRef<number | undefined>(undefined)

  // 快照每次就绪（或 revision 变化）时重新播种草稿——除非用户正在编辑。
  const revision = snapshot.revision
  useEffect(() => {
    if (snapshot.status !== 'ready' || revision === undefined) return
    if (seeded.current === revision) return
    seeded.current = revision
    setDrafts(emptyDrafts())
    setResult('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.status, revision, snapshot.value])

  if (snapshot.status === 'loading') {
    return <section style={style.card}>{t('title')}</section>
  }

  const editable = snapshot.status === 'ready' && snapshot.writable
  const fieldValue = (path: ImagegenFieldPath): string => draftFromSnapshot(snapshot, path)

  const field = (path: ImagegenFieldPath) => {
    const spec = IMAGEGEN_FIELDS.find((f) => f.path === path)!
    const copy = FIELD_COPY[path]
    const secret = spec.kind === 'secret'
    const configured = secret && isConfigured(snapshot, path)
    const overridden = isOverridden(snapshot, path)
    const text = drafts[path]
    // secret 行永远渲染草稿文本（快照里即使有 key 也是 redacted 后的空值，
    // 回显无意义）：受控 value 必须跟随输入，否则字符打不进去。
    // 普通字段在草稿为空时回显解析值供预览。
    const shown = secret ? text : (text !== '' || fieldValue(path) === '' ? text : fieldValue(path))
    return (
      <div key={path} style={style.field}>
        <div style={style.fieldHead}>
          <label style={style.label} htmlFor={`imagegen-${path}`}>{t(copy.label)}</label>
          {secret
            ? <span style={{ ...style.badge, ...(configured ? style.badgeOn : {}) }}>
              {t(configured ? 'configured' : 'unconfigured')}
            </span>
            : overridden ? <span style={{ ...style.badge, ...style.badgeOn }}>override</span> : null}
        </div>
        <input
          id={`imagegen-${path}`}
          style={style.input}
          type={secret ? 'password' : 'text'}
          autoComplete={secret ? 'off' : undefined}
          spellCheck={false}
          value={shown}
          placeholder={secret ? t('keyPlaceholder') : fieldValue(path) || undefined}
          disabled={!editable}
          onChange={(event) => setDrafts((d) => ({ ...d, [path]: event.target.value }))}
        />
        <p style={style.hint}>{t(copy.hint)}</p>
      </div>
    )
  }

  const onSave = async () => {
    setBusy(true)
    setResult('')
    try {
      await props.save(drafts)
      setResult('ok')
      setDrafts(emptyDrafts())
    } catch {
      setResult('error')
    } finally {
      setBusy(false)
    }
  }

  const onDiscard = () => {
    props.discard()
    seeded.current = undefined
    setDrafts(emptyDrafts())
    setResult('')
  }

  return (
    <section style={style.card}>
      <header style={style.head}>
        <h3 style={style.title}>{t('title')}</h3>
        <p style={style.description}>{t('description')}</p>
      </header>
      {IMAGEGEN_FIELDS.map((f) => field(f.path))}
      <div style={style.actions}>
        {result === 'ok' ? <span style={style.status}>{t('saved')}</span> : null}
        {result === 'error' ? <span style={style.status}>{t('error')}</span> : null}
        <button type="button" style={style.button} disabled={!editable || busy} onClick={onDiscard}>
          {t('discard')}
        </button>
        <button type="button" style={{ ...style.button, ...style.primary }} disabled={!editable || busy} onClick={onSave}>
          {busy ? t('saving') : t('save')}
        </button>
      </div>
    </section>
  )
}
