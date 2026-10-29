import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

/**
 * 发布产物自检，分两层：
 *
 *   1. 结构层 —— 只读 dist/，不需要任何外部仓库。索引里写的哈希 / 字节数 / 条数 /
 *      展示名，必须和真正落盘的地图对得上；dist/maps 里不许有索引没收录的孤儿文件。
 *      CI 与任何 fork 都跑这一层。
 *
 *   2. 链路层 —— 用 chatgpt-plugin 的真实拉取代码，把 https://maps.test/<path>
 *      映射到 dist/<path>，从生成好的 dist/ 完整同步一次。验证哈希校验、落盘、
 *      元信息、拍平检索全链路。需要本地有前端仓库，没有就跳过。
 */

const argv = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}

// 默认查 dist；rebase-index 裁出来的子集索引可以用 --dist 指过去单独验
const DIST = path.resolve(valueOf('dist', 'dist'))

/**
 * 前端仓库（chatgpt-plugin）不在本仓库里。按约定找几个相对位置，都没有就只跑结构层。
 * 别把绝对路径写进代码 —— 换台机器就得改源码，是上一版的教训。
 */
const FRONTEND = process.env.FRONTEND_REPO || [
  '../chatgpt-plugin',
  '../chatgpt-plugin-cloud',
  '../参考仓库/chatgpt-plugin-cloud'
].map(item => path.resolve(item)).find(item => fs.existsSync(path.join(item, 'utils', 'capability', 'mapRunner.js'))) || path.resolve('../chatgpt-plugin')

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok, detail })
const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

