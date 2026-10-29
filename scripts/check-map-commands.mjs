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

// 有的插件不用 rulePrefix，而是导出 PREFIX = { tajiduo: '...', huanta: '...' }
// 这里把对象里的键值也抓出来，供 ${PREFIX.xxx} 替换
function readPrefixObject(dir) {
  const out = {}
  const walk = d => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) {
        if (['node_modules', '.git', 'dist'].includes(f.name)) continue
        walk(p)
      } else if (f.name.endsWith('.js')) {
        const t = fs.readFileSync(p, 'utf8')
        const obj = t.match(/(?:export\s+)?const\s+PREFIX\s*=\s*\{([\s\S]*?)\}/)
        if (!obj) continue
        const re = /(\w+)\s*:\s*(['"`])((?:\\.|(?!\2).)*)\2/g
        let m
        while ((m = re.exec(obj[1]))) out[m[1]] = m[3].replace(/\\\\/g, '\\')
      }
    }
  }
  walk(dir)
  return out
}

const prefixMap = readPrefixObject(srcDir)
const regs = []

/**
 * 有些插件用字面量对象拼正则：
 *   const music_reg = '^#?(' + Object.keys(music_source).join('|') + ')?(点歌|点播)...'
 * 这里把同文件里扁平 `{ '键': 值, ... }` 的键拼回去，并把整条单行字符串拼接求值。
 * 不做这步，这类正则整条都会被判成「不匹配」（xiaofei 的点歌 21 条就是这么来的）。
 */
