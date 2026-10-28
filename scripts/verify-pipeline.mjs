import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 端到端验证：用 chatgpt-plugin 的真实拉取代码，从生成好的 dist/ 拉一次。
 *
 * 网络换成「把 https://maps.test/<path> 映射到 dist/<path>」的假 fetch，
 * 其余全是真的：哈希校验、落盘、元信息、读取。这样能验证发布链路而不碰外网。
 */

const DIST = path.resolve('dist')
const FRONTEND = process.env.FRONTEND_REPO ||
  'C:/Users/21052/WorkBuddy/2026-10-08-05-41-43/参考仓库/chatgpt-plugin-cloud'

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

const index = JSON.parse(fs.readFileSync(path.join(DIST, 'index.json'), 'utf8'))
const expectedPull = Object.keys(index.plugins).length
const installed = Object.keys(index.plugins).map(key => ({ key, version: index.plugins[key].version }))
// 故意多给一个云端没有的插件，验证缺失清单
installed.push({ key: 'ghost-plugin', version: '9.9.9' })

const result = await syncPluginMaps({
  indexUrl: 'https://maps.test/index.json',
  fetchImpl: fakeFetch,
  plugins: installed
})

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok, detail })

check('拉取成功数', result.updated === expectedPull, `updated=${result.updated}/${expectedPull}`)
check('缺失清单只含云端没有的那个', JSON.stringify(result.missing) === JSON.stringify(['ghost-plugin']), JSON.stringify(result.missing))
check('失败数为 0', result.failed === 0, `failed=${result.failed} ${result.errors.join(';')}`)

const retained = listLocalMapKeys().sort()
check(`本地留存 ${expectedPull} 份`, retained.length === expectedPull, retained.join(','))

for (const [key, entry] of Object.entries(index.plugins)) {
  const map = readLocalMap(key)
  const meta = readLocalMeta(key)
  check(`${key} 可读且条数一致`, map?.instructions.length === entry.command_count, `${map?.instructions.length} vs ${entry.command_count}`)
  check(`${key} 元信息版本对得上`, meta?.version === entry.version, `${meta?.version} vs ${entry.version}`)
  check(`${key} 元信息哈希对得上`, meta?.sha256 === entry.sha256)
}

const flat = loadMapIndex()
const expectedEntries = Object.values(index.plugins).reduce((sum, item) => sum + item.command_count, 0)
const expectedPlugins = Object.keys(index.plugins).length
check(`拍平后条目数 = ${expectedEntries}`, flat.entries.length === expectedEntries, String(flat.entries.length))
check(`拍平后有 ${expectedPlugins} 个插件`, flat.stats.plugins === expectedPlugins, String(flat.stats.plugins))

const withRisk = flat.entries.filter(item => item.risk).length
check('风险档全部带上', withRisk === flat.entries.length, `${withRisk}/${flat.entries.length}`)

// 覆盖率对账：地图条数明显少于源码规则数时，多半是有整块漏写（阈值 10%）
const countsPath = path.join(path.dirname(DIST), 'maps-v2', '_rule-counts.json')
if (fs.existsSync(countsPath)) {
  const counts = JSON.parse(fs.readFileSync(countsPath, 'utf8'))
  const short = []
  for (const [key, entry] of Object.entries(index.plugins)) {
    const expected = Number(counts[key])
    if (!expected) continue
    if (entry.command_count < expected * 0.9) {
      short.push(`${key}(${entry.command_count}/${expected})`)
    }
  }
  check('地图覆盖不低于源码规则的 90%', short.length === 0, short.join(', ') || `已对账 ${Object.keys(index.plugins).length} 个插件`)
}

// 二次同步应当全部跳过（版本一致）
const second = await syncPluginMaps({
  indexUrl: 'https://maps.test/index.json',
  fetchImpl: fakeFetch,
  plugins: installed.slice(0, -1)
})
check('二次同步不重复下载', second.updated === 0 && second.upToDate === expectedPull, `updated=${second.updated} upToDate=${second.upToDate}/${expectedPull}`)

process.chdir(original)
fs.rmSync(tmp, { recursive: true, force: true })

let failed = 0
for (const item of checks) {
  if (!item.ok) failed += 1
  console.log(`${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? `  (${item.detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
process.exit(failed ? 1 : 0)
