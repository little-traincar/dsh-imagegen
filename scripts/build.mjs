/**
 * build.mjs —— 零依赖打包器：把 src/ 合成 lib/ 两个产物。
 *
 * 为什么不用 esbuild：本插件源码是普通 ESM + JSDoc（客户端用 createElement 而非
 * JSX），只需要「扁平拼接模块 + 相对导入改直接引用 + 顶层声明加模块前缀」，
 * Node 内置能力即可完成，安装体积与供应链都更干净。
 *
 * 做法：先把每个模块解析成「相对占位符 + 裸导入别名」的中间形态，并记录该模块
 * 的顶层声明与导出；等全部模块处理完（目标模块的前缀名已确定）再统一做一遍
 * 标识符重写。这样跨模块引用不依赖处理顺序，也不会出现重名。
 *
 *   - lib/index.js：Node ESM，模块扁平拼接，裸导入集中在顶部。
 *   - lib/client.js：浏览器 CJS 工厂（window.__ModuleLoader__.load），每个模块
 *     包一层 IIFE 暴露导出名，react 等裸导入走 factory 的 require。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = resolve(root, 'src')
const outDir = resolve(root, 'lib')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

const HEAD = '// 由 scripts/build.mjs 生成，请勿直接编辑（改 src/ 下的源码后重新构建）。\n'

/** 命名导入：import { a, b as c } from 'x'（允许跨行）。 */
const NAMED_IMPORT = /(^|\n)[ \t]*import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"\n]+)['"];?/gu
/** 默认导入：import X from 'x'。 */
const DEFAULT_IMPORT = /(^|\n)[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"\n]+)['"];?/gu
/** 命名空间导入：import * as X from 'x'。 */
const NAMESPACE_IMPORT = /(^|\n)[ \t]*import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"\n]+)['"];?/gu

/** 列出模块的依赖说明符。 */
function importSpecifiers(source) {
  const specs = []
  for (const match of source.matchAll(NAMED_IMPORT)) specs.push(match[3])
  for (const match of source.matchAll(DEFAULT_IMPORT)) specs.push(match[3])
  for (const match of source.matchAll(NAMESPACE_IMPORT)) specs.push(match[3])
  return specs
}

/** 深度优先收集入口的相对依赖（依赖在前、入口在后）。 */
async function collect(entry, seen = new Set()) {
  const absolute = resolve(entry)
  if (seen.has(absolute)) return []
  seen.add(absolute)
  const source = await readFile(absolute, 'utf8')
  const order = []
  for (const spec of importSpecifiers(source)) {
    if (!spec.startsWith('.')) continue
    order.push(...await collect(resolve(dirname(absolute), spec), seen))
  }
  order.push(absolute)
  return order
}

/** 解析命名导入子句：'a, b as c' → [[a,a],[b,c]]（[被导入名, 本地名]）。 */
function namedClauses(clauses) {
  return clauses.split(',').map((part) => part.trim()).filter((part) => part !== '')
    .map((part) => {
      const [imported, local] = part.split(/\s+as\s+/u).map((piece) => piece.trim())
      return [imported, local ?? imported]
    })
}

/** 解析导出子句：'a, b as c' → [[a,a],[b,c]]（[本地名, 公共名]）。 */
function exportedClauses(clauses) {
  return clauses.split(',').map((part) => part.trim()).filter((part) => part !== '')
    .map((part) => {
      const [local, alias] = part.split(/\s+as\s+/u).map((piece) => piece.trim())
      return [local, alias ?? local]
    })
}

/** 生成一个唯一名字。 */
function uniqueName(base, used) {
  let name = base
  let suffix = 2
  while (used.has(name)) {
    name = `${base}_${suffix}`
    suffix += 1
  }
  used.add(name)
  return name
}

/**
 * 标识符重命名的统一后缀限制：不能紧跟标识符字符（避免改到前缀更长的名字）。
 * 前缀侧由 renameAll 的负向断言处理，见那里的说明。
 */
const RENAME_SUFFIX = '(?![\\w$])'

/** 把标识符替换成别名（避开属性访问、属性键与紧邻标识符字符）。 */
function renameIdentifier(code, from, to) {
  if (from === to) return code
  // 属性键不能改名，所以这里额外挡住「后面跟冒号」的形态。
  return code.replace(new RegExp(`(?<![\\w$.])${from}${RENAME_SUFFIX}(?!\\s*:)`, 'gu'), to)
}

