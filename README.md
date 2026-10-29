# command-maps

Yunzai 插件的**插件地图**仓库。一份地图完整描述一个插件的全部用户可见指令：写法、口语关键词、参数、示例、前置条件、常见坑、失败表现、返回形态、使用场景。

下载方（chatgpt-plugin）只做四件事：枚举本机装了哪些插件、按需拉取对应地图、注入插件级摘要、查与代执行。**本机不再自己生成描述**——描述只在这份仓库里产生和维护。

## 结构

```
maps-v2/                   手写地图，唯一的编辑入口
  <pluginKey>.json         一个插件一份
  _rule-counts.json        源码规则条数基线（覆盖率对账用，不是地图）
dist/                      构建产物，跟地图一起提交
  index.json               每份地图的 file / version / revision / sha256 / fingerprint
  maps/<pluginKey>.json    地图的字节副本，下载方直接取这里
scripts/                   构建、自检、探针脚本
.github/workflows/maps.yml CI：重建索引 + 产物自检
.githooks/pre-commit       提交前指令反查（需手动启用，见下）
```

`index.json` 的键是**插件注册单位**（`pluginKey`），不是插件文件夹名——同一个插件包里可能有多个注册单位。

`dist/maps/` 里的文件名由 key 决定，key 里的 `/` 压成 `__`。

## 历史归档

schema 1 那一套还留在仓库里，只为让老下载端仍能取到，**不再维护，不接受 PR**：

| 路径 | 说明 |
|---|---|
| `maps/` | 旧地图目录，被 `maps-v2/` 取代 |
| 根目录 `index.json` | 旧索引，被 `dist/index.json` 取代 |
| `schema/command-map.schema.json` | 旧 schema 文件，字段约束现在写在 `build-index-v2.mjs` 里 |
| `reports/usage.md` | 旧用量统计，由 `analyze-logs.mjs` 生成 |

新改动一律进 `maps-v2/`，构建产物进 `dist/`。

## 源码快照

补地图要对着插件源码看，本机约定放在 `../_plugins_src/<插件名>/`（不进仓库）。
两个容易踩的点：

- **快照里没有插件运行时生成的 yaml 配置。** 开关初值、模型名、阈值这类默认值，很多是插件装好之后自己写出来的，
  仓库里那份 `config_default.yaml` 往往不全。要确认「默认开还是默认关」，去上游仓库的 `defSet/` 目录取，别从快照猜。
- 快照是浅克隆，只保留当前版本。要对比「以前是不是这样」，得重新拉全量。

## 地图结构（schema 2）

```jsonc
{
  "schema": 2,
  "plugin": {
    "key": "yenai-plugin",
    "display": "椰奶",
    "category": "群管理",
    "summary": "群管全家桶 + 小助手……",   // 注入用，40~80 字
    "homepage": "https://github.com/...",
    "notes": "排查提示：两处涩涩开关…",
    "interactsWith": ["miao-plugin（抢同一批口令）"]
  },
  "instructions": [
    {
      "id": "yenai-plugin/mute",
      "command": "#禁言",
      "aliases": ["#禁言 1小时"],
      "title": "禁言群成员",
      "summary": "把被 @ 或被回复的那个人禁言一段时间",
      "what": "从消息里取被 @ 的人……（触发后的完整流程，3~5 句）",
      "returns": "把协议端返回值原样转发",
      "returnsDetail": "成功：「✅ …」；失败：协议端原文",
      "timing": "同步，1~2 秒",
      "cost": "走协议端接口，会真实改变成员状态",
      "keywords": ["禁言", "小黑屋"],
      "params": [{ "name": "时长", "required": false, "desc": "数字+单位", "example": "30分钟" }],
      "example": "#禁言 @张三 30分钟",
      "moreExamples": ["#禁言 1天"],
      "preconditions": ["发送者需管理员", "Bot 需管理员"],
      "pitfalls": ["不 @ 人时会禁言自己"],
      "failures": [{ "symptom": "回「权限不足」", "cause": "Bot 不是管理员" }],
      "edgeCases": ["时长写 0 → 可能被当永久"],
      "scenarios": ["群里有人刷屏"],
      "vs": [{ "command": "#全体禁言", "diff": "那个作用于整群" }],
      "related": ["#解禁"],
      "risk": "a",
      "permission": "admin"
    }
  ]
}
```

