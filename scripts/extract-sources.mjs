import fs from 'node:fs'
import path from 'node:path'

/**
 * 从插件源码里抽出「用户可见指令」的候选清单。
 *
 * 只做抽取，不做描述——描述由人（或生成环节）逐条写进地图。
 * 输出 JSON 供下一步消费，同时打印规模统计，便于判断这一轮要处理多少条。
 *
 * 用法：node scripts/extract-sources.mjs --plugins <插件目录> --out <输出文件>
 */

const args = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const PLUGINS_ROOT = valueOf('plugins', '')
const OUT = valueOf('out', 'extract.json')

if (!PLUGINS_ROOT || !fs.existsSync(PLUGINS_ROOT)) {
  console.error('用法：node scripts/extract-sources.mjs --plugins <插件目录> [--out extract.json]')
  process.exit(1)
}

/** 触发正则的四种写法：/.../flags、单引号、双引号、模板串 */
const REG_PATTERN = /reg:\s*(?:\/((?:\\.|[^/\\\n])+)\/[a-z]*|'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`)/g
const PERMISSION_PATTERN = /permission:\s*['"`]([^'"`]{1,20})['"`]/
const FNC_PATTERN = /fnc:\s*['"`]([^'"`]{1,60})['"`]/

/** 不收录的目录：地图使用者自己、框架示例、纯资源目录 */
const SKIP_DIRS = new Set(['chatgpt-plugin', 'zz-inject-test', 'swapfile', 'node_modules'])

function firstText (...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * 正则 → 用户可能打的写法（精简版）。
 *
 * 只做三件事：去首尾锚点、展开一层括号分支、补 `#`。复杂的断言组、字符类一律丢弃——
 * 这一步的产物是给人看与写描述的线索，准确写法以运行时枚举为准。
 */
export function commandHints (reg) {
  if (typeof reg !== 'string' || !reg.trim()) return []
  let body = reg.trim()
  const slashed = body.match(/^\/([\s\S]+)\/[a-z]*$/)
  if (slashed) body = slashed[1]

  body = body.replace(/^\^/, '').replace(/\$$/, '')
  body = body.replace(/\((\?[!=<][^()]*)\)/g, '')
  body = body.replace(/\(([^()]*)\)\?/g, '')

  const variants = []
  const walk = text => {
    const match = /\((?:\?:)?([^()]*)\)/.exec(text)
    if (!match) {
      variants.push(...text.split('|'))
      return
    }
    const head = text.slice(0, match.index)
    const tail = text.slice(match.index + match[0].length)
    for (const alt of match[1].split('|')) walk(head + alt + tail)
  }
  walk(body)

  const commands = []
  for (const raw of variants.slice(0, 6)) {
    const cleaned = raw
      .replace(/\[\^?[^\]]*\]\s*[*+?]?/g, '')
      .replace(/\\[sSdDwW]\s*[*+?]?/g, '')
      .replace(/\{\d*,?\d*\}/g, '')
      .replace(/\\(.)/g, '$1')
      .replace(/[()?*+:^$|[\]\\]/g, '')
      .replace(/\s+/g, '')
      .replace(/[.。·…、,，]+$/g, '')
    if (!cleaned) continue
    const command = cleaned.startsWith('#') ? cleaned : `#${cleaned}`
    if (!commands.includes(command)) commands.push(command)
  }
  return commands
}

function listJs (dir) {
  const out = []
  const walk = current => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) out.push(full)
    }
  }
  walk(dir)
  return out
}

function readVersion (dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return typeof pkg?.version === 'string' ? pkg.version.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 插件名与描述必须取自 `super({ ... })` 的头部，不能全文找第一个 `name:`。
 * 全文找会抓到子对象的字段（实测抓到过「椰奶配置-index」这种路由名）。
 */
function headerOf (text) {
  const at = text.indexOf('super(')
  if (at < 0) return ''
  return text.slice(at, at + 1200)
}

function matchField (text, field) {
  const pattern = new RegExp(`\\b${field}:\\s*['"\`]([^'"\`]{1,200})['"\`]`)
  return text.match(pattern)?.[1]?.trim() || ''
}

function scanPlugin (dir, key) {
  const files = listJs(dir).sort((left, right) => {
    const rank = name => (name.endsWith('index.js') ? 0 : name.includes(`${path.sep}apps${path.sep}`) ? 1 : 2)
    return rank(left) - rank(right)
  })
  if (!files.length) return null

  let name = ''
  let dsc = ''
  const instructions = []

  for (const file of files) {
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const header = headerOf(text)
    if (!name) name = matchField(header, 'name')
    if (!dsc) dsc = matchField(header, 'dsc')

    const relative = path.relative(dir, file).replace(/\\/g, '/')
    REG_PATTERN.lastIndex = 0
    let match
    while ((match = REG_PATTERN.exec(text))) {
      const reg = (match[1] || match[2] || match[3] || match[4] || '').trim()
      if (!reg) continue
      // 权限位与 fnc 与 reg 同处一个 rule 对象里，往后找最近的
      const after = text.slice(match.index, match.index + 400)
      const permission = after.match(PERMISSION_PATTERN)?.[1] || ''
      const fnc = after.match(FNC_PATTERN)?.[1] || ''
      const commands = commandHints(reg)
      if (!commands.length) continue
      instructions.push({
        reg,
        command: commands[0],
        aliases: commands.slice(1),
        permission,
        fnc,
        file: relative
      })
    }
  }

  if (!instructions.length) return null
  return { key, name: firstText(name, key), dsc, version: readVersion(dir), instructions }
}

const plugins = []
for (const entry of fs.readdirSync(PLUGINS_ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
  const plugin = scanPlugin(path.join(PLUGINS_ROOT, entry.name), entry.name)
  if (plugin) plugins.push(plugin)
}

plugins.sort((left, right) => right.instructions.length - left.instructions.length)
const total = plugins.reduce((sum, item) => sum + item.instructions.length, 0)

fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), plugins }, null, 2), 'utf8')

console.log(`插件 ${plugins.length} 个，指令 ${total} 条，已写入 ${OUT}`)
for (const plugin of plugins) {
  console.log(`${String(plugin.instructions.length).padStart(4)}  ${plugin.key}\t${plugin.name}`)
}
