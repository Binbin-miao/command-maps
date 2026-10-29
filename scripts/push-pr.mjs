#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 用 GitHub Data API 建分支 + 提交 + 开 PR。
 *
 * 什么时候用它：本机 `git push` 到 github.com 不通（超时 / 连接被重置），
 * 但 api.github.com 还能走的时候。走的是 blob → tree → commit → ref → PR 五步，
 * 不依赖本地 remote 配置，也不会动工作区。
 *
 * 凭据只从环境变量来，代码里不出现任何本机路径：
 *   export GITHUB_TOKEN=ghp_xxx
 *   # 或者把 token 存在文件里，指过去
 *   export GITHUB_TOKEN_FILE=~/.config/gh/token
 *
 * 用法：
 *   node scripts/push-pr.mjs --branch feat/map-xxx --title "..." --body-file _push/body-xxx.md
 *   可选：--base main  --repo owner/name  --message "提交信息"
 *        --only maps-v2/miao-plugin.json,dist/index.json   （按路径片段过滤要提交的文件）
 *        --dry                                             （只列文件，不调接口）
 */

const argv = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}
const has = name => argv.includes(`--${name}`)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const BASE = valueOf('base', 'main')
const BRANCH = valueOf('branch', '')
const REPO = valueOf('repo', process.env.GITHUB_REPO || 'Binbin-miao/command-maps')
const TITLE = valueOf('title', '')
const BODY_FILE = valueOf('body-file', '')
const MESSAGE = valueOf('message', valueOf('title', ''))
const ONLY = valueOf('only', '')
const DRY = has('dry')
const API = 'https://api.github.com'
/** 非 dry 时在动网络之前就验一遍，缺凭据直接说清楚 */
let TOKEN = ''

/** 默认要提交的东西：地图、索引、脚本、CI 配置 */
const PATTERNS = [
  'README.md',
  'maps-v2/*.json',
  'dist/index.json',
  'dist/maps/*.json',
  'scripts/*.mjs',
  '.github/workflows/*.yml',
  '.githooks/*'
]

/** 凭据：环境变量优先，其次文件；都没有就明确说清楚怎么给，不要抛栈 */
function readToken () {
  const direct = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (direct?.trim()) return direct.trim()

  const file = process.env.GITHUB_TOKEN_FILE
  if (file) {
    const full = file.startsWith('~') ? path.join(process.env.HOME || process.env.USERPROFILE || '', file.slice(1)) : file
    try {
      const token = fs.readFileSync(full, 'utf8').trim()
      if (token) return token
      fail(`凭据文件是空的：${full}`)
    } catch (err) {
      fail(`读不到凭据文件 ${full}：${err.message}`)
    }
  }

  fail([
    '缺少 GitHub 凭据。二选一：',
    '  export GITHUB_TOKEN=ghp_xxx        # 直接给 token（需要 repo 权限）',
    '  export GITHUB_TOKEN_FILE=<文件>    # 文件里放 token',
    '只做本地检查可以加 --dry，不调任何接口。'
  ].join('\n'))
}

function fail (message) {
  console.error(message)
  process.exit(1)
}

/** 展开通配，返回仓库内相对路径 */
function collect () {
  const out = []
  for (const pattern of PATTERNS) {
    const dir = path.join(ROOT, path.dirname(pattern))
    const base = path.basename(pattern)
    if (!fs.existsSync(dir)) continue
    const isGlob = base.includes('*')
    const re = isGlob ? new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$') : null
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (re ? !re.test(entry.name) : entry.name !== base) continue
      out.push(path.relative(ROOT, path.join(dir, entry.name)).replace(/\\/g, '/'))
    }
  }
  return [...new Set(out)].sort()
}

async function api (method, url, payload, { expect = [200, 201], retries = 3 } = {}) {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  for (let attempt = 0; attempt < retries; attempt++) {
    let response
    try {
      response = await fetch(`${API}${url}`, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body
      })
    } catch (err) {
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)))
        continue
      }
      throw new Error(`${method} ${url} 请求失败：${err.message}`)
    }

    const text = await response.text()
    if (expect.includes(response.status)) return text ? JSON.parse(text) : {}
    if (response.status >= 500 && attempt < retries - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)))
      continue
    }
    throw new Error(`${method} ${url} -> ${response.status}: ${text.slice(0, 500)}`)
  }
  throw new Error(`${method} ${url} 重试耗尽`)
}

async function main () {
  if (!BRANCH) fail('缺 --branch，例如 --branch feat/map-miao-plugin')

  let files = collect()
  if (ONLY) {
    const wants = ONLY.split(',').map(item => item.trim()).filter(Boolean)
    files = files.filter(file => wants.some(want => file.includes(want)))
  }
  if (!files.length) fail('没有要提交的文件（检查 --only 或目录结构）')

  console.log(`仓库 ${REPO} ｜ 目标分支 ${BRANCH} ← ${BASE}`)
  for (const file of files) console.log(`  ${file}`)

  if (DRY) {
    console.log(`\n--dry：只列了 ${files.length} 个文件，没有调任何接口。`)
    return
  }

  TOKEN = readToken()

  console.log(`\n[1/5] 读 ${BASE} 的 HEAD`)
  const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${BASE}`)
  const parent = ref.object.sha
  console.log(`      parent = ${parent}`)

  console.log('[2/5] 上传 blob')
  const tree = []
  for (const file of files) {
    const raw = fs.readFileSync(path.join(ROOT, file))
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: raw.toString('base64'),
      encoding: 'base64'
    })
    tree.push({ path: file, mode: file.startsWith('.githooks/') ? '100755' : '100644', type: 'blob', sha: blob.sha })
    console.log(`      ${file}  ${(raw.length / 1024).toFixed(1)} KB  ${blob.sha.slice(0, 10)}`)
  }

  console.log('[3/5] 建 tree + commit')
  const newTree = await api('POST', `/repos/${REPO}/git/trees`, { base_tree: parent, tree })
  const commit = await api('POST', `/repos/${REPO}/git/commits`, {
    message: MESSAGE,
    tree: newTree.sha,
    parents: [parent]
  })
  console.log(`      commit = ${commit.sha.slice(0, 12)}`)

  console.log(`[4/5] 建分支 ${BRANCH}`)
  try {
    await api('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha })
    console.log('      分支已创建')
  } catch (err) {
    if (!/422|already exists/.test(err.message)) throw err
    await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true })
    console.log('      分支已存在，已快进')
  }

  console.log('[5/5] 开 PR')
  const body = BODY_FILE ? fs.readFileSync(path.resolve(ROOT, BODY_FILE), 'utf8') : ''
  try {
    const pr = await api('POST', `/repos/${REPO}/pulls`, {
      title: TITLE || MESSAGE,
      head: BRANCH,
      base: BASE,
      body
    })
    console.log(`      PR #${pr.number} -> ${pr.html_url}`)
  } catch (err) {
    if (!/422/.test(err.message)) throw err
    console.log('      该分支已有 PR，列出未合并的：')
    const prs = await api('GET', `/repos/${REPO}/pulls?head=${REPO.split('/')[0]}:${BRANCH}&state=open`)
    for (const pr of prs) console.log(`      PR #${pr.number} -> ${pr.html_url}`)
  }
}

main().catch(err => {
  // 默认只打一行，不给用户看栈；排查时 DEBUG=1 再看
  console.error(`\n失败：${err.message}`)
  if (process.env.DEBUG) console.error(err.stack)
  process.exit(1)
})
