# command-maps

Yunzai 插件的**插件地图**仓库。一份地图完整描述一个插件的全部用户可见指令：写法、口语关键词、参数、示例、前置条件、常见坑、失败表现、返回形态、使用场景。

下载方（chatgpt-plugin）只做四件事：枚举本机装了哪些插件、按需拉取对应地图、注入插件级摘要、查与代执行。**本机不再自己生成描述**——描述只在这份仓库里产生和维护。

## 结构

```
index.json                 每份地图的 file / version / revision / sha256 / fingerprint
maps/<pluginKey>.json      单插件地图；pluginKey 里的 / 压成 __
schema/command-map.schema.json
scripts/                   构建与校验脚本
reports/usage.md           用量统计（由日志生成）
```

`index.json` 的键是**插件注册单位**（`pluginKey`），不是插件文件夹名——同一个插件包里可能有多个注册单位。

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
- 地图里**不要写 `version`**：版本只存在于 `index.json`，两处并存必然打架（实测会导致每次同步都判「版本不同」而重复下载）。

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
# 1. 改 maps/ 下的地图（或新增）
# 2. 生成索引（校验 23 个字段、算哈希、升版本号）
node scripts/build-index-v2.mjs

# 3. 端到端自检（假云端 + 真实拉取代码）
node scripts/verify-pipeline.mjs

# 4. 提 PR，人工审核后合并
```

构建脚本是**发布门禁**：缺字段、schema 不对、`id`/`command` 重复、`instructions` 为空——任何一项不过都直接退出，不产出索引。

## 下载方规则（chatgpt-plugin）

1. 拉 `index.json`，与本机已装插件求交集；
2. 比对 `version`，一致的跳过（不下载）；
3. 按镜像链下载（直连 → gh-proxy.at9.net → gh.xmly.dev → cors.isteed.cc → jsDelivr）；
4. **必须比对 sha256**，不符即换下一个源；
5. `schema` 不是 2 的地图一律不收，该插件按「云端无地图」处理；
6. 落到 `data/chatgpt/maps/<pluginKey>/`，同时写 `meta.json` 记录来源版本与哈希。

本机有、索引里没有的插件会被列入缺失清单，AI 对这些插件既不知道写法也不知道功能。

## 脚本

| 脚本 | 用途 |
| --- | --- |
| `scripts/build-index-v2.mjs` | 由 `maps/` 生成 `index.json`，校验字段、算哈希、自动升版本号 |
| `scripts/verify-pipeline.mjs` | 端到端自检：假云端 + 真实拉取代码，验证落盘与二次同步 |
| `scripts/extract-sources.mjs` | 从插件源码粗提指令清单（人工撰写的输入，不直接发布） |
| `scripts/probe-loader.mjs` | 在装有插件的机器上离线枚举真实规则（不启动 Bot、不连协议端） |
| `scripts/analyze-logs.mjs` | 统计近一月指令用量（用于 `used` 与长文筛选） |
| `scripts/bump-revision.mjs` | 旧版补丁流程遗留，schema 2 下由 `build-index-v2` 接管 |

## 贡献

地图的质量标准只有一句：**不看源码也能判断**——按下去会发生什么、我会看到什么、什么情况下不该用。

写 `keywords` 时多写用户真实说法（「帮我点个赞」比「赞」有用），不要写「指令」「插件」这类元词。改完请跑一次 `build-index-v2` 让版本号与哈希自动更新，**不要手改 `index.json`**。
