window.__ModuleLoader__.load({
	id: "dsh-imagegen",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/ImagegenCard.tsx
var import_react = require("react");

// src/client/imagegen-card-controller.ts
var IMAGEGEN_NS = "imagegen";
var IMAGEGEN_FIELDS = [
  { path: "apiKeys.doubao", kind: "secret" },
  { path: "apiKeys.qwen", kind: "secret" },
  { path: "baseUrls.doubao", kind: "url" },
  { path: "baseUrls.qwen", kind: "url" }
];
function emptyDrafts() {
  return { "apiKeys.doubao": "", "apiKeys.qwen": "", "baseUrls.doubao": "", "baseUrls.qwen": "" };
}
function draftFromSnapshot(snapshot, path) {
  const value = pathValue(snapshot.value, path);
  return typeof value === "string" ? value : "";
}
function isOverridden(snapshot, path) {
  return pathValue(snapshot.user, path) !== void 0;
}
function isConfigured(snapshot, path) {
  return hasNonEmpty(snapshot.base, path) || hasNonEmpty(snapshot.user, path) || hasNonEmpty(snapshot.value, path);
}
function hasNonEmpty(root, path) {
  const value = pathValue(root, path);
  return typeof value === "string" && value.trim() !== "";
}
function pathValue(root, path) {
  let node = root;
  for (const key of path.split(".")) {
    if (typeof node !== "object" || node === null) return void 0;
    node = node[key];
  }
  return node;
}
var ImagegenCardController = class {
  constructor(scope) {
    __publicField(this, "scope", scope);
    __publicField(this, "getSnapshot", () => this.scope.getSnapshot());
    __publicField(this, "subscribe", (listener) => this.scope.subscribe(listener));
  }
  /**
   * 卡片槽位注册时注入的面。注入面契约（scoped-slots bindInjectSources）：
   * `hooks` / `keyedHooks` 是仅有的两个保留分栏（成员绑定成 use<Name> 钩子），
   * 其余成员（这里的 save / discard）必须平铺在面上，原样透传成组件 props。
   */
  face() {
    return {
      hooks: { imagegenCard: { getSnapshot: this.getSnapshot, subscribe: this.subscribe } },
      save: async (drafts) => {
        const snapshot = this.scope.getSnapshot();
        for (const field of IMAGEGEN_FIELDS) {
          const draft = drafts[field.path].trim();
          const segments = field.path.split(".");
          if (draft !== "") {
            await this.scope.mutate([{ op: "set", path: segments, value: draft }]);
          } else if (isOverridden(snapshot, field.path)) {
            await this.scope.mutate([{ op: "unset", path: segments }]);
          }
        }
      },
      discard: () => {
      }
    };
  }
};

// src/client/ImagegenCard.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var style = {
  card: {
    border: "0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))",
    borderRadius: 12,
    padding: "16px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
    background: "var(--dsw-alias-bg-module-plain, transparent)"
  },
  head: { display: "flex", flexDirection: "column", gap: 4 },
  title: { color: "var(--dsw-alias-label-primary, inherit)", fontSize: 15, fontWeight: 600, margin: 0 },
  description: { color: "var(--dsw-alias-label-tertiary, #888)", fontSize: 12.5, margin: 0 },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  fieldHead: { display: "flex", alignItems: "center", gap: 8 },
  label: { color: "var(--dsw-alias-label-secondary, inherit)", fontSize: 13, fontWeight: 500 },
  badge: {
    fontSize: 11,
    padding: "1px 8px",
    borderRadius: 999,
    border: "0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))",
    color: "var(--dsw-alias-label-tertiary, #999)"
  },
  badgeOn: { background: "var(--dsw-alias-bg-module-hover, rgba(128,128,128,.12))" },
  input: {
    boxSizing: "border-box",
    width: "100%",
    font: "inherit",
    fontSize: 13,
    padding: "7px 10px",
    borderRadius: 8,
    border: "0.5px solid var(--dsw-alias-border-input, rgba(128,128,128,.45))",
    background: "var(--dsw-alias-bg-input, transparent)",
    color: "var(--dsw-alias-label-primary, inherit)"
  },
  hint: { color: "var(--dsw-alias-label-tertiary, #888)", fontSize: 12, margin: 0 },
  actions: { display: "flex", gap: 8, justifyContent: "flex-end" },
  button: {
    font: "inherit",
    fontSize: 13,
    padding: "6px 14px",
    borderRadius: 8,
    cursor: "pointer",
    border: "0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.45))",
    background: "var(--dsw-alias-bg-module-hover, rgba(128,128,128,.1))",
    color: "var(--dsw-alias-label-primary, inherit)"
  },
  primary: {
    border: "0",
    background: "var(--dsw-alias-interactive-bg-primary, #2456e6)",
    color: "#fff"
  },
  status: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", alignSelf: "center" }
};
var FIELD_COPY = {
  "apiKeys.doubao": { label: "keyDoubao", hint: "keyDoubaoHint" },
  "apiKeys.qwen": { label: "keyQwen", hint: "keyQwenHint" },
  "baseUrls.doubao": { label: "urlDoubao", hint: "urlDoubaoHint" },
  "baseUrls.qwen": { label: "urlQwen", hint: "urlQwenHint" }
};
function ImagegenCard(props) {
  const { t } = props;
  const snapshot = props.useImagegenCard((value) => value);
  const [drafts, setDrafts] = (0, import_react.useState)(emptyDrafts);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [result, setResult] = (0, import_react.useState)("");
  const seeded = (0, import_react.useRef)(void 0);
  const revision = snapshot.revision;
  (0, import_react.useEffect)(() => {
    if (snapshot.status !== "ready" || revision === void 0) return;
    if (seeded.current === revision) return;
    seeded.current = revision;
    setDrafts(emptyDrafts());
    setResult("");
  }, [snapshot.status, revision, snapshot.value]);
  if (snapshot.status === "loading") {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("section", { style: style.card, children: t("title") });
  }
  const editable = snapshot.status === "ready" && snapshot.writable;
  const fieldValue = (path) => draftFromSnapshot(snapshot, path);
  const field = (path) => {
    const spec = IMAGEGEN_FIELDS.find((f) => f.path === path);
    const copy = FIELD_COPY[path];
    const secret = spec.kind === "secret";
    const configured = secret && isConfigured(snapshot, path);
    const overridden = isOverridden(snapshot, path);
    const text = drafts[path];
    const shown = secret ? text : text !== "" || fieldValue(path) === "" ? text : fieldValue(path);
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: style.field, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: style.fieldHead, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { style: style.label, htmlFor: `imagegen-${path}`, children: t(copy.label) }),
        secret ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...style.badge, ...configured ? style.badgeOn : {} }, children: t(configured ? "configured" : "unconfigured") }) : overridden ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...style.badge, ...style.badgeOn }, children: "override" }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          id: `imagegen-${path}`,
          style: style.input,
          type: secret ? "password" : "text",
          autoComplete: secret ? "off" : void 0,
          spellCheck: false,
          value: shown,
          placeholder: secret ? t("keyPlaceholder") : fieldValue(path) || void 0,
          disabled: !editable,
          onChange: (event) => setDrafts((d) => ({ ...d, [path]: event.target.value }))
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: style.hint, children: t(copy.hint) })
    ] }, path);
  };
  const onSave = async () => {
    setBusy(true);
    setResult("");
    try {
      await props.save(drafts);
      setResult("ok");
      setDrafts(emptyDrafts());
    } catch {
      setResult("error");
    } finally {
      setBusy(false);
    }
  };
  const onDiscard = () => {
    props.discard();
    seeded.current = void 0;
    setDrafts(emptyDrafts());
    setResult("");
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: style.card, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { style: style.head, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: style.title, children: t("title") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: style.description, children: t("description") })
    ] }),
    IMAGEGEN_FIELDS.map((f) => field(f.path)),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: style.actions, children: [
      result === "ok" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: style.status, children: t("saved") }) : null,
      result === "error" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: style.status, children: t("error") }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: style.button, disabled: !editable || busy, onClick: onDiscard, children: t("discard") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...style.button, ...style.primary }, disabled: !editable || busy, onClick: onSave, children: busy ? t("saving") : t("save") })
    ] })
  ] });
}

