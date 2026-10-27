# command-maps

Yunzai 插件的**指令地图**补丁仓库。地图不重复记录指令写法——写法与权限来自运行时枚举（插件自带的能力表），
这里只补四样东西：**人话说法（keys）、参数说明（args）、示例（ex）、风险档（risk）**。

## 结构

```
index.json                 每份地图的指纹、字节数、sha256（下载方必须校验）
maps/<pluginKey>.json      单插件补丁；pluginKey 里的 / 压成 __
schema/command-map.schema.json
reports/usage.md           用量与叫法差异（由日志统计生成）
```

`index.json` 的键是**插件注册单位**（`pluginKey`），不是插件文件夹名——同一个插件包里可能有多个注册单位。

## 补丁字段

```jsonc
{
  "schema": 1,
  "plugin": { "key": "delta-force-plugin", "fingerprint": "a1b2c3d4e5f6" },
  "commands": {
    "#三角洲战绩": {
      "keys": ["战绩", "我的战绩", "帮我看看我打得怎么样"],
      "args": { "p1": "模式 烽火地带|全面战场，可留空" },
      "ex": "#三角洲战绩 烽火地带",
      "risk": "q",            // q 查询 / w 会写数据 / a 管理破坏
      "interactive": false
    }
  }
}
```

**不要在这里写 `call` 或 `what`**：那两份事实属于运行时枚举，写两份必然漂移。

## 下载方规则（chatgpt-plugin 的指令地图同步）

1. 先拉 `index.json`，与本机已装的插件求交集；
2. 按镜像链下载（直连 → gh-proxy.at9.net → gh.xmly.dev → cors.isteed.cc → jsDelivr）；
3. **必须比对 sha256**，不符即换下一个源；没有哈希声明的补丁一律不收；
4. 按 `<插件>/<指纹>.json` 落盘，指纹命中不再联网。

## 脚本

| 脚本 | 用途 | 在哪跑 |
| --- | --- | --- |
| `scripts/analyze-logs.mjs` | 统计近一月指令用量与写法差异 | Yunzai 容器内（要读 logs 与能力表） |
| `scripts/build-index.mjs` | 由能力表 + 日志生成首版补丁与索引 | 同上 |
| `scripts/classify-index.mjs` | 按插件包聚合、打用途标签、重写索引与报告 | 同上 |
| `scripts/expand-keys.mjs` | 给热门指令扩写口语 keys（**花 token**，先 `--dry-run` 看提示词） | 任意有网机器，需 `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL` |

## 贡献

补丁里的 `keys` 是**给匹配器吃的语料**：多写用户真实说法（整句口语优先），不要写「指令」「插件」这类元词，
也不要为不存在的写法造词。改完请更新对应 `index.json` 的 `fingerprint` 与 `sha256`。
