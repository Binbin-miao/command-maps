import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * 分类整理：把「一份份补丁」重排成「按插件包 + 用途标签」的索引，并生成两份报告。
 *
 * 只重排、不改补丁内容——补丁的 sha256 不动，下载方行为不受影响。
 */

const LOG_DIR = '/root/TRSS_AllBot/TRSS-Yunzai/logs'
const ROOT = '/tmp/command-maps'
const LINE_RE = /\[MARK\]\[[^\]]*\]\[(#[^\]]*)\]\[([^\]]*)\]/

/** 用途标签：命中关键词最多的那一类胜出，全不命中归「其他」 */
const CATEGORY_RULES = [
  ['游戏', ['原神', '星铁', '崩坏', '绝区零', '三角洲', '抽卡', '角色', '深渊', '图鉴', '米游社', '养成', '面板', '战绩', '队伍', '养成计算', 'genshin', 'miao', 'starRail', 'ZZZ', 'delta', 'zmd', 'yenai']],
  ['群管理', ['禁言', '踢', '撤回', '头衔', '欢迎', '公告', '黑名单', '白名单', '拉黑', '管理', '入群', '退群', '发言', '违禁']],
  ['工具', ['翻译', '图片', '搜索', '天气', '视频', '音乐', '下载', '解析', '短链', '二维码', '识别']],
  ['娱乐', ['运势', '表情', '复读', '梗', 'meme', '猜', '点歌', '笑话', '塔罗']],
  ['系统', ['system', 'other', '重启', '更新', '日志', '版本', '安装', '锅巴', 'trss', 'rconsole']]
]

function classify (text) {
  const haystack = String(text || '').toLowerCase()
  let best = { name: '其他', score: 0 }
  for (const [name, keywords] of CATEGORY_RULES) {
    let score = 0
    for (const keyword of keywords) {
      if (haystack.includes(keyword.toLowerCase())) score += 1
    }
    if (score > best.score) best = { name, score }
  }
  return best.name
}

// ---------- 日志：真实使用次数 ----------
// 按「指令词干」统计而不是插件类名：日志里的类名与能力表的 display 经常不一致（同一插件多个类、改名），
// 用词干匹配的覆盖率明显更高。
const usageByStem = new Map()
const stemOf = text => String(text || '').replace(/^[#＃/／]+/, '').split(/[\s，,、]/)[0].trim()
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
    const stem = stemOf(match[1])
    if (!stem) continue
    usageByStem.set(stem, (usageByStem.get(stem) || 0) + 1)
  }
}

// ---------- 现有索引 ----------
const indexPath = path.join(ROOT, 'index.json')
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
const plugins = index.plugins || {}

const packages = {}
const flat = []

for (const [pluginKey, entry] of Object.entries(plugins)) {
  const mapFile = path.join(ROOT, entry.file)
  let map = { commands: {} }
  try {
    map = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
  } catch {
    // 地图缺失时仍然保留索引条目，只少统计
  }
  const commands = Object.keys(map.commands || {})
  const used = commands.reduce((total, command) => total + (usageByStem.get(stemOf(command)) || 0), 0)
  const pkg = pluginKey.includes('/') ? pluginKey.split('/')[0] : pluginKey
  const category = classify(`${pkg} ${entry.display} ${commands.slice(0, 30).join(' ')}`)

  plugins[pluginKey] = { ...entry, package: pkg, category, used }

  if (!packages[pkg]) packages[pkg] = { display: pkg, category, units: [], command_count: 0, used: 0 }
  packages[pkg].units.push(pluginKey)
  packages[pkg].command_count += commands.length
  packages[pkg].used += used
  if (packages[pkg].category === '其他' && category !== '其他') packages[pkg].category = category

  flat.push({ pluginKey, display: entry.display, pkg, category, commands: commands.length, used })
}

index.packages = packages
index.updated = new Date().toISOString()
fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')

// ---------- 报告 ----------
flat.sort((a, b) => b.used - a.used || b.commands - a.commands)
const byCategory = {}
for (const row of flat) {
  byCategory[row.category] = byCategory[row.category] || { units: 0, commands: 0, used: 0 }
  byCategory[row.category].units += 1
  byCategory[row.category].commands += row.commands
  byCategory[row.category].used += row.used
}

const categories = [
  '# 分类总览',
  '',
  `- 插件包：${Object.keys(packages).length}，注册单位：${flat.length}，指令：${flat.reduce((total, row) => total + row.commands, 0)}`,
  '',
  '| 用途 | 注册单位 | 指令数 | 近一月调用 |',
  '| --- | --- | --- | --- |'
].concat(
  Object.entries(byCategory)
    .sort((a, b) => b[1].used - a[1].used)
    .map(([name, stat]) => `| ${name} | ${stat.units} | ${stat.commands} | ${stat.used} |`)
)
fs.writeFileSync(path.join(ROOT, 'reports', 'categories.md'), `${categories.join('\n')}\n`, 'utf8')

const usageReport = [
  '# 用量总览（近一个月日志）',
  '',
  `- 覆盖 ${usageByStem.size} 种指令词干，共 ${[...usageByStem.values()].reduce((a, b) => a + b, 0)} 次指令执行`,
  '',
  '## 最活跃的注册单位',
  '',
  '| 次数 | 指令数 | 用途 | 插件类 | 包 |',
  '| --- | --- | --- | --- | --- |'
].concat(
  flat.slice(0, 30).map(row => `| ${row.used} | ${row.commands} | ${row.category} | ${row.display} | ${row.pkg} |`)
)
fs.writeFileSync(path.join(ROOT, 'reports', 'usage.md'), `${usageReport.join('\n')}\n`, 'utf8')

console.log(JSON.stringify({
  packages: Object.keys(packages).length,
  units: flat.length,
  commands: flat.reduce((total, row) => total + row.commands, 0),
  topCategories: Object.entries(byCategory).sort((a, b) => b[1].used - a[1].used).slice(0, 5)
}, null, 2))
