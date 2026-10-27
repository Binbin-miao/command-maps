import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * 一次性统计脚本：把最近一个月的 command 日志读全，回答两件事——
 *   1. 用户最常用哪些指令；
 *   2. 用户实际打出来的写法里，哪些与「注册写法」不一致（= 常见写歪/别名），
 *      这些正是地图补丁最该收进 keys 的东西。
 */

const LOG_DIR = '/root/TRSS_AllBot/TRSS-Yunzai/logs'
const META = '/root/TRSS_AllBot/TRSS-Yunzai/data/chatgpt/capability/feature-form.meta.json'

const LINE_RE = /\[MARK\]\[[^\]]*\]\[(#[^\]]*)\]\[([^\]]*)\]/

function normalize (text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\u3000，。！？、,.!?：:；;…·~～@#"“”‘’（）()【】[\]{}<>《》\-—_/\\|]/g, '')
}

const raw = new Map()
const days = new Set()
let total = 0

for (const name of fs.readdirSync(LOG_DIR)) {
  if (!/^command\..*\.log(\.zst)?$/.test(name)) continue
  const day = (name.match(/command\.(\d{4}-\d{2}-\d{2})/) || [])[1] || ''
  const full = path.join(LOG_DIR, name)
  let text = ''
  try {
    const buffer = fs.readFileSync(full)
    text = name.endsWith('.zst') ? zlib.zstdDecompressSync(buffer).toString('utf8') : buffer.toString('utf8')
    // 日志带 ANSI 颜色码，段与段之间夹着转义序列，不先剥掉就匹配不到
    text = text.replace(/\u001b\[[0-9;]*m/g, '')
  } catch {
    continue
  }
  days.add(day)
  for (const line of text.split('\n')) {
    if (!line.includes('[#')) continue
    const match = LINE_RE.exec(line)
    if (!match) continue
    total += 1
    const command = match[1].trim()
    const plugin = match[2].trim()
    const key = `${command}\u0000${plugin}`
    const record = raw.get(key) || { command, plugin, count: 0 }
    record.count += 1
    raw.set(key, record)
  }
}

const meta = JSON.parse(fs.readFileSync(META, 'utf8'))
const canonical = new Set((meta.entries || []).map(entry => normalize(entry.command)).filter(Boolean))

const rows = [...raw.values()].sort((a, b) => b.count - a.count)
const canonicalList = [...canonical].filter(item => item.length >= 2).sort((a, b) => b.length - a.length)

/**
 * 三分类：完全一致 / 指令+参数（注册写法是它的前缀）/ 认不出来（别名或错字）
 */
function classify (command) {
  const key = normalize(command)
  if (canonical.has(key)) return 'exact'
  for (const candidate of canonicalList) {
    if (key.startsWith(candidate)) return 'withArgs'
  }
  return 'unknown'
}

for (const row of rows) row.kind = classify(row.command)
const exact = rows.filter(row => row.kind === 'exact')
const withArgs = rows.filter(row => row.kind === 'withArgs')
const unknown = rows.filter(row => row.kind === 'unknown')

console.log(JSON.stringify({
  files: days.size,
  days: [...days].sort().slice(0, 3).concat(['...']).concat([...days].sort().slice(-3)),
  executions: total,
  distinct: rows.length,
  kindCounts: { exact: exact.length, withArgs: withArgs.length, unknown: unknown.length },
  exactTop: exact.slice(0, 20).map(row => ({ c: row.command.slice(0, 40), p: row.plugin.slice(0, 26), n: row.count })),
  withArgsTop: withArgs.slice(0, 15).map(row => ({ c: row.command.slice(0, 50), p: row.plugin.slice(0, 22), n: row.count })),
  unknownTop: unknown.slice(0, 40).map(row => ({ c: row.command.slice(0, 50), p: row.plugin.slice(0, 22), n: row.count })),
  knownCommands: canonical.size
}, null, 2))
