#!/usr/bin/env node
/**
 * 给地图补丁和索引写版本号（revision）。
 *
 * 为什么需要它：下载方要能「花一次请求」判断云端有没有新版。指纹只看写法集合，
 * keys 改了它不变；sha256 要下全文才能比。revision 是个整数，拉个几 KB 的索引
 * 比一下大小就够。
 *
 * 判定规则（不需要额外记账）：
 *   文件缺 revision            → 当它是新补丁，分配 base + 1
 *   index 记录的 sha256 与当前文件字节不符 → 内容变了，revision + 1
 *   两者都不成立              → 没动过，保持原样
 *
 * 顺序很关键：先定 revision 写回文件，再用**写回后的字节**重算 sha256/bytes 写进
 * 索引。反过来的话，改 revision 会立刻让哈希失效，永远收敛不了。
 *
 * 幂等：连跑两次，第二次不会有任何文件变动。
 *
 * 用法：node scripts/bump-revision.mjs [--dry-run]
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const INDEX_PATH = path.join(ROOT, 'index.json')
const DRY_RUN = process.argv.includes('--dry-run')

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'))
if (!index.plugins || typeof index.plugins !== 'object') {
  console.error('index.json 里没有 plugins，先跑 build-index.mjs')
  process.exit(1)
}

const base = Number(index.revision) || 0
const bumps = []
let touched = 0

for (const [pluginKey, entry] of Object.entries(index.plugins)) {
  const file = typeof entry?.file === 'string' ? entry.file : ''
  if (!file) continue
  const target = path.join(ROOT, file)

  let text
  try {
    text = fs.readFileSync(target, 'utf8')
  } catch {
    console.warn(`跳过 ${pluginKey}：读不到 ${file}`)
    continue
  }

  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    console.warn(`跳过 ${pluginKey}：${file} 不是合法 JSON`)
    continue
  }
  raw.plugin = raw.plugin && typeof raw.plugin === 'object' ? raw.plugin : {}

  const previous = Number(raw.plugin.revision) || 0
  const currentSha = sha256(text)
  const declared = typeof entry.sha256 === 'string' ? entry.sha256 : ''
  // 缺版本号（老补丁）或索引里的哈希对不上（内容被改过）都算「这次要发新版」
  const needsBump = !previous || declared !== currentSha
  if (!needsBump) {
    if (entry.revision !== previous || entry.sha256 !== currentSha) {
      index.plugins[pluginKey] = { ...entry, revision: previous, sha256: currentSha, bytes: Buffer.byteLength(text) }
    }
    continue
  }

  const next = previous ? previous + 1 : base + 1
  raw.plugin.revision = next
  const nextText = `${JSON.stringify(raw, null, 2)}\n`

  if (!DRY_RUN) fs.writeFileSync(target, nextText, 'utf8')

  index.plugins[pluginKey] = {
    ...entry,
    revision: next,
    sha256: sha256(nextText),
    bytes: Buffer.byteLength(nextText)
  }
  bumps.push(`${pluginKey} → ${next}`)
  touched += 1
}

const nextIndexRevision = Math.max(base, 1, ...Object.values(index.plugins).map(item => Number(item?.revision) || 0))
index.revision = nextIndexRevision

if (!DRY_RUN) fs.writeFileSync(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8')

console.log(`${DRY_RUN ? '[dry-run] ' : ''}索引版本 ${base} → ${nextIndexRevision}，变动 ${touched} 份`)
for (const line of bumps.slice(0, 20)) console.log(`  ${line}`)
if (bumps.length > 20) console.log(`  …另 ${bumps.length - 20} 份`)
