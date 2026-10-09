# dsh-imagegen

[English](README.md) | [简体中文](README.zh.md)

DeepSeek Harness 的生图插件。注册 `generate_image` 工具，让 agent 能生成图片并直接内嵌显示在对话里。

## 功能

- **对话内嵌显示** —— 生成的图片作为会话附件直接显示在对话里（另附同源 `/imagegen/<文件名>` 链接作为兜底）。
- **模型可自由配置** —— 每个通道用哪个模型由你在设置页自己填，支持别名与单次调用覆盖。
- **通道开放式** —— 内置豆包 Seedream 与阿里 qwen，另外任何 OpenAI 风格的 `/images/generations` 服务都能接：中转站、聚合网关、本地部署（Ollama / vLLM / SD-WebUI / ComfyUI）。
- **无水印** —— 默认发送 `watermark: false`；给不认这个字段的模型留了开关。
- **图内文案逐字呈现** —— 你给的文字按字嵌入，不会被改写。
- **图生图** —— 传参考图（URL、本地绝对路径或 data URI）并描述要改成什么样。
- **落盘保存** —— 每张图在返回前先写入 `outDir`。
- **一次出多张** —— 声明了 `supportsN` 的通道可以用一个请求产出多张候选。
- **部分失败不丢图** —— 多张里有失败的，成功的照常保留，失败原因逐条列出。
- **要求 DSH 0.2.x**（0.2.0-rc.2 / 0.2.1-alpha.1）。

## 安装

### 桌面端

先启动一次 Desktop 让它建好 profile，然后**完全退出应用**，再执行：

```powershell
dsh plugin --profile desktop add @little-traincar/dsh-imagegen
```

重新打开 Desktop 即可加载。

![Alt text](1-1.png)

### Web 端

```powershell
dsh plugin --profile web add @little-traincar/dsh-imagegen
```

重启 web profile 即可加载。

### 从 GitHub 安装（指定 tag）

```powershell
dsh plugin --profile desktop add github:little-traincar/dsh-imagegen#v0.3.1
```

### 从本地目录或 tarball 安装

```powershell
dsh plugin --profile desktop add ./
dsh plugin --profile desktop add ./little-traincar-dsh-imagegen-0.3.1.tgz
```

## 配置

打开 **设置 → imagegen**，给要用的通道填上 API key，保存即可。配置写在 profile 的 `cordis.patch.yml` 里，下一次生图调用就生效，不用重启。

### 内置通道

| 通道 | 默认模型 | API key |
|---|---|---|
| `doubao` | `doubao-seedream-5-0-pro-260628` | 火山方舟控制台，或环境变量 `ARK_API_KEY` |
| `qwen` | `qwen-image-3.0-pro` | 阿里百炼 / DashScope 控制台，或环境变量 `DASHSCOPE_API_KEY` |
| 自定义 | 你自己填 | 见下面的「自定义通道」 |

### 自定义通道

任何 OpenAI 风格的 `POST <baseUrl>/images/generations` 都能用。在设置页的**自定义通道**里声明：

```json
{
  "local": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "x/flux2-klein",
    "apiKeyOptional": true,
    "sendWatermark": false,
    "sendPromptExtend": false,
    "size": "1024x1024"
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | 必填 | 裸主机自动补 `/v1/images/generations`；以 `/v1` 结尾补 `/images/generations` |
| `model` | 必填 | 该通道的兜底模型 id |
| `apiKey` / `apiKeyEnv` | 空 | 直填 key，或从环境变量读（兜底 `IMAGE_API_KEY` / `OPENAI_API_KEY`） |
| `apiKeyOptional` | false | 免鉴权端点（本地部署）必须显式打开 |
| `authHeader` / `authScheme` | `authorization` / `Bearer ` | 鉴权头名与前缀 |
| `size` / `sizes` | 1024x1024 档 | `size` 固定尺寸；`sizes` 按长宽比分档 |
| `sizeSeparator` | `x` | 尺寸分隔符（阿里系用 `*`） |
| `supportsN` / `maxN` | false / 4 | 一次请求出多张 |
| `sendWatermark` | true | 模型不认 `watermark` 就设 false |
| `sendN` / `sendSeed` / `sendNegativePrompt` | true | 逐个关掉模型不支持的参数 |
| `sendPromptExtend` | false | 设为 true 会发 `prompt_extend:false` |
| `imageField` | `image` | 参考图字段名；设 `false` 表示该通道不支持图生图 |
| `responseFormat` | `b64_json` | 或 `url` |
| `extraBody` | 空 | 追加供应商私有字段 |

### 模型

每个通道用哪个模型都可以改，三个入口：

1. **设置 → imagegen → 模型** —— 每个通道一行「模型 id」。留空并保存 = 清除覆盖、回到内置默认。这一行写的是规范的 `models.<通道>` 键，保存后立刻对下一次生图生效。
2. **模型明细**（或直接写 `cordis.patch.yml`）—— 整块写法，可带别名：

```json
{
  "doubao": "doubao-seedream-5-0-pro-260628",
  "qwen": "qwen-image-3.0-pro",
  "relay/gpt-image": { "id": "gpt-image-1", "label": "中转站 GPT-Image" }
}
```

键是 `<通道>`（该通道的默认模型）或 `<通道>/<别名>`。别名可以在调用时直接写：

```
generate_image(prompt="…", provider="relay", model="gpt-image")
```

默认模型也可以写成 `<通道>/default`（与 `<通道>` 等价）。`<通道>/model` 与 `<通道>/label` 是 0.3.1 设置页写下过的历史键，读取时仍兼容，但保存设置页时会自动迁移成 `<通道>`；内置通道不再把这两个后缀当别名暴露。

其他 `model` 值一律按字面当作模型 id 透传。调用结果里会回显实际使用的 `provider` 与 `model`。

## 使用

在对话里直接提需求即可，例如：「画一张夏日咖啡店促销海报：复古杂志拼贴风格，奶油黄配咖啡棕，竖版；主标题『夏日冰咖节』，副标题『全场第二杯半价』」。

agent 会调用 `generate_image`，图片内嵌显示在回复里。每张图同时落盘到 `outDir`（默认：dsh 启动目录下的 `generated-images`）。

## 卸载

### 桌面端

先完全退出应用，再执行：

```powershell
dsh plugin --profile desktop remove @little-traincar/dsh-imagegen
```

### Web 端

```powershell
dsh plugin --profile web remove @little-traincar/dsh-imagegen
```

命令会把 bundle 从 profile 里摘掉并卸载包；重启 profile 后彻底卸载完成。`outDir` 里已生成的图片、以及 profile `cordis.patch.yml` 里的 `imagegen` 配置段会保留——想一起清掉需要你自己删。

## License

MIT