// src/client/imagegen-toolview.tsx
var import_react2 = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
function parseResult(content) {
  const text = [];
  const images = [];
  for (const block of content ?? []) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      text.push(block.text);
    } else if (block.type === "image" && block.attachment !== void 0) {
      images.push(block.attachment);
    }
  }
  return { text: text.join("\n"), images };
}
var style2 = {
  card: {
    border: "0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))",
    borderRadius: 12,
    padding: "12px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    background: "var(--dsw-alias-bg-module-plain, transparent)",
    fontFamily: "inherit"
  },
  head: { display: "flex", flexDirection: "column", gap: 4 },
  title: { margin: 0, fontSize: 13.5, fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)" },
  meta: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", whiteSpace: "pre-wrap", wordBreak: "break-all" },
  gallery: { display: "flex", flexWrap: "wrap", gap: 10 },
  img: { maxWidth: 300, maxHeight: 400, borderRadius: 8, objectFit: "contain", border: "0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))" },
  placeholder: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", margin: 0 },
  error: { color: "var(--dsw-alias-label-danger, #d03050)" }
};
function GalleryImage({ ref, loader }) {
  const initial = loader.peek?.(ref);
  const [url, setUrl] = (0, import_react2.useState)(initial);
  const [failed, setFailed] = (0, import_react2.useState)(false);
  (0, import_react2.useEffect)(() => {
    if (url !== void 0) return;
    let stale = false;
    loader(ref).then(
      (next) => {
        if (!stale) setUrl(next);
      },
      () => {
        if (!stale) setFailed(true);
      }
    );
    return () => {
      stale = true;
    };
  }, [ref.attachmentId]);
  if (failed) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: style2.placeholder, children: "\u56FE\u7247\u52A0\u8F7D\u5931\u8D25\uFF08attachmentId \u5DF2\u8FC7\u671F\uFF1F\uFF09" });
  if (url === void 0) return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: style2.placeholder, children: "\u56FE\u7247\u52A0\u8F7D\u4E2D\u2026" });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    "img",
    {
      src: url,
      alt: ref.name ?? `generated ${ref.width ?? ""}x${ref.height ?? ""}`,
      style: style2.img
    }
  );
}
function GenerateImageToolview(props) {
  const block = props.block;
  const settled = block?.kind === "tool-result" ? block : void 0;
  if (settled === void 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("section", { style: style2.card, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("h4", { style: style2.title, children: [
      "\u{1F3A8} ",
      props.toolName,
      " \xB7 \u751F\u6210\u4E2D\u2026"
    ] }) });
  }
  const loader = props.loadImage;
  const parsed = parseResult(settled.content);
  const failed = settled.isError === true;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { style: style2.card, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("header", { style: style2.head, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { style: { ...style2.title, ...failed ? style2.error : {} }, children: failed ? "\u{1F3A8} generate_image \u5931\u8D25" : "\u{1F3A8} \u751F\u56FE\u5B8C\u6210" }),
      failed && settled.error !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("p", { style: style2.meta, children: [
        settled.error.name ?? "tool-error",
        settled.error.code === void 0 ? "" : ` (${settled.error.code})`
      ] }) : null
    ] }),
    parsed.images.length > 0 && loader !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: style2.gallery, children: parsed.images.map((ref) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(GalleryImage, { ref, loader }, ref.attachmentId)) }) : null,
    parsed.text !== "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: style2.meta, children: parsed.text }) : null,
    parsed.images.length === 0 && parsed.text === "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: style2.placeholder, children: "\uFF08\u65E0\u7ED3\u679C\u5185\u5BB9\uFF09" }) : null
  ] });
}