const evalConcatConsts = t => {
  const tables = {}
  const ro = /(?:const|let|var)\s+(\w+)\s*=\s*\{([^{}]*)\}/g
  let mo
  while ((mo = ro.exec(t))) {
    const keys = []
    const rk = /(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g
    let mk
    while ((mk = rk.exec(mo[2]))) keys.push(mk[1] || mk[2] || mk[3])
    if (keys.length) tables[mo[1]] = Object.fromEntries(keys.map(k => [k, k]))
  }

  const found = {}
  const rt = /^[ \t]*(?:const|let|var)\s+(\w+)\s*=\s*([^\n;]*\+[^\n;]*);[ \t]*$/gm
  let mc
  while ((mc = rt.exec(t))) {
    const expr = mc[2].replace(/Object\.keys\((\w+)\)/g, 'Object.keys(tables.$1)')
    try {
      const val = new Function('tables', `return (${expr})`)(tables)
      if (typeof val === 'string' && val.length > 1) found[mc[1]] = val
    } catch { /* 拼不出来就算了，后面还有别的兜底 */ }
  }
  return found
}

const walk = d => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name)
    if (f.isDirectory()) {
      if (['node_modules', '.git'].includes(f.name)) continue
      walk(p)
    } else if (f.name.endsWith('.js')) {
      const t = fs.readFileSync(p, 'utf8')
      // 先收集文件内的常量：const NAME = /.../  与 const NAME = '...'
      const consts = {}
      const rc = /const\s+(\w+)\s*=\s*\/((?:\\.|\[[^\]]*\]|[^/\\])+)\/[gimsuy]*/g
      let mc
      while ((mc = rc.exec(t))) consts[mc[1]] = mc[2]
      const rc2 = /const\s+(\w+)\s*=\s*(['"`])((?:\\.|(?!\2).)*)\2/g
      while ((mc = rc2.exec(t))) consts[mc[1]] = mc[3].replace(/\\\\/g, '\\')
      // const NAME = new RegExp('...') —— ws-plugin 这类插件把正则放在变量里
      // 注意要按 JS 字符串转义规则还原：'\s' 在运行时其实是字母 s，'\\s' 才是 \s
      const rc3 = /(?:const|let|var)\s+(\w+)\s*=\s*new\s+RegExp\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g
      while ((mc = rc3.exec(t))) {
        let s = mc[2].slice(1, -1).replace(/\\(.)/g, (_, c) => (c === '\\' ? '\\' : c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c))
        s = s.replace(/\[\$\{[^}]*\}\]/g, '[^]').replace(/\$\{[^}]*\}/g, '.*')
        consts[mc[1]] = s
      }
      // 单行字符串拼接的常量（'a' + Object.keys(X).join('|') + 'b'）放在最后，
      // 避免被上面的 rc2 用「第一个引号里的片段」覆盖掉
      Object.assign(consts, evalConcatConsts(t))
      // 字符串 / 模板字面量形式：reg: '...'  reg: `...`
      const re = /reg:\s*(`[^`]*`|'[^']*'|"[^"]*")/g
      let m
      while ((m = re.exec(t))) {
        let s = m[1].slice(1, -1).replace(/\\\\/g, '\\')
        for (const pf of prefixes) s = s.split('${rulePrefix}').join(pf)
        for (const [k, v] of Object.entries(prefixMap)) s = s.split('${PREFIX.' + k + '}').join(v)
        // 剩下的 ${...} 是运行时拼进来的变量：字符类里的当成「任意一个字符」，其它当成 .*
        // 只能近似校验，但比整条判死强
        s = s.replace(/\[\$\{[^}]*\}\]/g, '[^]').replace(/\$\{[^}]*\}/g, '.*')
        regs.push(s)
      }
      // 正则字面量形式：reg: /^#绑定ck$/i
      const re2 = /reg:\s*\/((?:\\.|\[[^\]]*\]|[^/\\])+)\/[gimsuy]*/g
      while ((m = re2.exec(t))) regs.push(m[1])
      // reg: SOME_CONST 形式，常量在同文件里定义（含 `reg: sysCfgReg()` 这种调用写法）
      const re3 = /reg:\s*([A-Za-z_$][\w$]*)\s*\(?\s*\)?\s*[,}\n]/g
      while ((m = re3.exec(t))) if (consts[m[1]]) regs.push(consts[m[1]])
      // 函数里 return new RegExp(`^#xx设置\s*(?:(${组名}))?...`) —— 组名/项名是运行时算的，
      // 只能把 ${...} 当 .* 近似。只收以 ^ 开头的（否则 `前缀 + 关键词` 那种会被放大成「匹配一切」）
      const rc6 = /new\s+RegExp\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g
      while ((m = rc6.exec(t))) {
        const q = m[1][0]
        let s = m[1].slice(1, -1).replace(/\\(.)/g, (_, c) => (c === '\\' ? '\\' : c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c))
        if (!s.startsWith('^')) continue
        s = s.replace(/\[\$\{[^}]*\}\]/g, '[^]').replace(/\$\{[^}]*\}/g, '.*')
        regs.push(s)
      }
      // miao-plugin 这套脚手架不用 reg，直接写 rule: /^#喵喵帮助$/（单条规则对象）
      // 注意 rule: [ {reg: ...} ] 那种数组形态不会被这两条命中，不会重复计数
      const re4 = /(?:^|[\s{,])rule:\s*\/((?:\\.|\[[^\]]*\]|[^/\\])+)\/[gimsuy]*/g
      while ((m = re4.exec(t))) regs.push(m[1])
      const re5 = /(?:^|[\s{,])rule:\s*(`[^`]*`|'[^']*'|"[^"]*")/g
      while ((m = re5.exec(t))) {
        let s = m[1].slice(1, -1).replace(/\\\\/g, '\\')
        for (const pf of prefixes) s = s.split('${rulePrefix}').join(pf)
        s = s.replace(/\[\$\{[^}]*\}\]/g, '[^]').replace(/\$\{[^}]*\}/g, '.*')
        regs.push(s)
      }
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
    // `#<表情关键词> 文本` 这类占位符：关键词来自数据库，静态校验不了，跳过而不是判死
    if (/[<>]/.test(cmd)) continue
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
