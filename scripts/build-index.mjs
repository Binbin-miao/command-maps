import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

/**
 * 一次性生成脚本：把「运行时枚举 + 一个月日志」合成指令地图仓库。
 *
 * 输出 /tmp/command-maps：
 *   index.json              每份地图的指纹与 sha256
 *   maps/<pluginKey>.json   补丁：keys / args / ex / risk / interactive
 *   reports/usage.md         用量与「叫法差异」清单（给人看）
 */

const LOG_DIR = '/root/TRSS_AllBot/TRSS-Yunzai/logs'
const META = '/root/TRSS_AllBot/TRSS-Yunzai/data/chatgpt/capability/feature-form.meta.json'
const OUT = '/tmp/command-maps'

const LINE_RE = /\[MARK\]\[[^\]]*\]\[(#[^\]]*)\]\[([^\]]*)\]/

const normalize = text => String(text || '').normalize('NFKC').toLowerCase()
  .replace(/[\s\u3000，。！？、,.!?：:；;…·~～@#"“”‘’（）()【】[\]{}<>《》\-—_/\\|]/g, '')

const stripHash = text => String(text || '').replace(/^[#＃/／]+/, '').trim()

/** bigram dice，只用来把「用户叫法」挂到最近的指令上 */
function dice (a, b) {
  const grams = text => {
    const chars = [...normalize(text)]
    if (chars.length < 2) return new Set(chars)
    const out = new Set()
    for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1])
    return out
  }
  const left = grams(a)
  const right = grams(b)
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return (2 * shared) / (left.size + right.size)
}

// ---------- 1. 读日志 ----------
const usage = new Map() // `${pluginName}\u0000${command}` -> count
const byPlugin = new Map() // pluginName -> Map(command -> count)

for (const name of fs.readdirSync(LOG_DIR)) {
  if (!/^command\..*\.log(\.zst)?$/.test(name)) continue
  let text = ''
  try {
    const buffer = fs.readFileSync(path.join(LOG_DIR, name))
    text = name.endsWith('.zst') ? zlib.zstdDecompressSync(buffer).toString('utf8') : buffer.toString('utf8')
    text = text.replace(/\u001b\[[0-9;]*m/g, '')
  } catch {
    continue
  }
  for (const line of text.split('\n')) {
    if (!line.includes('[#')) continue
    const match = LINE_RE.exec(line)
    if (!match) continue
    const command = match[1].trim()
    const pluginName = match[2].replace(/\(.*$/, '').trim()
    usage.set(`${pluginName}\u0000${command}`, (usage.get(`${pluginName}\u0000${command}`) || 0) + 1)
    if (!byPlugin.has(pluginName)) byPlugin.set(pluginName, new Map())
    const bucket = byPlugin.get(pluginName)
    bucket.set(command, (bucket.get(command) || 0) + 1)
  }
}

// ---------- 2. 读能力表 ----------
const meta = JSON.parse(fs.readFileSync(META, 'utf8'))
const entries = meta.entries || []
const groups = new Map()
for (const entry of entries) {
  const key = entry.pluginKey || 'unknown'
  if (!groups.has(key)) groups.set(key, { key, plugin: entry.plugin, entries: [] })
  groups.get(key).entries.push(entry)
}

// ---------- 3. 生成补丁 ----------
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(path.join(OUT, 'maps'), { recursive: true })
fs.mkdirSync(path.join(OUT, 'reports'), { recursive: true })

const index = { schema: 1, updated: new Date().toISOString(), plugins: {} }
const usageReport = []
let mappedVariants = 0

for (const [pluginKey, group] of groups) {
  const commands = {}
  // 该插件在日志里出现过的写法（去掉括号里的方法名后与类名对齐）
  const observed = byPlugin.get(group.plugin) || new Map()

  for (const entry of group.entries) {
    const canonical = String(entry.command || '').trim()
    if (!canonical) continue

    // 基础关键词：写法本身（去井号）、描述、描述里的意群
    const keys = new Set()
    const bare = stripHash(canonical)
    if (bare) keys.add(bare)
    if (entry.description) keys.add(entry.description.slice(0, 30))

    // 日志里与这条指令最像的说法，直接收进 keys——这是真实用户语料，比 LLM 造词可靠
    let bestVariant = null
    let bestScore = 0
    for (const [text, count] of observed) {
      if (normalize(text) === normalize(canonical)) continue
      const score = dice(canonical, text)
      if (score > bestScore && score >= 0.34) {
        bestScore = score
        bestVariant = { text, count, score }
      }
    }
    if (bestVariant) {
      keys.add(bestVariant.text)
      mappedVariants += 1
    }

    const hit = usage.get(`${group.plugin}\u0000${canonical}`) || 0
    commands[canonical] = {
      keys: [...keys].filter(Boolean).slice(0, 12),
      args: {},
      ex: canonical,
      risk: entry.permission ? 'w' : 'q',
      interactive: false,
      // 统计字段：地图消费方会忽略，但人看报告有用
      used: hit
    }
    if (hit) usageReport.push({ plugin: group.plugin, command: canonical, count: hit })
  }

  const fingerprint = crypto.createHash('sha1').update(Object.keys(commands).sort().join('\n')).digest('hex').slice(0, 12)
  const patch = { schema: 1, plugin: { key: pluginKey, fingerprint, updated: index.updated }, commands }
  const text = `${JSON.stringify(patch, null, 2)}\n`
  // pluginKey 可能是 `system/botOperate.js` 这种带路径的注册单位，落成文件名要先压平
  const file = `maps/${pluginKey.replace(/[\\/]+/g, '__')}.json`
  fs.writeFileSync(path.join(OUT, file), text, 'utf8')

  index.plugins[pluginKey] = {
    display: group.plugin,
    file,
    fingerprint,
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(text),
    command_count: Object.keys(commands).length
  }
}

fs.writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')

// ---------- 4. 报告 ----------
usageReport.sort((a, b) => b.count - a.count)
const report = [
  '# 用量与叫法差异',
  '',
  `- 插件数：${groups.size}，指令数：${entries.length}`,
  `- 日志里出现过的写法：${[...byPlugin.values()].reduce((total, bucket) => total + bucket.size, 0)} 种`,
  `- 挂到指令上的用户叫法：${mappedVariants} 条`,
  '',
  '## 最常用的指令（近一个月）',
  ''
].concat(usageReport.slice(0, 30).map(row => `- ${row.count} 次 \`${row.command}\`（${row.plugin}）`))
fs.writeFileSync(path.join(OUT, 'reports', 'usage.md'), `${report.join('\n')}\n`, 'utf8')

console.log(JSON.stringify({
  plugins: groups.size,
  commands: entries.length,
  mappedVariants,
  hotCommands: usageReport.length,
  totalBytes: Object.values(index.plugins).reduce((total, item) => total + item.bytes, 0)
}, null, 2))
