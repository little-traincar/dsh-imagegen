// src/index.ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/providers.ts
var DEFAULT_ENDPOINTS = {
  doubao: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations"
};
var DEFAULT_SIZES = {
  doubao: {
    "1:1": "2048x2048",
    "2:3": "1152x2048",
    "3:4": "1536x2048",
    "9:16": "1080x1920",
    "16:9": "1920x1080"
  },
  qwen: {
    "1:1": "2048*2048",
    "2:3": "1152*2048",
    "3:4": "1536*2048",
    "9:16": "1080*1920",
    "16:9": "1920*1080"
  }
};
var MAX_ATTEMPTS = 3;
var RETRY_BASE_MS = 400;
var RETRYABLE_STATUS = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var MAX_ERROR_TEXT = 400;
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    if (signal?.aborted) {
      abort();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    void timer;
  });
}
async function fetchWithRetry(url, init, signal) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (error) {
      const cancelled = signal?.aborted || error instanceof Error && error.name === "AbortError";
      if (cancelled || attempt >= MAX_ATTEMPTS) throw error;
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), signal);
      continue;
    }
    if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt >= MAX_ATTEMPTS) {
      return response;
    }
    await response.arrayBuffer().catch(() => {
    });
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), signal);
  }
}
function sniffImageType(data) {
  if (data.byteLength >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  return "image/png";
}
async function decodeImageResponse(response, label, signal) {
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, MAX_ERROR_TEXT);
    throw new Error(`[imagegen] ${label} \u8BF7\u6C42\u5931\u8D25 (HTTP ${response.status}): ${detail}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`[imagegen] ${label} \u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON`);
  }
  const item = payload.data?.[0];
  if (item?.b64_json) {
    const data = new Uint8Array(Buffer.from(item.b64_json.trim(), "base64"));
    if (data.byteLength === 0) throw new Error(`[imagegen] ${label} \u8FD4\u56DE\u4E86\u7A7A\u7684\u56FE\u7247\u6570\u636E`);
    return { data, mediaType: sniffImageType(data) };
  }
  if (item?.url) {
    const download = await fetchWithRetry(item.url, { method: "GET" }, signal);
    if (!download.ok) throw new Error(`[imagegen] \u56FE\u7247\u4E0B\u8F7D\u5931\u8D25 (HTTP ${download.status})`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error("[imagegen] \u4E0B\u8F7D\u5230\u7A7A\u7684\u56FE\u7247\u6570\u636E");
    return { data: bytes, mediaType: sniffImageType(bytes) };
  }
  throw new Error(`[imagegen] ${label} \u54CD\u5E94\u91CC\u6CA1\u6709\u56FE\u7247\u6570\u636E: ${JSON.stringify(payload).slice(0, 300)}`);
}
async function doubaoGenerateImage(options) {
  const response = await fetchWithRetry(options.endpoint ?? DEFAULT_ENDPOINTS.doubao, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`
    },
    body: JSON.stringify({
      model: options.model,
      prompt: options.prompt,
      size: options.size,
      response_format: "b64_json",
      watermark: false
      // 硬性要求：不加水印
    })
  }, options.signal);
  return decodeImageResponse(response, `\u8C46\u5305 ${options.model}`, options.signal);
}
async function qwenGenerateImage(options) {
  const body = {
    model: options.model,
    prompt: options.prompt,
    size: options.size,
    n: 1,
    response_format: "b64_json",
    watermark: false,
    // 默认即 false，显式声明防回归
    prompt_extend: false
    // 禁止平台改写提示词，保证文字逐字呈现
  };
  if (options.seed !== void 0) body.seed = options.seed;
  if (options.negativePrompt !== void 0) body.negative_prompt = options.negativePrompt;
  const response = await fetchWithRetry(options.endpoint ?? DEFAULT_ENDPOINTS.qwen, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`
    },
    body: JSON.stringify(body)
  }, options.signal);
  return decodeImageResponse(response, `qwen ${options.model}`, options.signal);
}
function apiKeyFromEnv(provider) {
  if (provider === "doubao") {
    return process.env.ARK_API_KEY ?? process.env.VOLCENGINE_API_KEY;
  }
  return process.env.DASHSCOPE_API_KEY ?? process.env.ALIYUN_API_KEY;
}
function resolveApiKey(provider, configured) {
  const value = configured?.trim() || apiKeyFromEnv(provider)?.trim();
  if (!value) {
    const providerName = provider === "doubao" ? "\u8C46\u5305" : "qwen";
    const envName = provider === "doubao" ? "ARK_API_KEY" : "DASHSCOPE_API_KEY";
    throw new Error(`[imagegen] \u672A\u914D\u7F6E ${providerName} \u7684 API key\uFF08\u8BBE\u7F6E\u9875\u586B\u5199\uFF0C\u6216\u73AF\u5883\u53D8\u91CF ${envName}\uFF09`);
  }
  return value;
}

// src/index.ts
var name = "imagegen";
var inject = ["tools"];
var IMAGEGEN_SETTINGS_NS = "imagegen";
var LIMITS = {
  prompt: 4e3,
  textLines: 20,
  textLineLen: 200,
  minCount: 1,
  maxCount: 4,
  seedMin: 0,
  seedMax: 2147483647
};
var Config = Schema.object({
  defaultProvider: Schema.union(["doubao", "qwen"]).default("doubao"),
  apiKeys: Schema.object({
    // role('secret')：值不出现在任何响应里，卡片只显示“已配置/未配置”。
    doubao: Schema.string().role("secret"),
    qwen: Schema.string().role("secret")
  }).default({}),
  baseUrls: Schema.object({
    doubao: Schema.string(),
    qwen: Schema.string()
  }).default({}),
  models: Schema.object({
    doubao: Schema.string(),
    qwen: Schema.string()
  }).default({}),
  outDir: Schema.string().default(""),
  attachToConversation: Schema.boolean().default(true),
  count: Schema.number().default(2),
  aspect: Schema.union(["1:1", "2:3", "3:4", "9:16", "16:9"]).default("2:3"),
  requestTimeoutMs: Schema.number().default(3e5)
});
var DEFAULT_MODELS = {
  // 别名会 404；快照 ID 实测可用。
  doubao: "doubao-seedream-5-0-pro-260628",
  qwen: "qwen-image-3.0-pro"
};
var NEGATIVE_PROMPT = "\u4F4E\u5206\u8FA8\u7387\u3001\u6A21\u7CCA\u3001\u7578\u53D8\u3001\u80A2\u4F53\u9519\u8BEF\u3001\u591A\u4F59\u624B\u6307\u3001\u6587\u5B57\u4E71\u7801\u6216\u9519\u5B57\u3001\u6C34\u5370\u3001\u91CD\u590D\u5143\u7D20\u3001\u4F4E\u8D28\u91CF";
var QUALITY_SUFFIX = "\n\u753B\u9762\u8981\u6C42\uFF1A\u4E13\u4E1A\u7EA7\u5546\u4E1A\u8BBE\u8BA1\uFF0C\u6784\u56FE\u5B8C\u6574\u3001\u5149\u5F71\u81EA\u7136\u3001\u7EC6\u8282\u7CBE\u81F4\u3001\u8272\u5F69\u534F\u8C03\uFF1B\u98CE\u683C\u4E0E\u4E3B\u8272\u8C03\u4EE5\u7528\u6237\u6307\u5B9A\u4E3A\u51C6\u3002";
var INLINE_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};
function buildPrompt(description, textLines) {
  const parts = [description];
  if (textLines !== void 0 && textLines.length > 0) {
    const verbatim = textLines.map((line) => `\u300C${line}\u300D`).join("");
    parts.push(
      `\u56FE\u5185\u9700\u8981\u51FA\u73B0\u7684\u6587\u5B57\uFF08\u5FC5\u987B\u9010\u5B57\u7CBE\u786E\u6E32\u67D3\uFF0C\u987A\u5E8F\u3001\u6807\u70B9\u3001\u6362\u884C\u4E00\u81F4\uFF0C\u4E25\u7981\u589E\u5220\u6539\u5B57\u6216\u7528\u540C\u4E49\u66FF\u6362\uFF09\uFF1A${verbatim}`
    );
  }
  return parts.join("\n") + QUALITY_SUFFIX;
}
function validateRequest(args, outDir) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (prompt.length === 0) throw new Error("generate_image: prompt \u4E0D\u80FD\u4E3A\u7A7A");
  if (prompt.length > LIMITS.prompt) throw new Error(`generate_image: prompt \u8FC7\u957F\uFF08\u4E0A\u9650 ${LIMITS.prompt} \u5B57\u7B26\uFF09`);
  if (args.text_lines !== void 0) {
    if (!Array.isArray(args.text_lines) || args.text_lines.some((l) => typeof l !== "string")) {
      throw new Error("generate_image: text_lines \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
    }
    if (args.text_lines.length > LIMITS.textLines) throw new Error(`generate_image: text_lines \u6700\u591A ${LIMITS.textLines} \u884C`);
    for (const line of args.text_lines) {
      if (line.length > LIMITS.textLineLen) throw new Error(`generate_image: \u5355\u884C\u6587\u5B57\u8D85\u8FC7 ${LIMITS.textLineLen} \u5B57\u7B26\uFF08\u9010\u5B57\u6E32\u67D3\u6210\u529F\u7387\u4E0B\u964D\uFF0C\u8BF7\u7CBE\u7B80\uFF09`);
    }
  }
  const count = args.count;
  if (count !== void 0 && (!Number.isInteger(count) || count < LIMITS.minCount || count > LIMITS.maxCount)) {
    throw new Error(`generate_image: count \u5FC5\u987B\u662F ${LIMITS.minCount}\u2013${LIMITS.maxCount} \u7684\u6574\u6570`);
  }
  if (args.seed !== void 0 && (!Number.isInteger(args.seed) || args.seed < LIMITS.seedMin || args.seed > LIMITS.seedMax)) {
    throw new Error(`generate_image: seed \u5FC5\u987B\u5728 ${LIMITS.seedMin}\u2013${LIMITS.seedMax} \u4E4B\u95F4\uFF08\u4EC5 qwen \u751F\u6548\uFF09`);
  }
  if (outDir.length === 0) throw new Error("generate_image: \u672A\u914D\u7F6E\u843D\u76D8\u76EE\u5F55\uFF08cordis.yml \u7684 config.outDir\uFF09");
  if (!isAbsolute(outDir)) throw new Error(`generate_image: outDir \u5FC5\u987B\u662F\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u5F53\u524D\u4E3A ${outDir}`);
  return { count: count ?? 2, seed: args.seed };
}
var IMAGE_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    attached: { type: "boolean", required: true },
    image: {
      type: "object",
      additionalProperties: false,
      properties: {
        attachmentId: { type: "string", required: true },
        mediaType: { type: "string", enum: ["image/png", "image/jpeg"], required: true },
        bytes: { type: "integer", required: true },
        width: { type: "integer", required: true },
        height: { type: "integer", required: true },
        name: { type: "string" }
      }
    },
    note: { type: "string" }
  }
};
var OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider: { type: "string", required: true },
    model: { type: "string", required: true },
    aspect: { type: "string", required: true },
    size: { type: "string", required: true },
    prompt: { type: "string", required: true },
    images: { type: "array", required: true, items: IMAGE_ITEM_SCHEMA },
    // 部分失败的逐条说明；全部失败时工具直接抛错（isError），此字段为 []。
    failures: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "integer", required: true },
          message: { type: "string", required: true }
        }
      }
    }
  }
};
function apply(ctx, config) {
  let current = () => config;
  const providerModel = (provider) => current().models?.[provider]?.trim() || DEFAULT_MODELS[provider];
  const providerApiKey = (provider) => resolveApiKey(provider, current().apiKeys?.[provider]);
  const providerEndpoint = (provider) => current().baseUrls?.[provider]?.trim() || DEFAULT_ENDPOINTS[provider];
  let inlineBaseUrl;
  ctx.inject(["webServer"], (webCtx) => {
    const web = webCtx.get("webServer");
    if (web === void 0) return;
    webCtx.effect(() => {
      inlineBaseUrl = process.env.DSH_WEB_URL?.replace(/\/+$/u, "") ?? `http://127.0.0.1:${web.port}`;
      const dispose = web.register({
        kind: "prefix",
        path: "/imagegen",
        handler: (req, res) => {
          try {
            if (req.method !== "GET" && req.method !== "HEAD") {
              res.writeHead(405);
              res.end();
              return;
            }
            const pathname = new URL(req.url ?? "/", "http://x").pathname;
            if (!pathname.startsWith("/imagegen/")) {
              res.writeHead(404);
              res.end("not found");
              return;
            }
            const name2 = decodeURIComponent(pathname.slice("/imagegen/".length));
            if (!/^[\w.-]+\.(?:jpg|jpeg|png|webp)$/iu.test(name2)) {
              res.writeHead(404);
              res.end("not found");
              return;
            }
            const file = join(current().outDir, name2);
            void readFile(file).then((data) => {
              res.writeHead(200, {
                "content-type": INLINE_MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
                "content-length": String(data.byteLength),
                "cache-control": "no-store",
                "x-content-type-options": "nosniff"
              });
              if (req.method === "HEAD") res.end();
              else res.end(data);
            }, () => {
              res.writeHead(404);
              res.end("not found");
            });
          } catch {
            res.writeHead(400);
            res.end("bad request");
          }
        }
      });
      return () => {
        dispose();
        inlineBaseUrl = void 0;
      };
    }, "imagegen: inline image route");
  });
  ctx.inject(["attachments"], (imageCtx) => {
    imageCtx.tools.register(defineTool({
      name: "generate_image",
      description: "Generate one or more high-quality images (default: Doubao Seedream 5.0 Pro; can switch to qwen-image-3.0-pro for denser, more accurate text). Calling rules: (1) if the user has not specified the visual style, palette/atmosphere, composition, or the exact wording to place in the image, ask the user first, then call this tool; (2) render in-image text verbatim from the user, never add, drop, or reword characters; (3) always state an explicit art style and palette in the description to avoid the model\u2019s default plain light-color look; (4) default aspect is portrait 2:3 (poster); pass aspect for other ratios; (5) pass count > 1 to produce candidates to choose from; (6) the result contains ready-to-use Markdown image links \u2014 embed them verbatim in your reply so the images display inline in the conversation.",
      parameters: {
        prompt: { type: "string", required: true, description: "\u5B8C\u6574\u753B\u9762\u63CF\u8FF0\uFF08\u4E2D\u6587\u5373\u53EF\uFF09\uFF1A\u4E3B\u4F53\u5185\u5BB9\u3001\u6784\u56FE\u3001\u98CE\u683C\u3001\u4E3B\u8272\u8C03/\u6C1B\u56F4\u3002\u5FC5\u987B\u5305\u542B\u660E\u786E\u7684\u98CE\u683C\u4E0E\u914D\u8272\u63CF\u8FF0\u3002" },
        provider: { type: "string", enum: ["doubao", "qwen"], description: "\u670D\u52A1\u5546\uFF1Adoubao\uFF08\u9ED8\u8BA4\uFF0C\u89C6\u89C9\u4F18\u5148\uFF09\u6216 qwen\uFF08\u6587\u5B57\u66F4\u51C6\uFF09\u3002\u4E0D\u586B\u7528\u914D\u7F6E\u9ED8\u8BA4\u3002" },
        aspect: { type: "string", enum: ["1:1", "2:3", "3:4", "9:16", "16:9"], description: "\u957F\u5BBD\u6BD4\uFF0C\u9ED8\u8BA4 2:3\uFF08\u7AD6\u7248\u6D77\u62A5\uFF09\u3002" },
        count: { type: "integer", description: "\u751F\u6210\u51E0\u5F20\u5019\u9009\uFF081\u20134\uFF09\uFF0C\u9ED8\u8BA4\u53D6\u914D\u7F6E\u503C 2\u3002" },
        text_lines: { type: "array", items: { type: "string" }, description: "\u5FC5\u987B\u539F\u6837\u51FA\u73B0\u5728\u56FE\u5185\u7684\u6587\u5B57\u884C\uFF08\u9010\u5B57\u5448\u73B0\uFF0C\u4E0D\u5F97\u589E\u5220\u6539\uFF09\u3002\u6CA1\u6709\u5219\u4E3A\u7A7A\u3002" },
        seed: { type: "integer", description: "\u968F\u673A\u79CD\u5B50\uFF08\u4EC5 qwen \u751F\u6548\uFF09\uFF1A\u56FA\u5B9A\u540E\u53EF\u590D\u73B0\u76F8\u8FD1\u6784\u56FE\uFF0C\u7528\u4E8E\u5FAE\u8C03\u8FED\u4EE3\u3002" }
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => {
          const blocks = [];
          for (const item of value.images) {
            const meta = item.image;
            let envelope = `<path>${item.path}</path>
<type>image</type>
<content>
`;
            envelope += `${value.provider} \xB7 ${value.model} \xB7 ${value.aspect} (${value.size})
`;
            envelope += meta !== void 0 ? `${meta.mediaType} image, ${meta.width}x${meta.height} px, ${meta.bytes} bytes` : item.note ?? "file saved (not attached to the conversation)";
            envelope += "</content>";
            blocks.push({ type: "text", text: envelope });
            if (meta !== void 0) {
              blocks.push({
                type: "image",
                attachment: {
                  attachmentId: meta.attachmentId,
                  mediaType: meta.mediaType,
                  bytes: meta.bytes,
                  width: meta.width,
                  height: meta.height,
                  ...meta.name === void 0 ? {} : { name: meta.name }
                }
              });
            }
          }
          const failures = Array.isArray(value.failures) ? value.failures : [];
          for (const failure of failures) {
            blocks.push({ type: "text", text: `\u26A0 \u7B2C ${failure.index} \u5F20\u751F\u6210\u5931\u8D25\uFF1A${failure.message}` });
          }
          if (inlineBaseUrl !== void 0 && value.images.length > 0) {
            const links = value.images.map((item) => `![${basename(item.path)}](${inlineBaseUrl}/imagegen/${encodeURIComponent(basename(item.path))})`);
            blocks.push({
              type: "text",
              text: "\n\u4F1A\u8BDD\u5185\u8054\u94FE\u63A5\uFF08\u8BF7\u5728\u4F60\u7684\u56DE\u590D\u4E2D\u4F7F\u7528\u4E0B\u9762\u7684 Markdown \u56FE\u7247\u8BED\u6CD5\u3001\u9010\u6761\u539F\u6837\u5185\u5D4C\uFF0C\u56FE\u7247\u4F1A\u76F4\u63A5\u663E\u793A\u5728\u5BF9\u8BDD\u91CC\uFF09\uFF1A\n" + links.join("\n")
            });
          }
          return blocks;
        },
        presentationMeta: (_args, value) => ({
          provider: value.provider,
          paths: value.images.map((item) => item.path),
          failures: (Array.isArray(value.failures) ? value.failures : []).map((f) => ({ index: f.index, message: f.message }))
        })
      },
      async execute(args, exec) {
        const cfg = current();
        const validated = validateRequest(args, cfg.outDir);
        const provider = args.provider ?? cfg.defaultProvider;
        const aspect = args.aspect ?? cfg.aspect;
        const requestedCount = validated.count;
        const model = providerModel(provider);
        const apiKey = providerApiKey(provider);
        const endpoint = providerEndpoint(provider);
        const size = DEFAULT_SIZES[provider][aspect];
        const prompt = buildPrompt(args.prompt.trim(), args.text_lines);
        const outDir = cfg.outDir;
        const signal = AbortSignal.any([
          exec.signal ?? new AbortController().signal,
          AbortSignal.timeout(cfg.requestTimeoutMs)
        ]);
        await mkdir(outDir, { recursive: true });
        const generateOne = async (index) => {
          const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const suffix = `${stamp}-${index + 1}-${randomUUID().slice(0, 4)}`;
          const image = provider === "doubao" ? await doubaoGenerateImage({ apiKey, model, prompt, size, endpoint, signal }) : await qwenGenerateImage({
            apiKey,
            model,
            prompt,
            size,
            endpoint,
            seed: validated.seed === void 0 ? void 0 : validated.seed + index,
            negativePrompt: NEGATIVE_PROMPT,
            signal
          });
          const name2 = `${suffix}${image.mediaType === "image/jpeg" ? ".jpg" : ".png"}`;
          const path = join(outDir, name2);
          await writeFile(path, image.data);
          if (cfg.attachToConversation) {
            const attachments = imageCtx.get("attachments");
            if (attachments !== void 0) {
              try {
                const ref = await attachments.saveImage({ data: image.data, mediaType: image.mediaType, name: name2 });
                return {
                  path,
                  attached: true,
                  image: {
                    attachmentId: ref.attachmentId,
                    mediaType: ref.mediaType,
                    bytes: ref.bytes,
                    width: ref.width,
                    height: ref.height,
                    ...ref.name === void 0 ? {} : { name: ref.name }
                  }
                };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { path, attached: false, note: `\u4F1A\u8BDD\u9644\u4EF6\u5931\u8D25\uFF08\u5DF2\u4FDD\u7559\u6587\u4EF6\uFF09: ${message.slice(0, 200)}` };
              }
            }
            return { path, attached: false, note: "\u5F53\u524D\u73AF\u5883\u672A\u6302\u8F7D\u9644\u4EF6\u670D\u52A1\uFF0C\u4EC5\u843D\u76D8" };
          }
          return { path, attached: false, note: "\u914D\u7F6E\u5173\u95ED\u4E86\u4F1A\u8BDD\u9644\u52A0\uFF0C\u4EC5\u843D\u76D8" };
        };
        const settled = await Promise.allSettled(Array.from({ length: requestedCount }, (_, i) => generateOne(i)));
        const images = [];
        const failures = [];
        settled.forEach((result, i) => {
          if (result.status === "fulfilled") {
            images.push(result.value);
          } else {
            const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
            failures.push({ index: i + 1, message: message.slice(0, 300) });
          }
        });
        if (images.length === 0) {
          throw new Error(`generate_image: \u5168\u90E8 ${requestedCount} \u5F20\u751F\u6210\u5931\u8D25 \u2014 ${failures.map((f) => `#${f.index}: ${f.message}`).join("\uFF1B")}`);
        }
        return { provider, model, aspect, size, prompt, images, failures };
      }
    }));
  });
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, IMAGEGEN_SETTINGS_NS, Config, config, {
      validate: () => {
      },
      // 契约：setSource 收到的是读取权威值的 thunk；工具每次调用现读。
      setSource: (source) => {
        current = source;
      },
      onChange: () => {
      }
    });
  });
}
export {
  Config,
  IMAGEGEN_SETTINGS_NS,
  apply,
  inject,
  name
};