/**
 * 一次性完成多个标识符重命名（单遍扫描）。
 * 必须单遍：顺序替换会让「替换结果」被后续规则再次命中
 * （例如 count → m1_count 之后又被 count → __ns_0.count 命中）。
 * @param {string} code - 源码。
 * @param {Map<string, string>} renames - 旧名 → 新名。
 * @returns {string} 重命名后的源码。
 */
function renameAll(code, renames) {
  const entries = [...renames].filter(([from, to]) => from !== to)
  if (entries.length === 0) return code
  // 长名优先，避免前缀名被短名抢先匹配。
  entries.sort((left, right) => right[0].length - left[0].length)
  // 前缀侧断言不能用 `(?<![\w$.])`：它会把展开运算符 `...foo` 前面的点误判成
  // 属性访问而整体跳过。这里改成：前面不是「词字符或点」，或者前面的点本身
  // 前面还有两个点（即 `...foo`）。断言不消费字符，匹配始终就是标识符本身。
  const names = entries.map(([from]) => from).join('|')
  const pattern = new RegExp(`(?:(?<![\\w$.])|(?<=(?<=\\.\\.)\\.))(?:${names})${RENAME_SUFFIX}`, 'gu')
  const table = new Map(entries)
  return code.replace(pattern, (match) => table.get(match) ?? match)
}

/**
 * 取出模块的顶层声明名（函数/类/变量）。
 *
 * 只认「行首无缩进」的声明：本仓库的源码顶层声明一律顶格，函数体内部的
 * 局部声明都带缩进。否则局部变量会被误当成顶层名加前缀，把参数、解构键
 * 和对象字面量的简写属性一起改坏。
 */
function topLevelDeclarations(code) {
  const names = new Set()
  for (const match of code.matchAll(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gu)) {
    names.add(match[1])
  }
  for (const match of code.matchAll(/(?:^|\n)(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gu)) {
    names.add(match[1])
  }
  // 变量声明：只读到本语句结束（分号）或换行，避免跨语句误抓。
  for (const match of code.matchAll(/(?:^|\n)(?:export\s+)?(?:const|let|var)\s+([^;\n]*)/gu)) {
    for (const piece of match[1].split(',')) {
      const name = piece.split('=')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) names.add(name)
    }
  }
  return names
}

/**
 * 打包一个入口并写盘。
 * @param {{ entry: string, client: boolean }} options - 入口与产物形态。
 */
