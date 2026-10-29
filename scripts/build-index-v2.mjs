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
 *       node scripts/build-index-v2.mjs --check-index [--index dist/index.json]
 *
 * `--check-index` 只做一件事：按当前地图把索引算一遍，跟已提交的那份逐字段比，
 * 不一致就非 0 退出并点名哪个插件的哪一项。拦的是「改了地图、却没重建索引」这类半更新 ——
 * 只重建索引本身发现不了它，因为重建出来的总是自洽的。
 */

const args = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const MAPS_DIR = valueOf('maps', 'maps-v2')
const OUT_DIR = valueOf('out', 'dist')
const PREV_INDEX = valueOf('prev', path.join(OUT_DIR, 'index.json'))
/** 只比对不重建：按地图算一遍，跟这份已提交的索引逐字段比 */
const CHECK_INDEX = args.includes('--check-index')
if (args.includes('--check-display')) {
  console.error('--check-display 已改名为 --check-index（现在是全字段对账，不再只比展示名）')
  process.exit(1)
}
const INDEX_TO_CHECK = valueOf('index', PREV_INDEX)

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

/**
 * 可选字段：不填就是默认语义，填了必须类型正确。
 *   enabled_by_default —— false 表示这条指令装了也默认不响应，要先手动开启
 *   implemented_in     —— 非空表示这条只是帮助菜单里的入口，真正实现在别的插件
 */
const OPTIONAL_FIELDS = {
  enabled_by_default: value => typeof value === 'boolean',
  implemented_in: value => typeof value === 'string'
}

/** 覆盖率对账阈值：地图条数与枚举规则数偏差超过这个比例就提醒 */
const COVERAGE_TOLERANCE = 0.1

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

// 只比对模式不碰发布目录，连目录都不建
if (!CHECK_INDEX) fs.mkdirSync(path.join(OUT_DIR, 'maps'), { recursive: true })

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
    for (const [field, check] of Object.entries(OPTIONAL_FIELDS)) {
      if (field in item && !check(item[field])) {
        missing.push(`${item.id || '(无 id)'} 的 ${field} 类型不对`)
      }
    }
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
  // 只比对模式不动 dist，免得一次检查顺手改了发布目录
  if (!CHECK_INDEX) fs.writeFileSync(path.join(OUT_DIR, mapFile), raw, 'utf8')

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
    // 装了也默认不响应的条数 —— 检索端据此决定要不要先提醒用户去开开关
    default_off_count: map.instructions.filter(item => item.enabled_by_default === false).length,
    // 帮助菜单里有、但真正实现在别处的条数
    delegated_count: map.instructions.filter(item => item.implemented_in).length,
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

/**
 * 索引对账：按当前地图算出来的索引，必须与已提交的那份一致。
 * 不一致就意味着「地图改了、索引没重建」，照这样合并下去线上发的是旧数据。
 * 只重建索引本身发现不了这件事 —— 重建出来的永远是自洽的。
 *
 * 比法：除两个「不由地图派生」的字段外全比。
 *   index.updated   —— 每次构建都变
 *   *.used          —— 运行时统计，来自日志而不是地图
 * 其余一律算：插件条目的全部字段、packages 整层、顶层 schema / revision。
 * 不写死字段清单 —— 清单会漏，而漏掉的那一项正好就是没人会去改的那一项。
 */
