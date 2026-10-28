// 反查地图里每条 command / alias 是否真能命中源码里的 reg
// 用法：node scripts/check-map-commands.mjs <地图名> <源码目录>
// 例：node scripts/check-map-commands.mjs StarRail-plugin ../_plugins_src/StarRail-plugin
import fs from 'node:fs'
import path from 'node:path'

const mapKey = process.argv[2]
const srcDir = process.argv[3]
if (!mapKey || !srcDir) {
  console.error('用法: node scripts/check-map-commands.mjs <地图名> <源码目录>')
  process.exit(2)
}

// 各插件的前缀常量（拿不到就从源码里抓 rulePrefix 的定义）
function readPrefixes(dir) {
  const found = []
  const walk = d => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) {
        if (['node_modules', '.git', 'dist'].includes(f.name)) continue
        walk(p)
      } else if (f.name.endsWith('.js')) {
        const t = fs.readFileSync(p, 'utf8')
        const m = t.match(/rulePrefix\s*=\s*'((?:[^'\\]|\\.)*)'/)
        if (m) found.push(m[1].replace(/\\\\/g, '\\'))
      }
    }
  }
  walk(dir)
  return [...new Set(found)]
}

const prefixes = readPrefixes(srcDir)
const regs = []
const walk = d => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name)
    if (f.isDirectory()) {
      if (['node_modules', '.git'].includes(f.name)) continue
      walk(p)
    } else if (f.name.endsWith('.js')) {
      const t = fs.readFileSync(p, 'utf8')
      // 字符串 / 模板字面量形式：reg: '...'  reg: `...`
      const re = /reg:\s*(`[^`]*`|'[^']*'|"[^"]*")/g
      let m
      while ((m = re.exec(t))) {
        let s = m[1].slice(1, -1).replace(/\\\\/g, '\\')
        for (const pf of prefixes) s = s.split('${rulePrefix}').join(pf)
        // 剩下的 ${...} 是运行时拼进来的变量：字符类里的当成「任意一个字符」，其它当成 .*
        // 只能近似校验，但比整条判死强
        s = s.replace(/\[\$\{[^}]*\}\]/g, '[^]').replace(/\$\{[^}]*\}/g, '.*')
        regs.push(s)
      }
      // 正则字面量形式：reg: /^#绑定ck$/i
      const re2 = /reg:\s*\/((?:\\.|\[[^\]]*\]|[^/\\])+)\/[gimsuy]*/g
      while ((m = re2.exec(t))) regs.push(m[1])
    }
  }
}
walk(srcDir)

const map = JSON.parse(fs.readFileSync(`maps-v2/${mapKey}.json`, 'utf8'))
let bad = 0
let warn = 0
let checked = 0
for (const it of map.instructions) {
  // pitfalls 里明写了「插件 bug」的条目，指令本身就是打不通的，只提示不计错
  const knownBroken = JSON.stringify(it.pitfalls || []).includes('插件 bug')
  for (const cmd of [it.command, ...(it.aliases || [])]) {
    if (!cmd) continue
    // 「（私聊直接粘贴 Cookie）」这类是操作描述，不是可输入的指令，跳过
    if (cmd.startsWith('（') || cmd.startsWith('(')) continue
    checked++
    const hit = regs.some(r => {
      try { return new RegExp(r).test(cmd) } catch { return false }
    })
    if (!hit) {
      if (knownBroken) { warn++; console.log('⚠', it.id, '=>', cmd, '（已在 pitfalls 标注插件 bug）') }
      else { bad++; console.log('✗', it.id, '=>', cmd) }
    }
  }
}
console.log(`${mapKey}: 校验 ${checked} 条写法，命中失败 ${bad} 条，已知 bug ${warn} 条`)
process.exit(bad ? 1 : 0)