async function emit({ entry, client }) {
  const modules = await collect(entry)
  const used = new Set()
  /** 全局裸导入表：`说明符\0导入名` → 全局别名。 */
  const externals = new Map()
  /** 相对依赖表：绝对路径 → { id, index }。 */
  const moduleIds = new Map()

  const externalAlias = (spec, imported, seed) => {
    const key = `${spec}\u0000${imported}`
    let alias = externals.get(key)
    if (alias === undefined) {
      alias = uniqueName(`dep_${seed.replace(/[^\w$]/gu, '_')}`, used)
      externals.set(key, alias)
    }
    return alias
  }

  /** 第一遍：解析每个模块，产出中间形态与元信息。 */
  const parsed = []
  modules.forEach((file, moduleIndex) => moduleIds.set(resolve(file), { index: moduleIndex }))
  /** 命名空间对象名全局唯一，跨模块也不重名。 */
  let namespaceSeq = 0

  for (const file of modules) {
    const moduleIndex = moduleIds.get(resolve(file)).index
    const prefix = `m${moduleIndex}_`
    let out = await readFile(file, 'utf8')
    const importedBindings = new Set() // 相对导入引入的本地名（不可再加前缀）
    const bareRenames = new Map() // 本地名 → 全局别名或命名空间属性访问

    // 1) 导入替换。
    out = out.replace(NAMED_IMPORT, (all, lead, clauses, spec) => {
      if (!spec.startsWith('.')) {
        for (const [imported, local] of namedClauses(clauses)) {
          const alias = externalAlias(spec, imported, local)
          importedBindings.add(local)
          if (local !== alias) bareRenames.set(local, alias)
        }
        return ''
      }
      const targetIndex = moduleIds.get(resolve(dirname(file), spec))?.index
      if (targetIndex === undefined || parsed[targetIndex] === undefined) {
        throw new Error(`build: ${relative(root, file)} 的相对导入 ${spec} 必须先于它被打包`)
      }
      const local = `__ns_${namespaceSeq}`
      namespaceSeq += 1
      for (const [imported, binding] of namedClauses(clauses)) {
        if (!parsed[targetIndex].exports.some(([publicName]) => publicName === imported)) {
          throw new Error(`build: ${relative(root, file)} 从 ${spec} 导入了不存在的 ${imported}`)
        }
        // 本地名 → 命名空间属性访问：不会与目标模块的顶层声明重名。
        bareRenames.set(binding, `${local}.${imported}`)
        importedBindings.add(binding)
      }
      return `${lead}const ${local} = /*__NS__m${targetIndex}*/;`
    })

    out = out.replace(DEFAULT_IMPORT, (all, lead, local, spec) => {
      if (!spec.startsWith('.')) {
        const alias = externalAlias(spec, 'default', local)
        importedBindings.add(local)
        if (local !== alias) bareRenames.set(local, alias)
        return ''
      }
      const targetIndex = moduleIds.get(resolve(dirname(file), spec))?.index
      if (targetIndex === undefined || parsed[targetIndex] === undefined) {
        throw new Error(`build: ${relative(root, file)} 的相对导入 ${spec} 必须先于它被打包`)
      }
      const ns = `__ns_${namespaceSeq}`
      namespaceSeq += 1
      bareRenames.set(local, `${ns}.default`)
      importedBindings.add(local)
      return `${lead}const ${ns} = /*__NS__m${targetIndex}*/;`
    })

    out = out.replace(NAMESPACE_IMPORT, (all, lead, local, spec) => {
      if (!spec.startsWith('.')) throw new Error(`build: ${relative(root, file)} 对裸模块 ${spec} 使用了命名空间导入，请改为具名导入`)
      const targetIndex = moduleIds.get(resolve(dirname(file), spec))?.index
      if (targetIndex === undefined || parsed[targetIndex] === undefined) {
        throw new Error(`build: ${relative(root, file)} 的相对导入 ${spec} 必须先于它被打包`)
      }
      const ns = `__ns_${namespaceSeq}`
      namespaceSeq += 1
      bareRenames.set(local, ns)
      importedBindings.add(local)
      return `${lead}const ${ns} = /*__NS__m${targetIndex}*/;`
    })

    // 2) 导出登记：两种产物都把 export 关键字剥掉，公共导出统一在产物末尾声明。
    //    （ESM 里 `export const` 无法别名导出，而顶层声明已加模块前缀，
    //     所以入口模块的公共名字必须走 `export { m1_apply as apply }`。）
    //    每一项是 [公共名, 本地名]：本地名可能是 import 进来的绑定，
    //    也可能是本模块自己的顶层声明（后者会被加前缀）。
    const exported = []
    out = out.replace(/(^|\n)[ \t]*export\s*\{([^}]*)\};?/gu, (_all, lead, clauses) => {
      for (const [local, publicName] of exportedClauses(clauses)) exported.push([publicName, local])
      return lead
    })
    out = out.replace(/(^|\n)([ \t]*)export\s+(async\s+)?(function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gu,
      (_all, lead, pad, asyncKw, kind, localName) => {
        exported.push([localName, localName])
        return `${lead}${pad}${asyncKw ?? ''}${kind} ${localName}`
      })

    // 3) 顶层声明的前缀重命名表：跳过导入绑定（它们通过命名空间属性访问）。
    const renames = new Map(bareRenames)
    for (const name of topLevelDeclarations(out)) {
      if (name.startsWith('__ns_') || importedBindings.has(name) || renames.has(name)) continue
      renames.set(name, `${prefix}${name}`)
    }
    out = renameAll(out, renames)

    const scopedExports = exported.map(([publicName, localName]) => {
      if (bareRenames.has(localName)) return bareRenames.get(localName)
      if (importedBindings.has(localName)) return localName
      return `${prefix}${localName}`
    })
    parsed.push({
      file,
      index: moduleIndex,
      prefix,
      label: relative(srcDir, file).replace(/\\/gu, '/'),
      code: out.trim(),
      /** [公共名, 本地名] 列表。 */
      exports: exported,
      scopedExports, // 产物里的实际内部名
    })
  }

  // 第二遍：回填相对依赖的命名空间。属性名用公共名（导入方会写 ns.PUBLIC），
  // 值指向目标模块里的实际内部名。
  const fillNamespaces = (code) => code.replace(/\/\*__NS__m(\d+)\*\//gu, (_all, text) => {
    const target = parsed[Number(text)]
    if (target === undefined) throw new Error(`build: 内部错误，找不到模块 ${text}`)
    if (target.exports.length === 0) throw new Error(`build: ${target.label} 没有导出，无法被相对导入引用`)
    const pairs = target.exports.map(([publicName], position) => {
      const scoped = target.scopedExports[position]
      return scoped === publicName ? publicName : `${publicName}: ${scoped}`
    })
    return `{ ${pairs.join(', ')} }`
  })

  const externalLines = [...externals.entries()].map(([key, alias]) => {
    const separator = key.indexOf('\u0000')
    const spec = key.slice(0, separator)
    const imported = key.slice(separator + 1)
    if (client) {
      return imported === 'default'
        ? `const ${alias} = require(${JSON.stringify(spec)});`
        : `const ${alias} = require(${JSON.stringify(spec)}).${imported};`
    }
    return imported === 'default'
      ? `import ${alias} from ${JSON.stringify(spec)};`
      : `import { ${imported}${alias === imported ? '' : ` as ${alias}`} } from ${JSON.stringify(spec)};`
  })
  const header = externalLines.length === 0 ? '' : externalLines.join('\n') + '\n'

  const entryModule = parsed.find(({ file }) => resolve(file) === resolve(entry))

  if (!client) {
    // ESM 对外只暴露不带前缀的公共名（入口模块的导出）。
    const publicExports = entryModule.exports
      .map(([publicName], position) => `${entryModule.scopedExports[position]} as ${publicName}`)
    const text = parsed.map(({ label, code }) => `// —— ${label} ——\n${fillNamespaces(code)}\n`).join('\n')
    const exported = new Map(entryModule.exports.map(([publicName], position) => [publicName, entryModule.scopedExports[position]]))
    const defaultEntries = ['name', 'inject', 'apply', 'Config']
      .filter((key) => exported.has(key))
      .map((key) => `${key}: ${exported.get(key)}`)
    const exportBlock = `\n// —— 公共导出（入口模块） ——\nexport { ${publicExports.join(', ')} };\nexport default { ${defaultEntries.join(', ')} };\n`
    await writeFile(resolve(outDir, 'index.js'), HEAD + header + '\n' + text + exportBlock)
    return
  }

  const moduleText = parsed.map(({ label, code }) => `// —— ${label} ——\n${fillNamespaces(code)}`).join('\n')
  const assigns = entryModule.exports
    .map(([publicName], position) => `module.exports.${publicName} = ${entryModule.scopedExports[position]};`)
    .join('\n')
  // 模块体整体放进一个 IIFE：产物是 CJS 工厂，而模块里可能出现顶层 await
  // （或未来出现），顶层 await + module.exports 会让解析器判定模块格式有歧义。
  const body = [header.trimEnd(), moduleText.trimEnd(), assigns].filter((part) => part !== '').join('\n')
  const wrapper = `${HEAD}window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\n\t\tconst module = { exports: {} };\n\t\tconst exports = module.exports;\n\t\t;(() => {\n${indent(body)}\n\t\t})();\n\t\treturn module.exports;\n\t},\n});\n`
  await writeFile(resolve(outDir, 'client.js'), wrapper)
}

/** 把整段文本再缩进一级（放进 factory 函数体）。 */
function indent(code) {
  if (code === '') return ''
  return code.split('\n').map((line) => (line === '' ? line : `\t\t${line}`)).join('\n') + '\n'
}

await mkdir(outDir, { recursive: true })
await emit({ entry: resolve(srcDir, 'index.js'), client: false })
await emit({ entry: resolve(srcDir, 'client/index.js'), client: true })
console.log('[dsh-imagegen] built lib/index.js and lib/client.js')
