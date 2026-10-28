import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 由手写地图生成可发布的 `index.json`。
 *
 * 三件事：结构门禁（缺字段就不许发布）、算哈希与指纹、按内容变化自动升版本号。
 *
 * 版本号规则（写进仓库规范）：
 *   - 首次收录 → 0.0.1
 *   - 内容有任何变化（sha256 变）→ 末位 +1
 *   - 内容没变 → 沿用上一版，不制造空版本
 *
 * 用法：node scripts/build-index-v2.mjs [--maps maps-v2] [--out dist] [--prev dist/index.json]
 */

const args = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const MAPS_DIR = valueOf('maps', 'maps-v2')
const OUT_DIR = valueOf('out', 'dist')
const PREV_INDEX = valueOf('prev', path.join(OUT_DIR, 'index.json'))

const INDEX_SCHEMA = 2
const MAP_SCHEMA = 2

/** 一条指令必须有的字段：缺一个就不许发布 */
const REQUIRED_FIELDS = [
  'id', 'command', 'aliases', 'title', 'summary',
  'what', 'returns', 'returnsDetail', 'timing', 'cost',
  'keywords', 'params', 'example', 'moreExamples',
  'preconditions', 'pitfalls', 'failures', 'edgeCases',
  'scenarios', 'vs', 'related', 'risk', 'permission'
]

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

/** 写法集合的指纹：只看主写法，别名增减不算换了一版 */
function fingerprintOf (instructions) {
  const commands = [...new Set(
    instructions.map(item => String(item.command || '').trim()).filter(Boolean)
  )].sort()
  return crypto.createHash('sha1').update(commands.join('\n')).digest('hex').slice(0, 12)
}

/** key 里的分隔符压平，避免在文件系统上嵌套 */
const safeKey = key => String(key).replace(/[\\/]/g, '__')

/** 0.0.1 → 0.0.2；非标准版本号原样加后缀，交给人处理 */
function bump (version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || '').trim())
  if (!match) return version ? `${version}+1` : '0.0.1'
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

const prev = (() => {
  try {
    return JSON.parse(fs.readFileSync(PREV_INDEX, 'utf8'))
  } catch {
    return { plugins: {} }
  }
})()

const files = fs.existsSync(MAPS_DIR)
  ? fs.readdirSync(MAPS_DIR).filter(name => name.endsWith('.json') && !name.startsWith('_'))
  : []

if (!files.length) {
  console.error(`没有找到任何地图：${MAPS_DIR}`)
  process.exit(1)
}

fs.mkdirSync(path.join(OUT_DIR, 'maps'), { recursive: true })

const plugins = {}
const packages = {}
const problems = []
let totalCommands = 0
let anyChanged = false

for (const file of files) {
  const full = path.join(MAPS_DIR, file)
  const raw = fs.readFileSync(full, 'utf8')

  let map
  try {
    map = JSON.parse(raw)
  } catch (err) {
    problems.push(`${file}: JSON 解析失败 ${err.message}`)
    continue
  }

  if (Number(map.schema) !== MAP_SCHEMA) {
    problems.push(`${file}: schema 是 ${map.schema}，只认 ${MAP_SCHEMA}`)
    continue
  }
  if (!map.plugin || typeof map.plugin.key !== 'string' || !map.plugin.key.trim()) {
    problems.push(`${file}: 缺少 plugin.key`)
    continue
  }
  if (!Array.isArray(map.instructions) || !map.instructions.length) {
    problems.push(`${file}: instructions 为空`)
    continue
  }

  const key = map.plugin.key.trim()
  const missing = []
  const ids = new Set()
  const commands = new Set()
  for (const item of map.instructions) {
    const absent = REQUIRED_FIELDS.filter(field => !(field in item))
    if (absent.length) missing.push(`${item.id || '(无 id)'} 缺 ${absent.join('/')}`)
    if (item.id) {
      if (ids.has(item.id)) missing.push(`id 重复：${item.id}`)
      ids.add(item.id)
    }
    if (item.command) {
      if (commands.has(item.command)) missing.push(`写法重复：${item.command}`)
      commands.add(item.command)
    }
  }
  if (missing.length) {
    problems.push(`${file}: ${missing.slice(0, 3).join('；')}${missing.length > 3 ? ` 等 ${missing.length} 处` : ''}`)
    continue
  }

  const mapFile = `maps/${safeKey(key)}.json`
  fs.writeFileSync(path.join(OUT_DIR, mapFile), raw, 'utf8')

  const previous = prev.plugins?.[key]
  const digest = sha256(raw)
  const version = !previous
    ? '0.0.1'
    : previous.sha256 === digest
      ? previous.version
      : bump(previous.version)

  const previousRevision = Number(previous?.revision) || 0
  const changed = !previous || previous.sha256 !== digest
  if (changed) anyChanged = true

  plugins[key] = {
    file: mapFile,
    display: map.plugin.display || key,
    category: map.plugin.category || '其他',
    version,
    revision: changed ? previousRevision + 1 : previousRevision,
    command_count: map.instructions.length,
    fingerprint: fingerprintOf(map.instructions),
    sha256: digest,
    bytes: Buffer.byteLength(raw, 'utf8'),
    used: Number(previous?.used) || 0
  }

  const pkg = map.plugin.package || key
  if (!packages[pkg]) {
    packages[pkg] = { display: map.plugin.display || key, category: plugins[key].category, command_count: 0, units: [], used: 0 }
  }
  packages[pkg].command_count += map.instructions.length
  packages[pkg].units.push(key)
  totalCommands += map.instructions.length
}

if (problems.length) {
  console.error(`发布门禁未通过（${problems.length} 处）：`)
  for (const line of problems) console.error(`  - ${line}`)
  process.exit(1)
}

const index = {
  schema: INDEX_SCHEMA,
  revision: Number(prev.revision) || 0,
  updated: new Date().toISOString(),
  plugins,
  packages
}

if (anyChanged) index.revision = Number(prev.revision || 0) + 1

fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')

console.log(`已生成 ${OUT_DIR}/index.json`)
console.log(`插件 ${Object.keys(plugins).length} 个 ｜ 指令 ${totalCommands} 条 ｜ 索引修订号 ${index.revision}`)
for (const [key, item] of Object.entries(plugins)) {
  console.log(`  ${key.padEnd(22)} v${item.version.padEnd(8)} r${String(item.revision).padEnd(3)} ${String(item.command_count).padStart(4)} 条  ${item.fingerprint}`)
}
