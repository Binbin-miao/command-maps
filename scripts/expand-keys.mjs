import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * keys 扩写：给热门指令补「用户会怎么说」的口语语料。
 *
 * 只扩 keys，不碰写法与风险档——`keys` 是本地匹配器的语料，写多少都不花运行时 token；
 * 真正花 token 的是这一步本身（每条一次请求），所以默认只处理用量最高的若干条。
 *
 * 用法（在 Yunzai 容器或任意有网机器上）：
 *   LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... \
 *   node scripts/expand-keys.mjs --root /tmp/command-maps --meta .../feature-form.meta.json --limit 100
 *
 * 先看要花多少：
 *   ... --dry-run
 */

const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const valueOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const ROOT = valueOf('root', '/tmp/command-maps')
const META = valueOf('meta', '/root/TRSS_AllBot/TRSS-Yunzai/data/chatgpt/capability/feature-form.meta.json')
const LIMIT = Number(valueOf('limit', '100'))
const MIN_USED = Number(valueOf('min-used', '1'))
const DRY_RUN = flag('dry-run')
const MAX_KEYS = 25

const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
const API_KEY = process.env.LLM_API_KEY || ''
const MODEL = process.env.LLM_MODEL || ''

if (!DRY_RUN && (!API_KEY || !MODEL)) {
  console.error('缺少 LLM_API_KEY / LLM_MODEL；先用 --dry-run 看提示词。')
  process.exit(1)
}

const indexPath = path.join(ROOT, 'index.json')
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))

// 描述来自能力表（补丁里没有 what，这是刻意的）
const descriptions = new Map()
try {
  const meta = JSON.parse(fs.readFileSync(META, 'utf8'))
  for (const entry of meta.entries || []) {
    if (entry.pluginKey && entry.command) descriptions.set(`${entry.pluginKey}\u0000${entry.command}`, entry.description || '')
  }
} catch {
  console.warn('读不到能力表，描述留空（提示词质量会下降）')
}

/** 收集待扩写的目标 */
const targets = []
for (const [pluginKey, entry] of Object.entries(index.plugins)) {
  const file = path.join(ROOT, entry.file)
  let map
  try {
    map = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    continue
  }
  for (const [command, value] of Object.entries(map.commands || {})) {
    if ((value.used || 0) < MIN_USED) continue
    targets.push({ pluginKey, file, command, value, description: descriptions.get(`${pluginKey}\u0000${command}`) || '' })
  }
}

targets.sort((a, b) => (b.value.used || 0) - (a.value.used || 0))
const picked = targets.slice(0, LIMIT)

console.log(`候选 ${targets.length} 条，本次处理 ${picked.length} 条（used ≥ ${MIN_USED}）`)

function buildPrompt (item) {
  return [
    '你是 Yunzai 机器人群聊用户。给你一条插件指令（信息来自作者手写的帮助文档）：',
    '',
    `指令模板：${item.command}`,
    `作者描述：${item.description || '（无）'}`,
    `参数说明：${JSON.stringify(item.value.args || {})}`,
    `同类指令（避免混淆）：${Object.keys(JSON.parse(fs.readFileSync(item.file, 'utf8')).commands).filter(name => name !== item.command).slice(0, 6).join('、')}`,
    '',
    '请生成 15 条「群友会怎么用自然语言说出这个需求」的句子，要求：',
    '1. 4~6 条短词（2~4 字）',
    '2. 6~8 条完整口语长句（10~20 字），带 @机器人 的语气',
    '3. 3~4 条带参数值的（把可能的参数写进去）',
    '4. 2 条同义替换（换动词：查/看/瞅/算/给我）',
    '5. 不要出现「指令」「插件」这类元词',
    '6. 不要编造指令不存在的能力',
    '7. 不要生成与同类指令高度重叠的句子（防止召回撞车）',
    '',
    '只输出 JSON 数组，不要解释。'
  ].join('\n')
}

async function askModel (prompt) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }]
    })
  })
  if (!response.ok) throw new Error(`模型返回 ${response.status}`)
  const data = await response.json()
  const text = data.choices?.[0]?.message?.content || ''
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('模型输出不是 JSON 数组')
  const list = JSON.parse(text.slice(start, end + 1))
  return Array.isArray(list) ? list.filter(item => typeof item === 'string' && item.trim()) : []
}

if (DRY_RUN) {
  if (picked[0]) console.log(`\n=== 示例提示词（${picked[0].command}）===\n${buildPrompt(picked[0])}`)
  console.log(`\n预计请求 ${picked.length} 次，输入约 ${picked.length * 600} token`)
  process.exit(0)
}

const touched = new Map() // file -> map
let ok = 0
const failed = []

for (const item of picked) {
  try {
    const extra = await askModel(buildPrompt(item))
    if (!extra.length) throw new Error('模型没有给出可用说法')

    const map = touched.get(item.file) || JSON.parse(fs.readFileSync(item.file, 'utf8'))
    const existing = new Set((item.command in map.commands ? map.commands[item.command].keys : []) || [])
    for (const key of extra) {
      if (existing.size >= MAX_KEYS) break
      existing.add(key.trim())
    }
    map.commands[item.command].keys = [...existing]
    touched.set(item.file, map)
    ok += 1
    console.log(`  ✓ ${item.command} (+${extra.length})`)
  } catch (err) {
    failed.push(`${item.command}: ${err.message}`)
  }
}

// 回写补丁 + 重算指纹与哈希
for (const [file, map] of touched) {
  const commands = map.commands
  const fingerprint = crypto.createHash('sha1').update(Object.keys(commands).sort().join('\n')).digest('hex').slice(0, 12)
  map.plugin.fingerprint = fingerprint
  map.plugin.updated = new Date().toISOString()
  const text = `${JSON.stringify(map, null, 2)}\n`
  fs.writeFileSync(file, text, 'utf8')

  const pluginKey = Object.entries(index.plugins).find(([, entry]) => path.join(ROOT, entry.file) === file)?.[0]
  if (pluginKey) {
    index.plugins[pluginKey].fingerprint = fingerprint
    index.plugins[pluginKey].sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex')
    index.plugins[pluginKey].bytes = Buffer.byteLength(text)
  }
}

index.updated = new Date().toISOString()
fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')

console.log(`\n完成 ${ok} 条，失败 ${failed.length} 条`)
if (failed.length) console.log(failed.slice(0, 5).join('\n'))
console.log('记得把改动过的 maps/*.json 与 index.json 重新上传。')
