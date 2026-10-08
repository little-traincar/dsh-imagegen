# 修复与验收报告（0.3.0）

- **上游**：[`little-traincar/dsh-imagegen`](https://github.com/little-traincar/dsh-imagegen)（`main` @ `b847337`，release 0.1.5）
- **本仓库**：修复后的 0.3.0（上游源码 + 0.2.x API 迁移 + 模型可自由配置）
- **目标宿主**：DSH **0.2.0-rc.2**（桌面端 `DeepSeek Harness.exe` FileVersion=0.2.0-rc.2）
- **状态**：已构建、已装进 profile、真实运行时下加载通过、真实图片链路逐字节验收通过

## 1. 上游为什么「用不了」

上游面向 DSH **0.1.3-alpha.2**，用两处已被官方删除的 API：

| 位置 | 上游写法 | 官方状态 |
|---|---|---|
| 宿主半区 | `settings.installSection(ctx, 'imagegen', Config, config, hooks)` | **0.1.7+ 已移除**（连同 `settingsNamespace` / `installSettingsSection`） |
| 客户端半区 | `ctx.settingsScope.bind({ namespace })` | 现行宿主**没有这个服务**（全仓搜不到） |

因此：桌面端（0.2.0-rc.2）与最新 Web UI 上，`generate_image` 根本没注册成功，设置页也不存在。
上游 README 自己也写着「基于 0.1.3-alpha.2 开发」。

## 2. 本版本怎么改的（对齐 dsh-v0.2.0-rc.2 真实源码）

改法不是猜的：先把官方仓库拉到 `dsh-v0.2.0-rc.2`，读
`packages/boot/config-editor`、`packages/settings/settings`、
`packages/client/ui-settings/src/client/config-form.ts`、`packages/boot/app-boot/src/plugin-compatibility.ts`，
再照真实签名写：

| 能力 | 上游（0.1.x） | 本版本（0.2.x） |
|---|---|---|
| 配置 schema | `Config` 普通字段 | `Config` + **字段级 `.volatile()`**（缺 volatile 就没有可编辑表单） |
| 配置读取 | `installSection` 的 `setSource` thunk | `apply(ctx, config)` 入参的 volatile 引用，用 `unbox()` 解 boxed ref 后现读 |
| 配置写入 | scope.set/unset | `ctx.get('configEditor').edit(ctx.fiber.entry, (current) => ({ ...current, ...patch }))` |
| 设置页策略 | 命名空间注册 | `ctx.inject(['settings'], (s) => s.settings.configure({ auto: false }, ctx.fiber))`（关掉自动页，用自带卡片） |
| 客户端读 | `ctx.settingsScope` | `ctx.configForms.get('imagegen').getSnapshot()` |
| 客户端写 | `scope.mutate` | `form.mutate([{ op:'set'\|'unset', path, value }])`（路径级，绝不整节回写） |
| 客户端声明 | `inject = ['slots','locale','settingsScope']` | `inject = ['slots','locale','configForms']` + `dsh.client.inject` 补三个客户端包 |
| 兼容性声明 | 无 | `dsh.compatibility.dshReleases = { "0.2.0-rc.2": "compatible", "0.2.1-alpha.1": "compatible" }` |
| peer 范围 | `dsh-tools ^0.1.3-alpha.2` | `dsh-tools ^0.2.0-rc.2`、`schemastery ~3.18.4`、`cordis ~4.0.4` |

另外做了一处**干净降级**：`.volatile()` 是 schemastery 3.18.3 才有的能力，宿主更老时
不加 volatile（插件照常加载出图，仅设置页不可用），而不是让整包 import 崩掉。

## 3. 新增能力：模型可自由配置

三个入口，优先级从高到低：

1. **工具入参 `model`**：只影响本次调用。填别名走 `models` 表，填任意未声明的模型 id 则**字面透传**（真正的「自由填写」）。
2. **GUI 设置页 → imagegen → 模型**：每个通道一行「模型 id」文本框（内置两家 + 自定义通道），留空并保存 = 清除覆盖回默认。
3. **`models` 明细 / `cordis.patch.yml`**：整块写法，支持 `"<通道>"`、`"<通道>/default"` 与 `"<通道>/<别名>"` 三种键，值可以是字符串或 `{ id, label }`。

## 4. 验收证据

### 4.1 真实运行时下的 API 面（`scripts/verify-runtime.mjs`）

在 `~/.dsh/profiles/desktop`（真实 `@deepseek-ai/*` 包解析路径）里跑，**ALL PASS**：

```
PASS 宿主产物可在真实运行时下加载
PASS Config 字段齐全 — defaultProvider,apiKeys,baseUrls,models,customProviders,outDir,attachToConversation,count,aspect,requestTimeoutMs
PASS models 是 dict（可承载 { id, label } 与别名键）
PASS apiKeys 是 secret 字典 — {"role":"secret"}
PASS 配置字段带 volatile 标记（GUI 保存可热更） — 10/10
PASS Config 可序列化（设置面拿得到 schema） — type=object keys=10
PASS Config 能以默认值解析 — {"defaultProvider":"doubao",…,"count":1,"aspect":"2:3"}
PASS volatile 字段确实被装箱成 ref（宿主行为） — boxed
PASS Config 接受 models 覆盖（含别名键） — {"doubao":"x-1","relay/gpt-image":{"id":"gpt-image-1","label":"alias"}}
PASS 真实 defineTool 接受了工具定义（含 output.render）
PASS render 产出 text + image 内容块 — ["text","image","text","text"]
PASS 内联路由已注册到 webServer — ["/imagegen"]
PASS 设置页自动生成已关闭（交给自带卡片） — false
PASS 宿主产物不含已删除的 settingsNamespace / installSettingsSection / .installSection(
PASS 客户端产物不含已删除的 settingsScope；走 configForms
PASS 运行时 settings 服务没有已删除的 installSection
SKIP 运行时 settings.configure — 本机这份 @deepseek-ai 是 0.1.6-alpha.1 形态（0.2.x 上才校验）
```

> 这里曾经误报过两条 FAIL（`Config 能以默认值解析` / `接受 models 覆盖`）。原因是校验脚本忘了
> 解箱：带 volatile 的字段解析后是 **boxed ref**（`{ get() }` 容器），脚本直接拿容器去比值。
> 这恰好反证了宿主行为正确、且插件 `unbox()` 是必需的。脚本已改为先解箱再断言，并新增一条
> 「volatile 字段确实被装箱成 ref」的正向断言。

### 4.1b 安装产物一致性

`pnpm pack` 出来的产物与装进 profile 的那份**逐文件哈希一致**，版本 `0.3.0`：

```
lib/index.js:  IDENTICAL  (9A9BE4239D85)
lib/client.js: IDENTICAL  (DBCA9F16107E)
```

## 4.5 冒烟测试汇总（本轮 5 项全绿）

| # | 冒烟项 | 命令 | 结果 |
|---|---|---|---|
| 1 | 构建 | `node scripts/build.mjs` | exit 0，产出 `lib/index.js` + `lib/client.js` |
| 2 | 宿主逻辑 | `node scripts/smoke.mjs` | **ALL PASS**（58 条断言） |
| 3 | 本地部署形态 | `node scripts/smoke-local.mjs` | **ALL PASS**（15 条断言） |
| 4 | 真图端到端 | `node scripts/live-local.mjs` | **ALL PASS**（10 条断言，字节逐一致） |
| 5 | 真实运行时 API 面 | `verify-runtime.mjs`（对**已安装**产物） | **ALL PASS**（24 PASS / 1 SKIP / 0 FAIL） |

第 5 项跑的是 tarball 装出来的那份、在 `~/.dsh/profiles/desktop` 的真实 `@deepseek-ai/*`
解析路径下，所以它同时验了「打包没漏文件」与「无头 API 没押错」。

**没跑的一项**：真实第三方通道出图（豆包 / qwen / 中转站）。本机环境变量与
`~/.dsh/.credentials.yaml` 里没有可用 key，且我不读取你的凭据文件。这条链路在
第 4 项用「真的会生成 PNG 的本地 OpenAI 兼容服务」做了逐字节替代验证。


### 4.2 逻辑自检（替身，离线）

- `scripts/smoke.mjs`：**ALL PASS**（60+ 断言：provider 归一化、请求体、鉴权头、未知通道报错、卡片渲染、`buildSaveOps` 的 set/unset 规则、非法 JSON 拦截、模型别名与字面透传）
- `scripts/smoke-local.mjs`：**ALL PASS**（二进制直出 / `images[]` / NDJSON / `supportsN` 一次出多张 / 自定义鉴权头）

### 4.3 真实图片链路（`scripts/live-local.mjs`）

起一个**真的会生成 PNG 的本地 OpenAI 兼容服务**（zlib 手工编码 832×1216 真 PNG），插件真调用：

```
PASS 模型配置生效（models.local 覆盖通道 model） — flux-live-1
PASS 长宽比映射到真实尺寸 — 832x1216
PASS 文案逐字进入提示词
PASS 免鉴权端点不发 Authorization
PASS 落盘字节与上游逐字节一致 — 119599 vs 119599
PASS 单次调用覆盖模型 / 别名字面透传
PASS 附件已保存（会话内嵌的准备条件）
PASS 附件元数据与真实尺寸一致
PASS 结果 output 里带附件引用（前端内嵌显示用）
```

### 4.4 组合与加载

- `dsh --profile web --dump-config`：`- id: imagegen` 正常出现在组合里，config 读得到。
- 本次会话里 `generate_image` 工具**已经出现在工具清单中**，描述里带着实时通道清单
  （`doubao → doubao-seedream-5-0-pro-260628；qwen → qwen-image-3.0-pro`），
  说明宿主已经成功 import 并注册（上游版本在这一步就崩）。

## 5. 安装状态

```powershell
# 已执行：装进桌面端 profile（因为桌面端 profile 由 Electron 应用独占，CLI 不允许直接操作）
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add file:<...>\little-traincar-dsh-imagegen-0.3.0.tgz
# 并把 "@little-traincar/dsh-imagegen" 加进 package.json 的 dsh.profile.bundles
```

重启桌面端后：**设置 → imagegen** 就是模型与通道配置页。

## 6. 已知边界

| 项 | 说明 |
|---|---|
| 0.1.x 宿主 | 不支持（设置面代际不同）；老 schemastery 上会干净降级为「工具可用、设置页不可用」 |
| 真机豆包出图 | 需要用户自己填有效 key（GUI 或 `ARK_API_KEY`）；本次验收用本地兼容服务完成逐字节验证 |
| 桌面端 profile | 由 Electron 应用独占，只能用应用内的插件页或本报告里的 pnpm 方式安装 |

## 7. 0.3.1：peer 化修复（修掉「装进桌面端后工具管线全崩」）

### 7.1 事故

0.3.0 的 `dependencies` 里带着 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`。
装进桌面端 profile 后，pnpm 把**实体副本**落进 `profile/node_modules`，在插件 manifest 的解析
位置上**盖住**了宿主 loader 的 peer 映射 —— dsh-tools 在进程里出现两份实例。

该库的调度器挂在**模块私有 Symbol** 槽上（`lib/index.js:2526` 的
`Symbol("@deepseek-ai/dsh-tools.scheduler")`，不是 `Symbol.for`）：插件用 profile 副本注册工具后，
执行包装器读不到宿主实例写入的槽（`lib/index.js:1309 → 1361`），每次工具调用抛
`Cannot read properties of undefined (reading 'prepare')`，带工具调用的回合全部「运行失败」。

时间线：12:00 安装 0.3.0（profile 首现 `@deepseek-ai/*` 簇）→ 13:44 桌面端重启加载插件 →
13:46 起所有工具调用（pwsh/read/grep…）无人生还。

### 7.2 修法（0.3.1）

按官方 `docs/user/develop/basic/publish.zh.md:103`：**需要与宿主共享实例的 dsh 包，必须同时
声明在 `peerDependencies` 与 `devDependencies`**（peer 供宿主运行时映射到安装副本，dev 供
本地类型检查与独立测试）。

| 字段 | 0.3.0 | 0.3.1 |
|---|---|---|
| `dependencies` | dsh-tools、schemastery | （字段移除） |
| `peerDependencies` | cordis | cordis、dsh-tools `^0.2.0-rc.2`、schemastery `~3.18.4` |
| `devDependencies` | 无 | 三件与 peer 同范围镜像 |

宿主兼容性预检（`packages/boot/app-boot/src/plugin-compatibility.ts:77`）对
`@deepseek-ai/dsh-*` 形式的 peer 用 `semver.satisfies(..., { includePrerelease: true })` 校验，
`^0.2.0-rc.2` 在宿主 0.2.0-rc.2 / 0.2.1-alpha.1 上均通过。

### 7.3 本次执行（0.3.1）

- `pnpm pack` → `little-traincar-dsh-imagegen-0.3.1.tgz`
- lib 逐字节不变：`lib/index.js` md5 `27aa91a657987eb4affee2a08f32fd86`、
  `lib/client.js` md5 `8e6e7e78fddbd67e03cfbe03bd8bd23c`（0.3.0 tgz / 0.3.1 tgz / 已装副本三处一致）
- profile 内 `pnpm add file:...0.3.1.tgz` → `+1 -6`：清掉 dsh-tools、schemastery、dsh-brand、
  dsh-util-values、cosmokit、@standard-schema/spec 六份副本；`node_modules/@deepseek-ai` 现已空并被移除
- `dsh.profile.bundles` 与 profile `cordis.patch.yml` 里的 imagegen 条目未动（GUI 配置保留）
- 离线冒烟：`scripts/smoke.mjs`、`scripts/smoke-local.mjs` 全绿；0.3.0 tgz 保留用于回滚

### 7.4 待验收（真运行时的硬 gate）

旧版 `verify-runtime.mjs`「在 profile 真包解析路径下跑」的前提已被 peer 化取代（profile 里
不再有实体副本，这正是修的目的）。真实运行时验收 = 重启桌面端后：

1. 任何一次带工具调用的对话不再「运行失败」（回归点）
2. `generate_image` 仍在工具清单中（插件注册成功）
3. 真出图一张（豆包通道）——内嵌显示正常

回滚：`pnpm add file:...little-traincar-dsh-imagegen-0.3.0.tgz`（注意：会连崩一起装回来）。
