# dsh-imagegen —— DSH 生图插件

给 DeepSeek Harness 的 agent 注册 `generate_image` 工具：豆包 Seedream 5.0 Pro（默认，视觉强）/ qwen-image-3.0-pro（文字更稳）。**无水印、文案逐字、多张候选、图片落盘 + 会话内联显示**，凭据在 GUI 设置页填写。

## 安装（用户视角）

```powershell
# npm
dsh plugin --profile <名字> add dsh-imagegen

# GitHub 直装（拉源码，依赖本包的 prepare 构建脚本）
dsh plugin --profile <名字> add github:你的用户名/dsh-imagegen#<commit-sha>

# tarball
dsh plugin --profile <名字> add ./dsh-imagegen-0.1.0.tgz
```

GitHub 安装首次会被 pnpm 拦截构建授权：按 `dsh` 提示把包键加进该 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-imagegen: true
```

（源码 checkout 用户也可以：`pnpm dsh web --patch <仓库>/imagegen/cordis.yml`）

## 使用

1. 重启 GUI → 设置 → **imagegen** → 填豆包/qwen key → 保存（即时生效；也可用环境变量 `ARK_API_KEY` / `DASHSCOPE_API_KEY`）。
2. 会话里说需求（风格/配色说全出图更稳）：

> 画一张夏日咖啡店促销海报：复古杂志拼贴风，奶油黄+咖啡棕，竖版；文字：主标题「夏日冰咖节」副标「全场第二杯半价」；出 2 张。

图片内嵌显示在对话里，并存档到 `outDir`（默认 `<启动目录>/generated-images`，可在设置或 patch 里改）。

## 配置（优先级：GUI 设置 > cordis.patch.yml > 环境变量）

| 项 | 默认 | 说明 |
|---|---|---|
| `apiKeys.*` | 空 | 豆包 / qwen key；环境变量 `ARK_API_KEY` / `DASHSCOPE_API_KEY` |
| `baseUrls.*` | 官方 | 可指向任意 OpenAI 风格 `/images/generations` 兼容网关 |
| `models.*` | 快照 ID | 豆包别名会 404，勿改回 `doubao-seedream-5-0-pro` |
| `outDir` | 启动目录下 `generated-images` | 落盘目录（绝对路径） |
| `count` / `aspect` / `attachToConversation` / `requestTimeoutMs` | 2 / 2:3 / true / 300000 | 出图习惯 |

## 密钥安全

- API key 只存 DSH 设置文档（`$DSH_HOME/settings.yaml`），**仓库不含任何凭据**；字段为 `role('secret')`，界面永不回显。
- 若 key 曾在会话日志中出现过（例如调试时读取设置文件），公开仓库前到服务商控制台**轮换一次**。
- 水印：请求显式 `watermark: false`；若服务商因合规强制标识，以其规则为准。

## 开发

- `npm install && npm run build` → 产出 `lib/index.js`（Host）+ `lib/client.js`（浏览器 bundle）。
- 依赖版本与目标 dsh 版本配套（alpha 生态）；若安装报“版本不存在”，把 `package.json` 依赖版本对齐到你的 dsh 版本。
- 冒烟：在 checkout 根目录运行 `node --import tsx <工作区>/imagegen-smoke.mjs`。

## 结构

| 文件 | 作用 |
|---|---|
| `src/index.ts` | Host：工具契约 + 入参校验 + 内联路由 + 设置命名空间 |
| `src/providers.ts` | 两家 HTTP 适配：重试/退避、字节签名嗅探、`watermark: false` |
| `src/client/*` | 设置页（imagegen 分区）+ `generate_image` 会话行（画廊展示） |
| `cordis.patch.yml` | 组合包 patch（安装时自动应用） |
| `scripts/build.mjs` → `lib/` | 发布构建（含 `prepare`，供 GitHub 直装） |

## 开发状态

本项目由 AI 辅助开发（vibe coding）完成，已通过本地冒烟测试与真实 API 调用验证（豆包真机出图、水印关闭、附件入库、会话内嵌均实测通过）；发现异常欢迎提 issue 或 PR。