// src/client/locales.ts
var zh = {
  title: "imagegen",
  description: "\u8C46\u5305 Seedream 5.0 Pro \u4E0E\u963F\u91CC qwen-image-3.0-pro \u7684\u63A5\u5165\u51ED\u636E\u3002\u7559\u7A7A\u7684\u670D\u52A1\u4F7F\u7528\u5B98\u65B9\u9ED8\u8BA4\u5730\u5740\uFF1B\u4FDD\u5B58\u540E\u5BF9\u4E0B\u4E00\u6B21\u751F\u56FE\u8C03\u7528\u5373\u65F6\u751F\u6548\u3002",
  keyDoubao: "\u8C46\u5305 API Key",
  keyDoubaoHint: "\u706B\u5C71\u65B9\u821F\u63A7\u5236\u53F0\u521B\u5EFA\uFF1B\u7559\u7A7A\u5E76\u4FDD\u5B58 = \u4E0D\u6539\u52A8\u5DF2\u5B58 key\u3002\u4E5F\u53EF\u7528\u73AF\u5883\u53D8\u91CF ARK_API_KEY\u3002",
  keyQwen: "qwen API Key\uFF08\u963F\u91CC\u767E\u70BC\uFF09",
  keyQwenHint: "\u767E\u70BC/DashScope \u63A7\u5236\u53F0\u521B\u5EFA\uFF1B\u7559\u7A7A\u5E76\u4FDD\u5B58 = \u4E0D\u6539\u52A8\u5DF2\u5B58 key\u3002\u4E5F\u53EF\u7528\u73AF\u5883\u53D8\u91CF DASHSCOPE_API_KEY\u3002",
  urlDoubao: "\u8C46\u5305 API \u5730\u5740",
  urlDoubaoHint: "\u9ED8\u8BA4 https://ark.cn-beijing.volces.com/api/v3/images/generations",
  urlQwen: "qwen API \u5730\u5740",
  urlQwenHint: "\u9ED8\u8BA4 https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations",
  save: "\u4FDD\u5B58",
  discard: "\u653E\u5F03\u4FEE\u6539",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  saved: "\u5DF2\u4FDD\u5B58",
  error: "\u4FDD\u5B58\u5931\u8D25\uFF1A",
  configured: "\u5DF2\u914D\u7F6E",
  unconfigured: "\u672A\u914D\u7F6E",
  keyPlaceholder: "sk-\u2026\uFF08\u7559\u7A7A\u4FDD\u6301\u4E0D\u53D8\uFF09"
};
var en = {
  title: "imagegen",
  description: "Credentials for Doubao Seedream 5.0 Pro and Alibaba qwen-image-3.0-pro. Blank endpoints use the official defaults; changes apply to the next generation call.",
  keyDoubao: "Doubao API key",
  keyDoubaoHint: "Create in the Volcengine Ark console; saving an empty field keeps the stored key. Env fallback: ARK_API_KEY.",
  keyQwen: "qwen API key (Alibaba Bailian)",
  keyQwenHint: "Create in the Bailian/DashScope console; saving an empty field keeps the stored key. Env fallback: DASHSCOPE_API_KEY.",
  urlDoubao: "Doubao API endpoint",
  urlDoubaoHint: "Default https://ark.cn-beijing.volces.com/api/v3/images/generations",
  urlQwen: "qwen API endpoint",
  urlQwenHint: "Default https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations",
  save: "Save",
  discard: "Discard",
  saving: "Saving\u2026",
  saved: "Saved",
  error: "Save failed: ",
  configured: "Configured",
  unconfigured: "Not configured",
  keyPlaceholder: "sk-\u2026 (leave blank to keep)"
};

// src/client/index.ts
var COPY_NS = "settings.imagegen";
var inject = ["slots", "locale", "settingsScope"];
function apply(ctx) {
  const controller = new ImagegenCardController(ctx.settingsScope.bind({ namespace: IMAGEGEN_NS }));
  const t = ctx.locale.bind(COPY_NS);
  ctx.effect(
    () => ctx.locale.register(COPY_NS, { zh, en }),
    "imagegen: card dictionaries"
  );
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "imagegen",
    order: 60,
    label: () => t("title"),
    locale: COPY_NS,
    inject: () => controller.face()
  }, ImagegenCard));
  ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
    name: "tool.call.toolview",
    key: "generate_image"
  }, GenerateImageToolview));
}

		return module.exports;
	}
});