const indexPath = path.join(DIST, 'index.json')
if (!fs.existsSync(indexPath)) {
  console.error(`没有 ${indexPath}，先跑 node scripts/build-index-v2.mjs`)
  process.exit(1)
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
const keys = Object.keys(index.plugins)
const expectedPull = keys.length
const expectedEntries = Object.values(index.plugins).reduce((sum, item) => sum + item.command_count, 0)

// ---------- 1. 结构层 ----------

check('索引 schema 是 2', index.schema === 2, String(index.schema))
check('索引带修订号', Number.isInteger(index.revision), String(index.revision))
check('索引里有插件', expectedPull > 0, `${expectedPull} 个`)

const mapsDir = path.join(DIST, 'maps')
for (const key of keys) {
  const entry = index.plugins[key]
  const full = path.join(DIST, entry.file)
  if (!fs.existsSync(full)) {
    check(`${key} 地图已落盘`, false, entry.file)
    continue
  }
  const raw = fs.readFileSync(full, 'utf8')
  check(`${key} 落盘哈希对得上`, sha256(raw) === entry.sha256)
  check(`${key} 落盘字节数对得上`, Buffer.byteLength(raw, 'utf8') === entry.bytes, `${Buffer.byteLength(raw, 'utf8')} vs ${entry.bytes}`)

  let map
  try {
    map = JSON.parse(raw)
  } catch (err) {
    check(`${key} 地图可解析`, false, err.message)
    continue
  }
  check(`${key} 条数一致`, map.instructions.length === entry.command_count, `${map.instructions.length} vs ${entry.command_count}`)
  check(`${key} 展示名与地图一致`, String(entry.display) === String(map.plugin?.display || key), `${entry.display} vs ${map.plugin?.display}`)
  check(`${key} 默认关计数对得上`, entry.default_off_count === map.instructions.filter(item => item.enabled_by_default === false).length)
}

const landed = fs.existsSync(mapsDir) ? fs.readdirSync(mapsDir).filter(name => name.endsWith('.json')) : []
const referenced = new Set(Object.values(index.plugins).map(entry => path.basename(entry.file)))
const orphans = landed.filter(name => !referenced.has(name))
check('dist/maps 没有孤儿文件', orphans.length === 0, orphans.join(', ') || `${landed.length} 份`)

// ---------- 2. 链路层（有前端仓库才跑） ----------

const frontendEntry = path.join(FRONTEND, 'utils', 'capability', 'mapRunner.js')
const canReachFrontend = fs.existsSync(frontendEntry)
let flat = null

if (canReachFrontend) {
  const fakeFetch = async target => {
    const url = new URL(String(target))
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const file = path.join(DIST, rel)
    if (!rel || !fs.existsSync(file)) {
      return { ok: false, status: 404, url: String(target), headers: { get: () => null }, text: async () => '' }
    }
    const body = fs.readFileSync(file, 'utf8')
    return {
      ok: true,
      status: 200,
      url: String(target),
      headers: { get: () => null },
      text: async () => body
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'map-verify-'))
  const original = process.cwd()
  process.chdir(tmp)

  const load = rel => import(pathToFileURL(path.join(FRONTEND, rel)).href)
  const { syncPluginMaps } = await load('utils/capability/mapRunner.js')
  const { readLocalMap, readLocalMeta, listLocalMapKeys } = await load('utils/capability/mapStore.js')
  const { loadMapIndex } = await load('utils/capability/mapIndex.js')

  const installed = keys.map(key => ({ key, version: index.plugins[key].version }))
  // 故意多给一个云端没有的插件，验证缺失清单
  installed.push({ key: 'ghost-plugin', version: '9.9.9' })

  const result = await syncPluginMaps({
    indexUrl: 'https://maps.test/index.json',
    fetchImpl: fakeFetch,
    plugins: installed
  })

  check('拉取成功数', result.updated === expectedPull, `updated=${result.updated}/${expectedPull}`)
  check('缺失清单只含云端没有的那个', JSON.stringify(result.missing) === JSON.stringify(['ghost-plugin']), JSON.stringify(result.missing))
  check('失败数为 0', result.failed === 0, `failed=${result.failed} ${result.errors.join(';')}`)

  const retained = listLocalMapKeys().sort()
  check(`本地留存 ${expectedPull} 份`, retained.length === expectedPull, retained.join(','))

  for (const key of keys) {
    const entry = index.plugins[key]
    const map = readLocalMap(key)
    const meta = readLocalMeta(key)
    check(`${key} 可读且条数一致`, map?.instructions.length === entry.command_count, `${map?.instructions.length} vs ${entry.command_count}`)
    check(`${key} 元信息版本对得上`, meta?.version === entry.version, `${meta?.version} vs ${entry.version}`)
    check(`${key} 元信息哈希对得上`, meta?.sha256 === entry.sha256)
  }

  flat = loadMapIndex()
  check(`拍平后条目数 = ${expectedEntries}`, flat.entries.length === expectedEntries, String(flat.entries.length))
  check(`拍平后有 ${expectedPull} 个插件`, flat.stats.plugins === expectedPull, String(flat.stats.plugins))

  const withRisk = flat.entries.filter(item => item.risk).length
  check('风险档全部带上', withRisk === flat.entries.length, `${withRisk}/${flat.entries.length}`)

  // 二次同步应当全部跳过（版本一致）
  const second = await syncPluginMaps({
    indexUrl: 'https://maps.test/index.json',
    fetchImpl: fakeFetch,
    plugins: installed.slice(0, -1)
  })
  check('二次同步不重复下载', second.updated === 0 && second.upToDate === expectedPull, `updated=${second.updated} upToDate=${second.upToDate}/${expectedPull}`)

  process.chdir(original)
  fs.rmSync(tmp, { recursive: true, force: true })
}

// 覆盖率对账：地图条数明显少于源码规则数时，多半是有整块漏写（阈值 10%）
const countsPath = path.join(path.dirname(DIST), 'maps-v2', '_rule-counts.json')
if (fs.existsSync(countsPath)) {
  const counts = JSON.parse(fs.readFileSync(countsPath, 'utf8'))
  const short = []
  for (const key of keys) {
    const expected = Number(counts[key])
    if (!expected) continue
    if (index.plugins[key].command_count < expected * 0.9) {
      short.push(`${key}(${index.plugins[key].command_count}/${expected})`)
    }
  }
  check('地图覆盖不低于源码规则的 90%', short.length === 0, short.join(', ') || `已对账 ${keys.length} 个插件`)
}

let failed = 0
for (const item of checks) {
  if (!item.ok) failed += 1
  console.log(`${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? `  (${item.detail})` : ''}`)
}
if (!canReachFrontend) {
  console.log(`\n跳过链路层：没找到 ${FRONTEND}（设 FRONTEND_REPO 指向前端仓库即可跑完整自检）`)
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
process.exit(failed ? 1 : 0)
