import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 离线枚举插件的规则（不启动 Bot、不连协议端）。
 *
 * 插件形态不统一，这里处理四类：
 *   A. v2 类：`export class Xxx extends plugin { rule: [...] }` —— 直接 new
 *   B. v3 应用：`App.init().reg({...})` 或 `{ v3App() }` —— new (v3App())() 取 rule
 *   C. 打包产物：源码在 `dist/apps/` 而不是 `apps/`（ZZZ-Plugin）
 *   D. 抽不出来的：import 就抛（裸全局）、实例化要读数据文件的 —— 退到源码正则静态抽取
 *
 * 框架启动时才挂到全局的东西补成递归占位：任意深度属性访问都返回可调用对象，
 * 只为让 constructor 跑得下去，不产生真实行为。
 */

const ROOT = process.env.YUNZAI_ROOT || '/root/TRSS_AllBot/TRSS-Yunzai'
process.chdir(ROOT)

const noop = () => {}
const plain = text => String(text ?? '')

/** 递归占位：任意属性、任意调用都返回同类占位，链式永不断 */
function deepFake() {
  const fn = function () { return deepFake() }
  return new Proxy(fn, {
    get: (target, key) => {
      // then 必须 undefined，否则 await 会把它当 thenable 无限递归
      if (key === 'then') return undefined
      if (key === Symbol.toPrimitive) return () => ''
      if (key === Symbol.iterator) return undefined
      if (key === 'toString') return () => ''
      if (key === 'valueOf') return () => 0
      if (key === 'length') return 0
      return deepFake()
    },
    apply: () => deepFake(),
    construct: () => deepFake()
  })
}

globalThis.logger = { info: noop, warn: noop, error: noop, debug: noop, mark: noop, trace: noop, fatal: noop }
// TRSS 给 logger 挂了 chalk 风格的方法（logger.red(...)），补成直通
for (const style of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'gray', 'grey', 'white', 'bold', 'dim', 'italic', 'underline']) {
  globalThis.logger[style] = plain
}

// segment 的方法随框架版本变化（button / markdown / record…），用 Proxy 兜住所有名字
globalThis.segment = new Proxy({}, { get: () => () => deepFake() })

// redis 的返回值参与业务判断（if (await redis.get(k))），这里给确定的 falsy 而不是占位
globalThis.redis = new Proxy({}, {
  get: (target, key) => {
    if (key === 'keys') return async () => []
    if (key === 'get') return async () => null
    if (key === 'ttl') return async () => -1
    if (key === 'exists') return async () => 0
    if (key === 'lrange' || key === 'smembers') return async () => []
    return async () => null
  }
})

globalThis.Bot = deepFake()

// 不少插件直接用全局 plugin（框架挂在 global 上），补上基类
try {
  const loaderMod = await import(pathToFileURL(path.join(ROOT, 'lib/plugins/plugin.js')).href)
  globalThis.plugin = loaderMod.default || loaderMod
} catch {
  // 拿不到基类时给个最小替身，让 extends plugin 至少能声明成功
  globalThis.plugin = class {
    constructor (cfg = {}) {
      Object.assign(this, cfg)
      this.reply = async () => true
      this.e = {}
    }
  }
}

const key = process.argv[2]
if (!key) {
  console.error('用法：node probe-loader.mjs <插件目录名>')
  process.exit(1)
}

const pluginDir = path.join(ROOT, 'plugins', key)

function listJs(dir) {
  const out = []
  const walk = current => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) out.push(full)
    }
  }
  walk(dir)
  return out
}

/** 规则目录：app 可能在 apps/ 也可能在 dist/apps/（打包产物） */
function ruleDirs() {
  const candidates = [
    path.join(pluginDir, 'apps'),
    path.join(pluginDir, 'dist', 'apps'),
    path.join(pluginDir, 'src', 'apps')
  ]
  return candidates.filter(dir => fs.existsSync(dir))
}

const files = [
  ...ruleDirs().flatMap(listJs),
  path.join(pluginDir, 'index.js')
].filter(file => fs.existsSync(file))

const classes = []
const errors = []
const seenRules = new Set()

function pushClass(file, instance, origin) {
  const rules = instance.rule
    .filter(rule => rule && rule.reg)
    .map(rule => ({
      reg: typeof rule.reg === 'string' ? rule.reg : String(rule.reg),
      permission: rule.permission || '',
      fnc: rule.fnc || '',
      name: rule.name || ''
    }))
  if (rules.length === 0) return false
  classes.push({
    file: path.relative(pluginDir, file).replace(/\\/g, '/'),
    name: instance.name || '',
    dsc: instance.dsc || '',
    origin,
    rules
  })
  return true
}

