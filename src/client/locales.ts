/** 设置卡片文案字典（zh/en），命名空间 settings.imagegen。 */

export interface ImagegenCardCopy {
  title: string
  description: string
  keyDoubao: string
  keyDoubaoHint: string
  keyQwen: string
  keyQwenHint: string
  urlDoubao: string
  urlDoubaoHint: string
  urlQwen: string
  urlQwenHint: string
  save: string
  discard: string
  saving: string
  saved: string
  error: string
  configured: string
  unconfigured: string
  keyPlaceholder: string
}

export const zh: ImagegenCardCopy = {
  title: 'imagegen',
  description: '豆包 Seedream 5.0 Pro 与阿里 qwen-image-3.0-pro 的接入凭据。留空的服务使用官方默认地址；保存后对下一次生图调用即时生效。',
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
  configured: '已配置',
  unconfigured: '未配置',
  keyPlaceholder: 'sk-…（留空保持不变）',
}

export const en: ImagegenCardCopy = {
  title: 'imagegen',
  description: 'Credentials for Doubao Seedream 5.0 Pro and Alibaba qwen-image-3.0-pro. Blank endpoints use the official defaults; changes apply to the next generation call.',
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
  configured: 'Configured',
  unconfigured: 'Not configured',
  keyPlaceholder: 'sk-… (leave blank to keep)',
}
