// imagegen-toolview.js —— web 会话里 generate_image 调用/结果的专属行。
//
// 背景：会话里工具结果默认走通用行，image 内容块会被压成 JSON 文本；只有注册了
// keyed toolview（槽 tool.call.toolview，key = 工具名）的工具才有自己的行。本行仿
// ui-tool 的 read-image-row：从 settled 结果里提取 [text envelope, image...] 内容块
// 的附件引用，用 owner 提供的会话授权 loadImage 拉 URL 内联展示。
//
// 不声明子槽（官方 tool.call.images 只能被一个入口声明，已被 read_image 占用）。
// 纯 React + 内联样式，bundle 零外部依赖（除 react）。

import { createElement as h, useEffect, useState } from 'react'

/**
 * 从结果内容块里抽 [text…] 与带附件的 image 块（与 output.render 产出形状对应）。
 * @param {unknown} content - 工具结果的 content 块数组。
 * @returns {{ text: string, images: object[] }} 文本与图片引用。
 */
function parseResult(content) {
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
const viewStyles = {
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
function GalleryImage(props) {
  const imageRef = props.imageRef
  const loader = props.loader
  const initial = typeof loader.peek === 'function' ? loader.peek(imageRef) : undefined
  const [url, setUrl] = useState(initial)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (url !== undefined) return undefined
    let stale = false
    Promise.resolve(loader(imageRef)).then(
      (next) => { if (!stale) setUrl(next) },
      () => { if (!stale) setFailed(true) },
    )
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageRef.attachmentId])

  if (failed) return h('p', { style: viewStyles.placeholder }, '图片加载失败（附件可能已过期）')
  if (url === undefined) return h('p', { style: viewStyles.placeholder }, '图片加载中…')
  return h('img', {
    src: url,
    alt: imageRef.name ?? `generated ${imageRef.width ?? ''}x${imageRef.height ?? ''}`,
    style: viewStyles.img,
  })
}

/**
 * generate_image 会话行：运行中显示轻量摘要；settled 结果展开画廊 + 元信息；
 * 错误与无图结果回退到文本。
 * @param {object} props - keyed toolview 的 owner 运行时 share（toolName/block/loadImage…）。
 * @returns {object} 会话行元素。
 */
export function GenerateImageToolview(props) {
  const block = props.block
  // RunningToolCall（无 kind）与 ToolResultNode（kind='tool-result'）的判别。
  const settled = block?.kind === 'tool-result' ? block : undefined

  if (settled === undefined) {
    return h('section', { style: viewStyles.card },
      h('h4', { style: viewStyles.title }, `🎨 ${props.toolName ?? 'generate_image'} · 生成中…`))
  }

  const loader = props.loadImage
  const parsed = parseResult(settled.content)
  const failed = settled.isError === true

  return h('section', { style: viewStyles.card },
    h('header', { style: viewStyles.head },
      h('h4', { style: { ...viewStyles.title, ...(failed ? viewStyles.error : {}) } },
        failed ? '🎨 generate_image 失败' : '🎨 生图完成'),
      failed && settled.error !== undefined
        ? h('p', { style: viewStyles.meta },
          (settled.error.name ?? 'tool-error') + (settled.error.code === undefined ? '' : ` (${settled.error.code})`))
        : null),
    parsed.images.length > 0 && loader !== undefined
      ? h('div', { style: viewStyles.gallery },
        parsed.images.map((imageRef) => h(GalleryImage, {
          key: imageRef.attachmentId,
          imageRef: imageRef,
          loader: loader,
        })))
      : null,
    parsed.text !== '' ? h('p', { style: viewStyles.meta }, parsed.text) : null,
    parsed.images.length === 0 && parsed.text === ''
      ? h('p', { style: viewStyles.placeholder }, '（无结果内容）')
      : null)
}