/** 递归展开导出值，兼容 { apps: { a, b } } 这种包一层的 */
function harvest(value, file, depth = 0) {
  if (value === null || value === undefined || depth > 4) return
  const type = typeof value

  if (type === 'function') {
    // A. v2 类：直接 new
    try {
      const instance = new value()
      if (Array.isArray(instance.rule) && pushClass(file, instance, 'v2')) return
    } catch {
      // 不是 class、或构造要读外部数据 —— 继续往下试，不记错误（这是常态不是异常）
    }
    // B. v3 应用：v3App() 返回一个 class，new 出来才有 rule
    try {
      if (typeof value.v3App === 'function') {
        const AppClass = value.v3App()
        if (typeof AppClass === 'function') {
          const instance = new AppClass()
          if (Array.isArray(instance.rule) && pushClass(file, instance, 'v3')) return
        }
      }
    } catch {
      // 同上
    }
    return
  }

  if (type !== 'object') return

  // 已经是实例，且有 rule 数组
  if (Array.isArray(value.rule) && pushClass(file, value, 'instance')) return

  // v3 应用也可能直接挂在对象上
  try {
    if (typeof value.v3App === 'function') {
      const AppClass = value.v3App()
      if (typeof AppClass === 'function') {
        const instance = new AppClass()
        if (Array.isArray(instance.rule) && pushClass(file, instance, 'v3')) return
      }
    }
  } catch {
    // 忽略
  }

  for (const child of Object.values(value)) harvest(child, file, depth + 1)
}

/** D. 静态兜底：正则从源码里抠 reg / rule / pattern 字面量 */
function staticExtract(file) {
  let source
  try {
    source = fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
  const patterns = [
    /\breg:\s*(['"`])((?:\\.|(?!\1).)+)\1/g,
    /\brule:\s*\/((?:\\.|[^/\n])+)\/([gimsuy]*)/g,
    /\bpattern:\s*(['"`])((?:\\.|(?!\1).)+)\1/g
  ]
  const regs = []
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(source)) !== null) {
      const raw = match[2]
      if (!raw || raw.length > 200) continue
      if (!regs.includes(raw)) regs.push(raw)
    }
  }
  if (regs.length === 0) return null

  const nameMatch = source.match(/\bname:\s*(['"`])((?:\\.|(?!\1).)+)\1/)
  const dscMatch = source.match(/\bdsc:\s*(['"`])((?:\\.|(?!\1).)+)\1/)
  const permMatch = source.match(/\bpermission:\s*(['"`])master\1/)

  return {
    file: path.relative(pluginDir, file).replace(/\\/g, '/'),
    name: nameMatch ? nameMatch[2] : '',
    dsc: dscMatch ? dscMatch[2] : '',
    origin: 'static',
    rules: regs.map(reg => ({
      reg,
      permission: permMatch ? 'master' : '',
      fnc: '',
      name: ''
    }))
  }
}

for (const file of files) {
  let mod
  try {
    mod = await import(file)
  } catch (err) {
    // import 就炸（模块级裸全局、版本检查），退到静态抽取
    const fallback = staticExtract(file)
    if (fallback) {
      classes.push(fallback)
      errors.push(`${path.relative(pluginDir, file)}: import 失败（已静态抽取 ${fallback.rules.length} 条）${err?.message || err}`)
    } else {
      errors.push(`${path.relative(pluginDir, file)}: import 失败 ${err?.message || err}`)
    }
    continue
  }

  const before = classes.length
  for (const value of Object.values(mod)) {
    harvest(value, file)
  }
  // 一个规则都没抽到，但文件里确实有 reg/rule 字面量 → 静态兜底
  if (classes.length === before) {
    const fallback = staticExtract(file)
    if (fallback) {
      classes.push(fallback)
      errors.push(`${path.relative(pluginDir, file)}: 实例化无法取到 rule（已静态抽取 ${fallback.rules.length} 条）`)
    }
  }
}

// 同一份规则可能被多个入口重复导出（apps/index.js 汇总了各子模块），按 reg 集合去重
const deduped = []
for (const entry of classes) {
  const fingerprint = entry.rules.map(rule => rule.reg).join('\u0000')
  if (seenRules.has(fingerprint)) continue
  seenRules.add(fingerprint)
  deduped.push(entry)
}

const totalRules = deduped.reduce((sum, entry) => sum + entry.rules.length, 0)
console.log(JSON.stringify({ key, classes: deduped, errors, totalRules }))
process.exit(0)