**23 个字段全部必填**（数组可以为空，但不能缺字段）。缺任何一项，构建脚本会拒绝发布。

几条容易写错的约定：

- `risk`：`q` 查询 / `w` 会写数据 / `a` 管理或破坏性操作。
- `permission`：`master` / `admin` / 空串。**必须对着源码确认**——不少指令在函数里用 `e.isMaster` 早退，`rule.permission` 上看不出来。
- `command` 留空表示「没有确定写法」（如「任意含某词的消息都会触发」）。这类能力要收进来，`summary` 里写清触发条件，**不要编一个假写法**。
- 同一插件内 `command` 不能重复。私聊版与群聊版指令（参数不同）要用完整写法区分，例如 `#禁言 123456 789012 30分钟`。
- `vs` 用来写「和哪些指令像、差在哪」，跨插件也要写——这是模型最容易搞错的地方。
- 地图里**不要写 `version`**：版本只存在于 `dist/index.json`，两处并存必然打架（实测会导致每次同步都判「版本不同」而重复下载）。

### 两个可选字段

23 个必填字段之外，下面两个**按需填**，不填就是默认语义：

| 字段 | 类型 | 什么时候填 |
|---|---|---|
| `enabled_by_default` | 布尔，默认 `true` | 指令装了也**默认不响应**、必须先手动开开关时填 `false` |
| `implemented_in` | 字符串 | 帮助菜单里有、但**本插件零实现**（真正实现在别的插件）时填真正的来源 |

为什么需要它们：这两种情况都会让用户「照着帮助发指令，却什么反应都没有」。
`preconditions` 里写文字模型也能读到，但填成结构化字段后，索引会直接透出 `default_off_count` / `delegated_count`，
检索端**不打开地图详情**就能判断「这个插件的功能大多要先去开开关」或「这条其实是 genshin 的」。

实例（miao-plugin）：`#喵喵面板`、`#喵喵更新面板` 等大量功能受 `cfg()` 开关控制，默认关即是 `enabled_by_default: false`；
帮助菜单里借来的 18 条（`#深渊`、`#今日材料`、`#抽卡统计` 等）标 `implemented_in: "genshin / Atlas / StarRail-plugin"`。

### 覆盖率对账

`maps-v2/_rule-counts.json` 记录每个插件**源码里有多少条正则规则**（由 `probe-loader.mjs` 产出）。
构建时对比地图条数：**少于规则数 90%** 就在输出末尾打一条提醒（不阻断发布）。

反向偏差（地图比规则多）不报警——那通常是从 README 补了源码里没写死的能力，是好事。
合并「开启/关闭」成一条、把一条规则拆成多条都是合理的，所以阈值留了 10% 余量。

## 版本号（发布规范）

**每份地图有独立的 `version`，格式 `0.0.N`，由脚本自动计算，不要手改。**

| 情况 | 行为 |
|---|---|
| 首次收录 | `0.0.1` |
| 内容有任何变化（`sha256` 变） | 末位 +1，如 `0.0.1` → `0.0.2` |
| 内容没变 | 沿用上一版，不制造空版本 |
| 只改了别的插件 | 不受影响，各自独立计数 |

配套的两个量：

- `revision`（每份地图）：该地图最后一次内容变化时的全局序号。
- `index.revision`（全局）：任一地图内容变化就 +1。

下载方只用 `version` 字符串是否相等来决定要不要重下；`revision` 判「云端有没有新版」，`sha256` 校验内容没被篡改。`fingerprint` 是「主写法集合」的 sha1 前 12 位——别名增减不改变它，可用于判断「这份描述对不对得上本机装的这组指令」。

## 发布流程

