import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 按插件子集裁剪索引：从当前索引里只挑出这次要发的几个插件。
 *
 * 为什么需要：索引是整个文件重算的。每个 PR 都贴一份完整索引，前一个 PR 一合，
 * 后面所有 PR 的索引立刻变成旧的，删冲突删到崩溃。只贴自己动过的那几个插件，
 * PR 之间就互不干扰。
 *
 * 用法：
 *   node scripts/rebase-index.mjs --plugins miao-plugin,genshin,zmd-plugin
 *   node scripts/rebase-index.mjs --plugins miao-plugin --out _rebase --from dist/index.json
 *
 * 裁完会就地自检：条数 / 哈希 / 字节数必须和复制过去的地图对得上，插件集合必须正好是给的那几个。
 */

const args = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const FROM = valueOf('from', path.join('dist', 'index.json'))
const OUT = valueOf('out', 'dist')
const rawPlugins = valueOf('plugins', '')

if (!rawPlugins) {
  console.error('用法：node scripts/rebase-index.mjs --plugins a,b,c [--from dist/index.json] [--out dist]')
  process.exit(1)
}

const wanted = [...new Set(rawPlugins.split(',').map(item => item.trim()).filter(Boolean))]
if (!wanted.length) {
  console.error('--plugins 里没有有效的插件名')
  process.exit(1)
}

let source
try {
  source = JSON.parse(fs.readFileSync(FROM, 'utf8'))
} catch (err) {
  console.error(`读不到源索引 ${FROM}：${err.message}`)
  process.exit(1)
}

const unknown = wanted.filter(key => !source.plugins?.[key])
if (unknown.length) {
  const known = Object.keys(source.plugins || {}).sort().join(', ')
  console.error(`源索引里没有这些插件：${unknown.join(', ')}`)
  console.error(`可用的是：${known}`)
  process.exit(1)
}

const srcMapsDir = path.join(path.dirname(FROM), 'maps')
const outMapsDir = path.join(OUT, 'maps')
fs.mkdirSync(outMapsDir, { recursive: true })

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

const plugins = {}
const problems = []

for (const key of wanted) {
  const entry = source.plugins[key]
  const src = path.join(srcMapsDir, path.basename(entry.file))
  if (!fs.existsSync(src)) {
    problems.push(`${key}: 源目录里没有地图文件 ${entry.file}`)
    continue
  }
  const raw = fs.readFileSync(src, 'utf8')

  // 地图本身也得跟索引对得上，否则裁出来的是一份自相矛盾的索引
  if (sha256(raw) !== entry.sha256) problems.push(`${key}: 地图哈希与索引不一致，先跑 build-index-v2`)
  if (Buffer.byteLength(raw, 'utf8') !== entry.bytes) problems.push(`${key}: 地图字节数与索引不一致，先跑 build-index-v2`)

  const mapFile = `maps/${key.replace(/[\\/]/g, '__')}.json`
  fs.writeFileSync(path.join(OUT, mapFile), raw, 'utf8')

  let map
  try {
    map = JSON.parse(raw)
  } catch (err) {
    problems.push(`${key}: 地图 JSON 解析失败 ${err.message}`)
    continue
  }
  if (map.instructions.length !== entry.command_count) {
    problems.push(`${key}: 地图 ${map.instructions.length} 条，索引写 ${entry.command_count} 条`)
  }

  plugins[key] = { ...entry, file: mapFile }
}

// 包（package）里只留被裁进来的注册单位，条数跟着重算，不然会写成全量
const packages = {}
for (const [name, pkg] of Object.entries(source.packages || {})) {
  const keep = pkg.units.filter(unit => plugins[unit])
  if (!keep.length) continue
  packages[name] = {
    ...pkg,
    units: keep,
    command_count: keep.reduce((sum, unit) => sum + plugins[unit].command_count, 0)
  }
}

const index = {
  schema: source.schema,
  revision: source.revision,
  updated: new Date().toISOString(),
  plugins,
  packages
}

if (problems.length) {
  console.error(`裁剪失败（${problems.length} 处）：`)
  for (const line of problems) console.error(`  - ${line}`)
  process.exit(1)
}

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')

// ---------- 自检：写出去的东西必须自己站得住 ----------

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok, detail })

const written = JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8'))
const writtenKeys = Object.keys(written.plugins).sort()
check(`只含指定的 ${wanted.length} 个插件`, JSON.stringify(writtenKeys) === JSON.stringify([...wanted].sort()), writtenKeys.join(', '))

for (const key of writtenKeys) {
  const entry = written.plugins[key]
  const full = path.join(OUT, entry.file)
  const exists = fs.existsSync(full)
  check(`${key} 地图已复制`, exists, entry.file)
  if (!exists) continue
  const raw = fs.readFileSync(full, 'utf8')
  check(`${key} 哈希对得上`, sha256(raw) === entry.sha256)
  check(`${key} 字节数对得上`, Buffer.byteLength(raw, 'utf8') === entry.bytes)
  check(`${key} 条数对得上`, JSON.parse(raw).instructions.length === entry.command_count)
}

const strays = fs.existsSync(outMapsDir) ? fs.readdirSync(outMapsDir).filter(name => name.endsWith('.json')) : []
const referenced = new Set(Object.values(written.plugins).map(entry => path.basename(entry.file)))
const extra = strays.filter(name => !referenced.has(name))
check('没有多余地图文件', extra.length === 0, extra.join(', ') || `${strays.length} 份`)

const failed = checks.filter(item => !item.ok)
for (const item of checks) console.log(`${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? `  (${item.detail})` : ''}`)

if (failed.length) {
  console.error(`\n自检未通过：${failed.length}/${checks.length}`)
  process.exit(1)
}

const total = writtenKeys.reduce((sum, key) => sum + written.plugins[key].command_count, 0)
console.log(`\n已生成 ${path.join(OUT, 'index.json')}：${writtenKeys.length} 个插件 ｜ ${total} 条指令 ｜ 自检 ${checks.length}/${checks.length} 通过`)
