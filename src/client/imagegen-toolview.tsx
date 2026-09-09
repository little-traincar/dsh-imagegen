/**
 * GenerateImageToolview.tsx —— web 会话里 generate_image 调用/结果的专属行。
 *
 * 背景：会话里工具结果默认走通用行，image 内容块会被压成 JSON 文本，
 * 只有注册了 keyed toolview（槽 tool.call.toolview，key = 工具名）的工具
 * 才有自己的行。本行仿 ui-tool 的 read-image-row：settled 结果里提取
 * [text envelope, image...] 内容块的附件引用，用 owner 提供的会话授权
 * loadImage 拉 URL 内联展示。
 *
 * 不声明子槽（官方 tool.call.images 只能被一个入口声明，已被 read_image
 * 占用；画廊内联在行内，绕开附件槽位约定——loadImage 已是授权 loader）。
 * 纯 React + 内联样式，bundle 零外部依赖（除 react）。
 */

import { useEffect, useState } from 'react'

// —— 线格式的最小结构类型（运行时只做窄化，不跨插件取值） ——

interface WireImageRef {
  attachmentId: string
  mediaType: string
  bytes?: number
  width?: number
  height?: number
  name?: string
}

interface WireImageBlock { type: 'image'; attachment?: WireImageRef }
interface WireTextBlock { type: 'text'; text?: string }

type WireBlock = WireImageBlock | WireTextBlock | { type: string }

interface WireLoader {
  (attachment: WireImageRef): Promise<string>
  peek?: (attachment: WireImageRef) => string | undefined
}

interface WireResultNode {
  kind: 'tool-result'
  content?: readonly WireBlock[]
  isError?: boolean
  error?: { name?: string; code?: string }
}

interface ParsedResult {
  text: string
  images: readonly WireImageRef[]
}

/** 从结果内容块里抽 [text…] 与带附件的 image 块（与 output.render 产出形状对应）。 */
function parseResult(content: readonly WireBlock[] | undefined): ParsedResult {
  const text: string[] = []
  const images: WireImageRef[] = []
  for (const block of content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      text.push(block.text)
    } else if (block.type === 'image' && block.attachment !== undefined) {
      images.push(block.attachment)
    }
  }
  return { text: text.join('\n'), images }
}

const style = {
  card: {
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))',
    borderRadius: 12,
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    background: 'var(--dsw-alias-bg-module-plain, transparent)',
    fontFamily: 'inherit',
  },
  head: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
  title: { margin: 0, fontSize: 13.5, fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
  meta: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const },
  gallery: { display: 'flex', flexWrap: 'wrap' as const, gap: 10 },
  img: { maxWidth: 300, maxHeight: 400, borderRadius: 8, objectFit: 'contain' as const, border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))' },
  placeholder: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', margin: 0 },
  error: { color: 'var(--dsw-alias-label-danger, #d03050)' },
} as const

/** 单张图：peek 同步命中直接显示，否则异步 loadImage 拉 URL。 */
function GalleryImage({ ref, loader }: { ref: WireImageRef; loader: WireLoader }) {
  const initial = loader.peek?.(ref)
  const [url, setUrl] = useState<string | undefined>(initial)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (url !== undefined) return
    let stale = false
    loader(ref).then(
      (next) => { if (!stale) setUrl(next) },
      () => { if (!stale) setFailed(true) },
    )
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.attachmentId])

  if (failed) return <p style={style.placeholder}>图片加载失败（attachmentId 已过期？）</p>
  if (url === undefined) return <p style={style.placeholder}>图片加载中…</p>
  return (
    <img
      src={url}
      alt={ref.name ?? `generated ${ref.width ?? ''}x${ref.height ?? ''}`}
      style={style.img}
    />
  )
}

/**
 * generate_image 会话行：运行中显示轻量摘要；settled 结果展开
 * 画廊 + 元信息；错误与无图结果回退到文本。
 * @param props - keyed toolview 的 owner 运行时 share（callId/toolName/block/loadImage…）。
 */
export function GenerateImageToolview(props: {
  toolName: string
  block: unknown
  loadImage: unknown
}): JSX.Element {
  const block = props.block
  // RunningToolCall（无 kind）与 ToolResultNode（kind='tool-result'）的判别。
  const settled = (block as WireResultNode | null | undefined)?.kind === 'tool-result'
    ? block as WireResultNode
    : undefined

  if (settled === undefined) {
    return (
      <section style={style.card}>
        <h4 style={style.title}>🎨 {props.toolName} · 生成中…</h4>
      </section>
    )
  }

  const loader = props.loadImage as WireLoader | undefined
  const parsed = parseResult(settled.content)
  const failed = settled.isError === true

  return (
    <section style={style.card}>
      <header style={style.head}>
        <h4 style={{ ...style.title, ...(failed ? style.error : {}) }}>
          {failed ? '🎨 generate_image 失败' : '🎨 生图完成'}
        </h4>
        {failed && settled.error !== undefined ? (
          <p style={style.meta}>{settled.error.name ?? 'tool-error'}{settled.error.code === undefined ? '' : ` (${settled.error.code})`}</p>
        ) : null}
      </header>
      {parsed.images.length > 0 && loader !== undefined ? (
        <div style={style.gallery}>
          {parsed.images.map((ref) => (
            <GalleryImage key={ref.attachmentId} ref={ref} loader={loader} />
          ))}
        </div>
      ) : null}
      {parsed.text !== '' ? <p style={style.meta}>{parsed.text}</p> : null}
      {parsed.images.length === 0 && parsed.text === '' ? (
        <p style={style.placeholder}>（无结果内容）</p>
      ) : null}
    </section>
  )
}