if (CHECK_INDEX) {
  let committed
  try {
    committed = JSON.parse(fs.readFileSync(INDEX_TO_CHECK, 'utf8'))
  } catch (err) {
    console.error(`读不到索引 ${INDEX_TO_CHECK}：${err.message}`)
    process.exit(1)
  }

  /** 去掉 used（运行时统计），其余按键排序，得到可比字符串 */
  const withoutUsed = value => {
    const { used, ...rest } = value || {}
    return rest
  }
  const stable = value => JSON.stringify(Object.keys(value).sort().map(key => [key, value[key]]))
  /** 字符串直接打原文，其余打 JSON —— 报错信息里少一层引号 */
  const fmt = value => (typeof value === 'string' ? value : JSON.stringify(value))

  const drift = []
  const before = committed.plugins || {}
  const after = index.plugins || {}

  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!before[key]) {
      drift.push(`${key}: 地图里有，索引里没有（新地图忘了建索引）`)
      continue
    }
    if (!after[key]) {
      drift.push(`${key}: 索引里有，地图里没有（地图删了没重建）`)
      continue
    }
    const old = withoutUsed(before[key])
    const fresh = withoutUsed(after[key])
    for (const field of [...new Set([...Object.keys(old), ...Object.keys(fresh)])].sort()) {
      const a = JSON.stringify(old[field])
      const b = JSON.stringify(fresh[field])
      if (a !== b) drift.push(`${key}.${field}: 索引写「${fmt(old[field])}」，按地图应为「${fmt(fresh[field])}」`)
    }
  }

  // packages 是插件的归拢视图，同样由地图派生，整层比
  const packagesBefore = Object.fromEntries(Object.entries(committed.packages || {}).map(([key, value]) => [key, withoutUsed(value)]))
  const packagesAfter = Object.fromEntries(Object.entries(index.packages || {}).map(([key, value]) => [key, withoutUsed(value)]))
  if (stable(packagesBefore) !== stable(packagesAfter)) {
    for (const key of [...new Set([...Object.keys(packagesBefore), ...Object.keys(packagesAfter)])].sort()) {
      if (stable(packagesBefore[key] || {}) === stable(packagesAfter[key] || {})) continue
      drift.push(`packages.${key}: 索引写「${JSON.stringify(packagesBefore[key] || null)}」，按地图应为「${JSON.stringify(packagesAfter[key] || null)}」`)
    }
  }

  // 顶层两项：任一地图内容变化，revision 就该跟着走
  for (const field of ['schema', 'revision']) {
    if (String(committed[field]) !== String(index[field])) {
      drift.push(`${field}: 索引写「${committed[field]}」，按地图应为「${index[field]}」`)
    }
  }

  if (drift.length) {
    console.error(`已提交的索引与地图不一致（${drift.length} 处）—— 改完地图要重建索引：`)
    for (const line of drift.slice(0, 20)) console.error(`  - ${line}`)
    if (drift.length > 20) console.error(`  …还有 ${drift.length - 20} 处`)
    process.exit(1)
  }
  console.log(`索引与地图一致：${Object.keys(after).length} 个插件，修订号 ${index.revision}`)
  process.exit(0)
}

/**
 * 覆盖率对账：插件源码里有多少条正则规则，地图里就该有差不多数量的说明。
 * 偏差超阈值只提醒不阻断 —— 合并「开启/关闭」成一条、或把一条规则拆成多条都是合理的。
 * 基线由 probe 侧产出，放在 maps-v2/_rule-counts.json（下划线开头，不会被当地图扫描）。
 */
const warnings = []
const countsPath = path.join(MAPS_DIR, '_rule-counts.json')
if (fs.existsSync(countsPath)) {
  let counts = {}
  try {
    counts = JSON.parse(fs.readFileSync(countsPath, 'utf8'))
  } catch (err) {
    warnings.push(`_rule-counts.json 解析失败：${err.message}`)
  }
  for (const [key, item] of Object.entries(plugins)) {
    const expected = Number(counts[key])
    if (!expected) continue
    // 只盯「漏写」：地图条数明显少于规则数才提醒。
    // 反过来地图比规则多是正常的 —— README 里提到但源码没写死的能力也会补进来。
    if (item.command_count >= expected * (1 - COVERAGE_TOLERANCE)) continue
    const diff = expected - item.command_count
    warnings.push(`${key}: 枚举 ${expected} 条规则，地图只有 ${item.command_count} 条（少 ${diff}，${((diff / expected) * 100).toFixed(0)}%），可能有整块漏写`)
  }
}

fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8')

console.log(`已生成 ${OUT_DIR}/index.json`)
console.log(`插件 ${Object.keys(plugins).length} 个 ｜ 指令 ${totalCommands} 条 ｜ 索引修订号 ${index.revision}`)
for (const [key, item] of Object.entries(plugins)) {
  const flags = []
  if (item.default_off_count) flags.push(`默认关 ${item.default_off_count}`)
  if (item.delegated_count) flags.push(`借别家 ${item.delegated_count}`)
  const tail = flags.length ? `  [${flags.join(' / ')}]` : ''
  console.log(`  ${key.padEnd(22)} v${item.version.padEnd(8)} r${String(item.revision).padEnd(3)} ${String(item.command_count).padStart(4)} 条  ${item.fingerprint}${tail}`)
}
if (warnings.length) {
  console.warn(`\n覆盖率提醒（${warnings.length} 处，不阻断发布）：`)
  for (const line of warnings) console.warn(`  ! ${line}`)
}
