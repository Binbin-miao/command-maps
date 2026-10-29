import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 批量跑 probe-loader：一次枚举整个 Yunzai 装的所有插件。
 *
 * 中间产物一律落在系统临时目录，进程退出（正常 / Ctrl-C / 超时被杀）都会删干净。
 * 之前是手工 for 循环把 JSON 写进 Yunzai 根目录，跑完忘了删就留下一堆 `_probe/`。
 *
 * 用法：node scripts/probe-all.mjs [--root <Yunzai根>] [--out <文件>] [插件名...]
 *
 * 输出约定：
 *   stdout —— 只有结果 JSON（一个数组），可以安全地重定向到文件
 *    stderr —— 进度与清理提示，混进去不影响结果解析
 */

const argv = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}

const ROOT = path.resolve(valueOf('root', process.env.YUNZAI_ROOT || '/root/TRSS_AllBot/TRSS-Yunzai'))
const OUT = valueOf('out', '')
const ONLY = argv.filter((item, index) => !item.startsWith('--') && !argv[index - 1]?.startsWith('--'))

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOADER = path.join(HERE, 'probe-loader.mjs')
/** 单个插件最多跑这么久，卡死的插件不能拖住整批 */
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 90_000

const pluginsDir = path.join(ROOT, 'plugins')
if (!fs.existsSync(pluginsDir)) {
  console.error(`找不到插件目录：${pluginsDir}`)
  process.exit(1)
}

const targets = ONLY.length
  ? ONLY
  : fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort()

if (!targets.length) {
  console.error(`${pluginsDir} 下没有插件`)
  process.exit(1)
}

// 临时目录只用来接每次探针的 stdout，跑完立刻整个删掉
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'map-probe-'))
let cleaned = false

/** 幂等清理：exit 和信号回调都会进来，重复调用无害 */
function cleanup () {
  if (cleaned) return
  cleaned = true
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (err) {
    // 清理失败不该盖掉探针结果，只在 stderr 留一句
    console.error(`临时目录清理失败（${tmp}）：${err.message}`)
  }
}

// exit 覆盖正常结束与 process.exit；三个信号覆盖 Ctrl-C / kill / 关终端
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    console.error(`\n收到 ${signal}，清掉临时目录后退出`)
    cleanup()
    process.exit(130)
  })
}

const runOne = key => new Promise(resolve => {
  const file = path.join(tmp, `${key}.json`)
  const child = execFile(
    process.execPath,
    [LOADER, key],
    { env: { ...process.env, YUNZAI_ROOT: ROOT }, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    err => {
      if (err) {
        const reason = err.killed ? `超时（>${TIMEOUT_MS}ms）` : (err.message || String(err))
        resolve({ key, ok: false, error: reason })
        return
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        resolve({ key, ok: true, data: parsed })
      } catch (readErr) {
        resolve({ key, ok: false, error: `读不出结果：${readErr.message}` })
      }
    }
  )
  // 探针自己的 stdout 落到临时文件，别和最终的汇总混在一起
  child.stdout.pipe(fs.createWriteStream(file))
  child.stderr.resume()
})

const results = []
for (const key of targets) {
  console.error(`探针 ${key} …`)
  results.push(await runOne(key))
}

const failed = results.filter(item => !item.ok)
const totalRules = results.reduce((sum, item) => sum + (item.ok ? item.data.totalRules : 0), 0)
const payload = results.map(item => (item.ok ? item.data : { key: item.key, error: item.error }))

const text = JSON.stringify(payload, null, 2) + '\n'
if (OUT) {
  fs.writeFileSync(OUT, text, 'utf8')
  console.error(`已写 ${OUT}`)
} else {
  process.stdout.write(text)
}

console.error(`\n${results.length} 个插件 ｜ 规则 ${totalRules} 条 ｜ 失败 ${failed.length} 个`)
for (const item of failed) console.error(`  ! ${item.key}: ${item.error}`)

cleanup()
