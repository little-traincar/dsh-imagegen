/**
 * build.mjs —— 构建发布产物：
 *   - lib/index.js   Host 半侧（ESM，@deepseek-ai/* 外部化，由消费方环境提供）
 *   - lib/client.js  浏览器 bundle（__ModuleLoader__ 包裹，react 外部化）
 *
 * 可移植：优先从本包 node_modules 解析 esbuild（发布/自建环境），
 * 在 monorepo checkout 里开发时回退到仓库 pnpm store 的 esbuild。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_ID = 'dsh-imagegen'

let esbuildMain
try {
  esbuildMain = await import('esbuild')
} catch {
  try {
    esbuildMain = await import('../../../node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/lib/main.js')
  } catch {
    // GitHub 直装不装 devDependencies：无 esbuild 时，仓库提交的预构建 lib/ 直接可用。
    if (existsSync(join(root, 'lib/index.js')) && existsSync(join(root, 'lib/client.js'))) {
      console.warn('[dsh-imagegen] esbuild 不可用：跳过构建，使用已提交的 lib/ 产物')
      process.exit(0)
    }
    throw new Error('[dsh-imagegen] 需要 esbuild 才能构建（先 npm install，再 npm run build）')
  }
}
const { build } = esbuildMain.default ?? esbuildMain

await mkdir(join(root, 'lib'), { recursive: true })

// 1) Host：ESM 单文件；所有 @deepseek-ai/* 依赖留给宿主环境（dsh 安装目录 / profile node_modules）。
await build({
  entryPoints: [join(root, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  external: ['@deepseek-ai/*'],
  outfile: join(root, 'lib/index.js'),
  sourcemap: false,
  logLevel: 'warning',
})
console.log('[dsh-imagegen] built lib/index.js')

// 2) Client：CJS + __ModuleLoader__ 包裹；react/jsx-runtime 是平台共享模块。
const tmp = join(root, 'node_modules/.cache-imagegen-client.cjs')
await build({
  entryPoints: [join(root, 'src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  outfile: tmp,
  sourcemap: false,
  logLevel: 'warning',
})
const body = await readFile(tmp, 'utf8')
const wrapped = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(CLIENT_ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
		return module.exports;
	}
});
`
await writeFile(join(root, 'lib/client.js'), wrapped)
await rm(tmp, { force: true })
console.log('[dsh-imagegen] built lib/client.js')