```bash
# 1. 改 maps-v2/ 下的地图（或新增）
# 2. 生成索引（校验 23 个字段、算哈希、升版本号），产物写进 dist/
node scripts/build-index-v2.mjs

# 3. 产物自检（结构层 + 有前端仓库时的端到端链路）
node scripts/verify-pipeline.mjs

# 4. 提 PR，CI 与人工审核后合并
```

构建脚本是**发布门禁**：缺字段、schema 不对、`id`/`command` 重复、`instructions` 为空——任何一项不过都直接退出，不产出索引。

CI 跑三件事，任一步非 0 就红：

| 步骤 | 命令 | 拦什么 |
|---|---|---|
| 展示名对账 | `node scripts/build-index-v2.mjs --check-display` | 改了地图的 `display` 却没重建索引 |
| 重建索引 | `node scripts/build-index-v2.mjs` | 缺必填字段、`id`/`command` 重复、schema 不对 |
| 产物自检 | `node scripts/verify-pipeline.mjs` | 落盘哈希 / 字节数 / 条数与索引对不上、`dist/maps` 有孤儿文件 |

`--check-display` 只比对不写盘；它拦的是「地图改了、`dist/` 没跟上」这类半更新——这种问题只在合并后才暴露的话，修起来要回改 main。

## 提交前钩子（可选）

装了源码快照的机器上，可以让提交时自动反查指令写法：

```bash
git config core.hooksPath .githooks
```

钩子只检查本次暂存的地图，且只在 `../_plugins_src/<插件名>/` 存在时才跑——没有快照就静默跳过，
所以别人的机器和 CI 都不会被它挡住。想指到别处就设 `PLUGINS_SRC`。

## 下载方规则（chatgpt-plugin）

1. 拉 `index.json`，与本机已装插件求交集；
2. 比对 `version`，一致的跳过（不下载）；
3. 按镜像链下载（直连 → gh-proxy.at9.net → gh.xmly.dev → cors.isteed.cc → jsDelivr）；
4. **必须比对 sha256**，不符即换下一个源；
5. `schema` 不是 2 的地图一律不收，该插件按「云端无地图」处理；
6. 落到 `data/chatgpt/maps/<pluginKey>/`，同时写 `meta.json` 记录来源版本与哈希。

本机有、索引里没有的插件会被列入缺失清单，AI 对这些插件既不知道写法也不知道功能。

## 脚本

现行（schema 2）：

| 脚本 | 用途 |
| --- | --- |
| `build-index-v2.mjs` | 由 `maps-v2/` 生成 `dist/index.json`，校验字段、算哈希、自动升版本号；`--check-display` 只对账不写盘 |
| `verify-pipeline.mjs` | 产物自检：结构层逐条对账；有前端仓库时再跑一遍完整拉取链路 |
| `rebase-index.mjs` | 按一组插件从最新索引裁出子集，单个 PR 只贴自己的条目，避免整份覆盖导致连环冲突 |
| `check-map-commands.mjs` | 反查地图里的写法能否命中源码正则；`<地图名> <源码目录>` |
| `rules-table.mjs` | 把一个插件的规则摊成 TSV（位置 / fnc / permission / reg），补地图时一次读完 |
| `probe-loader.mjs` | 离线枚举单个插件的真实规则（不启动 Bot、不连协议端） |
| `probe-all.mjs` | 批量跑 `probe-loader`，中间产物落在系统临时目录，退出即删 |
| `analyze-logs.mjs` | 统计近一月指令用量（用于 `used` 与长文筛选） |

历史（schema 1 遗留，别再用来发布）：`build-index.mjs`、`bump-revision.mjs`、`classify-index.mjs`、`expand-keys.mjs`、`extract-sources.mjs`。

## 贡献

地图的质量标准只有一句：**不看源码也能判断**——按下去会发生什么、我会看到什么、什么情况下不该用。

写 `keywords` 时多写用户真实说法（「帮我点个赞」比「赞」有用），不要写「指令」「插件」这类元词。改完请跑一次 `build-index-v2` 让版本号与哈希自动更新，**不要手改 `dist/index.json`**。
