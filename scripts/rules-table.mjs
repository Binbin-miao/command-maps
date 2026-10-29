import fs from 'node:fs'
import path from 'node:path'

/**
 * 把一个插件的规则摊成一张表：文件:行号、fnc、permission、reg。
 *
 * 补地图时最耗时的是「这个插件到底有哪几条规则」——以前靠反复 grep 源码，
 * 一条命令摊平之后一次读完，也方便直接丢给表格工具筛。
 *
 * 纯静态：不 import、不实例化，所以任何插件都能扫，包括 import 就炸的那种。
 * 代价是 reg 写成变量/函数调用时读不出字面量，这类统一标 `(动态: 表达式原文)`。
 *
 * 用法：node scripts/rules-table.mjs <插件目录|插件名> [--root <Yunzai根>] [--header]
 *
 * 输出：TSV，四列，无表头（加 --header 才打），一列都不许空着占位。
 */

const argv = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}
const WITH_HEADER = argv.includes('--header')

const target = argv.find((item, index) => !item.startsWith('--') && !argv[index - 1]?.startsWith('--'))
if (!target) {
  console.error('用法：node scripts/rules-table.mjs <插件目录|插件名> [--root <Yunzai根>] [--header]')
  process.exit(1)
}

const ROOT = process.env.YUNZAI_ROOT || '/root/TRSS_AllBot/TRSS-Yunzai'
const pluginDir = fs.existsSync(target) && fs.statSync(target).isDirectory()
  ? path.resolve(target)
  : path.resolve(valueOf('root', ROOT), 'plugins', target)

if (!fs.existsSync(pluginDir)) {
  console.error(`找不到插件目录：${pluginDir}`)
  process.exit(1)
}

/** 规则可能写在 apps/，也可能在打包后的 dist/apps/ */
function scanDirs () {
  const candidates = [
    path.join(pluginDir, 'apps'),
    path.join(pluginDir, 'dist', 'apps'),
    path.join(pluginDir, 'src', 'apps'),
    pluginDir
  ]
  return candidates.filter(dir => fs.existsSync(dir))
}

function listJs (dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listJs(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

/** 去重：apps/ 与根目录都扫的话，同一个文件可能被算两次 */
const files = [...new Set(scanDirs().flatMap(dir => listJs(dir)))].sort()

/**
 * 从 `{` 找到配对的 `}`，跳过字符串与注释。
 * 只为了划出「这一条规则对象的范围」，不需要完整词法分析。
 */
function closeBrace (src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return src.length - 1; continue }
    if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return src.length - 1; i++; continue }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue }
        if (src[i] === quote) break
      }
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i
  }
  return src.length - 1
}

/** 反向找包含当前位置的对象字面量起点 */
function openBrace (src, from) {
  let depth = 0
  for (let i = from; i >= 0; i--) {
    if (src[i] === '}') depth++
    else if (src[i] === '{') {
      if (depth === 0) return i
      depth--
    }
  }
  return 0
}

const lineAt = (src, index) => {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) line++
  return line
}

/** 取 `reg:` 后面那个表达式的原文，遇到同层的 , 或 } 就停 */
function readValue (src, start) {
  let depth = 0
  let i = start
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue }
        if (src[i] === quote) break
      }
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break
      depth--
    } else if (ch === ',' && depth === 0) break
    else if (ch === '\n' && depth === 0) break
  }
  return src.slice(start, i).trim()
}

/**
 * 源码里的字符串字面量还原成运行时的文本。
 * `'\\s'` 运行时是 `\s`，正则字面量 `/…\s…/` 原文就是 `\s` —— 不还原的话同一件事会显示成两种样子。
 */
function unescapeJs (text) {
  return text.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (whole, seq) => {
    if (seq[0] === 'u') {
      const hex = seq[1] === '{' ? seq.slice(2, -1) : seq.slice(1)
      return String.fromCodePoint(Number.parseInt(hex, 16))
    }
    if (seq[0] === 'x') return String.fromCharCode(Number.parseInt(seq.slice(1), 16))
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\n': '' }
    return seq in simple ? simple[seq] : seq
  })
}

/**
 * 表达式 → 可读的正则文本。
 * 字符串/模板/正则字面量取内容；`new RegExp('...')` 取参数；
 * 其余（变量、函数调用、拼接里的未知量）标成动态，不留空。
 */
function normalizeReg (expr) {
  const raw = expr.trim()
  if (!raw) return '(空)'

  const str = /^(['"`])((?:\\.|(?!\1)[\s\S])*)\1$/.exec(raw)
  if (str) return unescapeJs(str[2])

  const re = /^\/((?:\\.|\[[^\]]*\]|[^/\\])+)\/[gimsuy]*$/.exec(raw)
  if (re) return re[1]

  const regExpCtor = /^new\s+RegExp\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1\s*\)$/.exec(raw)
  if (regExpCtor) return unescapeJs(regExpCtor[2])

  return `(动态: ${raw.replace(/\s+/g, ' ')})`
}

/** 从规则对象里读 fnc / permission；缺就是空，绝不输出 undefined */
function field (block, names) {
  for (const name of names) {
    const hit = new RegExp(`\\b${name}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*?)\\1`).exec(block)
    if (hit) return hit[2]
    const bare = new RegExp(`\\b${name}\\s*:\\s*([A-Za-z_$][\\w$.]*)`).exec(block)
    if (bare && bare[1] !== 'undefined') return bare[1]
  }
  return ''
}

const rows = []
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const rel = path.relative(pluginDir, file).replace(/\\/g, '/')
  const regExpr = /(?<![\w$.])reg\s*:/g
  let match
  while ((match = regExpr.exec(src)) !== null) {
    const valueStart = match.index + match[0].length
    const expr = readValue(src, valueStart)
    if (!expr) continue
    const open = openBrace(src, match.index)
    const block = src.slice(open, closeBrace(src, open) + 1)
    rows.push({
      at: `${rel}:${lineAt(src, match.index)}`,
      fnc: field(block, ['fnc', 'fnc_name', 'func']),
      permission: field(block, ['permission', 'perm']),
      reg: normalizeReg(expr)
    })
  }
}

if (!rows.length) {
  console.error(`${pluginDir} 下没扫到 reg: 规则`)
  process.exit(1)
}

const cell = text => String(text ?? '').replace(/[\t\r\n]+/g, ' ')
if (WITH_HEADER) console.log(['位置', 'fnc', 'permission', 'reg'].join('\t'))
for (const row of rows) {
  console.log([row.at, cell(row.fnc), cell(row.permission), cell(row.reg)].join('\t'))
}

const dynamic = rows.filter(row => row.reg.startsWith('(动态')).length
console.error(`${path.basename(pluginDir)}：${rows.length} 条规则 ｜ ${files.length} 个文件${dynamic ? ` ｜ 动态 ${dynamic} 条` : ''}`)
