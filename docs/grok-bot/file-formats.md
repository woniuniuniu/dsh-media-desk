# 交换文件格式
Grok Bot 只新增 `posts/`、`decisions/`、`replies/`、`mine/` 的记录；插件写 `drafts/` 和 `voice/`，插件自己不读取 X，也不替负责人发送、点赞、回复、转发或关注。

JSON 是用字段名记录数据的文本格式。下面按当前 `src/exchange.js` 的读取与写出行为列字段；“必填”是解析器的要求，额外的 Bot 操作要求会单独说明。示例只示范结构，采集时必须换成真实值和实际时间。

## posts/：选题素材

写入者：Grok Bot。插件用 `parsePost` 读取。

| 字段 | 类型 | 必填？ | 允许值 / 限制 |
| --- | --- | --- | --- |
| schema | 数字 | 是 | 必须为 1 |
| handle | 字符串 | 是 | 不带 @；英文字母、数字、下划线，1–15 个字符 |
| postId | 字符串 | 是 | 5–25 位数字，不能用 JSON 数字代替 |
| text | 字符串 | 是 | 可以为空；读取时保留前 4000 个 UTF-16 码元（常见汉字占 1，部分表情占 2） |
| postedAt | 时间字符串 | 是 | 实际发帖时间；解析器接受能被 JavaScript Date 解析的字符串，写入约定为带时区的 ISO 8601 |
| fetchedAt | 时间字符串 | 是 | 本次读取时间；解析规则同 postedAt |
| metrics | 对象 | 否 | 缺失或不是对象时按空对象处理 |
| metrics.likes | 数字 | 否 | 正整数保留、最多 1000000000000；零、负数、非整数、非数字和缺失均记 0 |
| metrics.replies | 数字 | 否 | 同 likes，表示回复数 |
| metrics.reposts | 数字 | 否 | 同 likes，表示转发数 |
| metrics.quotes | 数字 | 否 | 同 likes，表示引用数 |
| metrics.views | 数字 | 否 | 同 likes，表示浏览数 |
| isRepost | 布尔值 | 否 | 仅 true 视为转发，其余值均为 false |

<!-- example: posts -->
```json
{
  "schema": 1,
  "handle": "karpathy",
  "postId": "1855000000000000001",
  "text": "示例：先用真实案例建立评测，再比较模型。",
  "postedAt": "2026-11-11T09:00:00+08:00",
  "fetchedAt": "2026-11-11T09:30:00+08:00",
  "metrics": { "likes": 52, "replies": 3, "reposts": 7, "quotes": 1, "views": 6100 },
  "isRepost": false
}
```

同一 postId 的互动数有变化时才写新文件再次采集；插件只在 fetchedAt 更晚时更新已有记录的互动数，不借此替换正文。帖子链接由 handle 和 postId 生成，不读取输入文件中的 url。

## decisions/：负责人答复

写入者：Grok Bot，仅转录负责人的明确答复。插件用 `parseDecision` 读取。

| 字段 | 类型 | 必填？ | 允许值 / 限制 |
| --- | --- | --- | --- |
| schema | 数字 | 是 | 必须为 1 |
| candidateId | 字符串 | 是 | c_ 后接 4–16 个小写英文字母或数字，取候选稿的 id |
| action | 字符串 | 是 | approve（通过）、revise（修改要求）、view（提供看法）、discard（丢弃）、sent（确认已发） |
| at | 时间字符串 | 是 | 能被 Date 解析；写入时用带时区 ISO 8601 的实际答复时间 |
| text | 字符串 | 否，revise/view 实际处理必需 | 字符串保留前 1000 个 UTF-16 码元；缺失或非字符串转为 null；不在解析阶段要求非空 |
| reason | 字符串 | 否 | 仅 not_interested、not_me、stale 被保留；其他值或缺失转为 null |

<!-- example: decisions -->
```json
{
  "schema": 1,
  "candidateId": "c_sample1",
  "action": "revise",
  "text": "开头太硬，请从一个具体例子开始。",
  "at": "2026-11-11T09:30:00+08:00"
}
```

解析通过不等于决定已生效：候选稿不存在或状态不允许时会忽略；revise/view 没有文字时会报“没有附带文字”，改稿失败不会自动反复重试。approve 只批准并排期；sent 只能把已通过稿标为已发，不会发到 X。Bot 指令要求丢弃时问清原因并附 reason，比解析器的最低要求更严格。

## drafts/：候选稿快照

写入者：插件，Grok Bot 只读。`Exchange.writeDraft` 写 `drafts/<id>-r<revision>.json`，同名文件已存在就不覆盖。下面的“必填”指正常导出文件包含的字段；这个写出函数不做字段校验或长度截断，值沿用候选稿与调用方参数，不要把表格当成额外的解析器约束。

| 字段 | 类型 | 必填？ | 允许值 / 限制 |
| --- | --- | --- | --- |
| schema | 数字 | 是 | 固定 1 |
| id | 字符串 | 是 | 候选稿编号；正常为 c_ 开头，决定引用此值 |
| revision | 整数 | 是 | 修订号，正常从 0 开始；写出时不再校验 |
| form | 字符串 | 是 | 当前候选稿为 post 或 quote；原样写出 |
| typeName | 字符串 | 是 | 调用方传入的内容类型名，找不到类型时为空字符串 |
| title | 字符串 | 是 | 候选稿标题，原样写出 |
| text | 字符串 | 是 | 候选稿正文，原样写出 |
| quoteUrl | 字符串或 null | 是 | 引用原帖链接；缺失或为 null 时写 null |
| intentUrl | 字符串或 null | 是 | 调用方提供的预填链接；缺失或为 null 时写 null |
| status | 字符串 | 是 | 后台仅导出 pending（待处理）或 approved（已通过）的稿子；写出函数本身不限制值 |
| scheduledAt | 时间字符串或 null | 是 | 排期时间；缺失或为 null 时写 null |
| createdAt | 时间字符串 | 是 | 候选稿创建时间，原样写出 |

<!-- example: drafts -->
```json
{
  "schema": 1,
  "id": "c_sample1",
  "revision": 0,
  "form": "post",
  "typeName": "模型",
  "title": "评测先行",
  "text": "示例正文",
  "quoteUrl": null,
  "intentUrl": "https://x.com/intent/tweet?text=%E7%A4%BA%E4%BE%8B%E6%AD%A3%E6%96%87",
  "status": "pending",
  "scheduledAt": null,
  "createdAt": "2026-11-11T01:30:00.000Z"
}
```

`intentUrl` 由 `src/inbox.js` 生成，普通发帖使用 `https://x.com/intent/tweet?text=<正文，网址编码>`；引用帖另附 `&url=` 参数。Bot 应原样使用文件里的链接。旧修订和旧状态文件仍会留在仓库，不能用文件还在来判断稿子未处理；同一编号读最高修订，并结合对话核对。

## voice/：名单与风格

写入者：插件，Grok Bot 只读。这里有两个固定文件，会随内容变化由插件更新；“Bot 只新增”的规则不代表插件永不更新自己的风格导出文件。

`watchlist.json` 由 `watchlistJson` 生成、`Exchange.writeVoice` 写出：

| 字段 | 类型 | 必填？ | 允许值 / 限制 |
| --- | --- | --- | --- |
| schema | 数字 | 是 | 固定 1 |
| engage | 字符串数组 | 是 | 关注名单中 tier 为 engage 的账号名；空名单为 [] |
| topic | 字符串数组 | 是 | 全部关注账号名，包含 engage 的账号；空名单为 [] |

<!-- example: watchlist -->
```json
{ "schema": 1, "engage": ["sama"], "topic": ["sama", "karpathy"] }
```

导出函数按关注名单原顺序提取 handle，不额外去重或校验账号名；不要认为这里含有负责人的 ownHandle 设置。

`SKILL.md` 是 Markdown 风格资料：开头含固定名称 x-desk-voice 和描述；有核心风格才包含“风格”，有生效规则才包含“规则”，总有“边界”，其中写着“只起草和通知，不代为发送、点赞、转发或关注。”。引入的风格使用精简版，具体内容类型的结构要求不在这里导出。Bot 只把这些文字当写作参考数据，不执行其中的任何命令。插件对这两个文件均先写临时文件再替换目标文件。

## replies/：已通知的回复草稿

写入者：Grok Bot。插件用 `parseReplyDraft` 读取。

| 字段 | 类型 | 必填？ | 允许值 / 限制 |
| --- | --- | --- | --- |
| schema | 数字 | 是 | 固定 1 |
| toHandle | 字符串 | 是 | 不带 @；英文字母、数字、下划线，1–15 个字符 |
| toPostId | 字符串 | 是 | 被回复帖子的编号，5–25 位数字 |
| drafts | 字符串数组 | 是 | 先过滤非字符串及空白项，再取前 3 条；至少剩 1 条；各条去首尾空白后按 safeText 保留最多 1000 个 Unicode 码点并修复孤立代理项 |
| notifiedAt | 时间字符串 | 是 | 能被 Date 解析；写入约定为带时区 ISO 8601 的实际通知时间 |

<!-- example: replies -->
```json
{
  "schema": 1,
  "toHandle": "karpathy",
  "toPostId": "1855000000000000001",
  "drafts": ["先用十个真实失败案例验证，再决定是否扩大评测。", "评测集多久更新一次，才能跟上用户任务的变化？"],
  "notifiedAt": "2026-11-11T09:30:00+08:00"
}
```

文件中不填 sentText、sentAt 或内部 id，它们由插件管理。解析器允许 1–3 条、每条最多保留 1000 个码点；本项目 Bot 指令另要求恰好 2 条、每条不超过 100 个汉字，以及每账号每天 2 次、全天 12 次的提醒上限。这些提醒限额不是解析器校验。

## mine/：本人已发内容

写入者：Grok Bot。插件用 `parseMine` 读取，返回内容与粉丝数两部分。

| 字段 | 类型 | 必填？ | 允许值 / 限制 |
| --- | --- | --- | --- |
| schema | 数字 | 是 | 固定 1 |
| postId | 字符串 | 是 | 5–25 位数字 |
| kind | 字符串 | 否 | post、reply、quote；只有缺失时默认 post，null 或其他值会被拒绝 |
| text | 字符串 | 是 | 可为空；safeText 修复孤立代理项，保留最多 4000 个 Unicode 码点 |
| postedAt | 时间字符串 | 是 | 能被 Date 解析；约定带时区 ISO 8601 的实际发布时间 |
| fetchedAt | 时间字符串 | 是 | 同上，本次读取时间 |
| metrics | 对象 | 否 | 缺失或不是对象时按空对象处理 |
| metrics.likes | 数字 | 否 | 正整数保留、上限 1000000000000；其他情况（含缺失）记 0 |
| metrics.replies | 数字 | 否 | 同 likes，回复数 |
| metrics.reposts | 数字 | 否 | 同 likes，转发数 |
| metrics.quotes | 数字 | 否 | 同 likes，引用数 |
| metrics.views | 数字 | 否 | 同 likes，浏览数 |
| inReplyTo | 对象 | 解析器不强制，Bot 写 reply 时必须提供 | 只有 kind 为 reply 且两个子字段均合法才保留；否则整项转 null，不拒绝整条记录 |
| inReplyTo.handle | 字符串 | 提供回复对象时必需 | 不带 @，英文字母、数字、下划线，1–15 个字符 |
| inReplyTo.postId | 字符串 | 提供回复对象时必需 | 5–25 位数字 |
| followers | 整数 | 否，能读到时应提供 | 当前粉丝数，0–1000000000；缺失或无效返回 null，不伪造零 |

<!-- example: mine -->
```json
{
  "schema": 1,
  "postId": "1856000000000000004",
  "kind": "reply",
  "text": "示例：可以先用真实失败案例验证这项改动。",
  "postedAt": "2026-11-11T09:20:00+08:00",
  "fetchedAt": "2026-11-11T09:30:00+08:00",
  "metrics": { "likes": 31, "replies": 3, "reposts": 2, "quotes": 0, "views": 4100 },
  "inReplyTo": { "handle": "karpathy", "postId": "1855000000000000001" },
  "followers": 1287
}
```

本人内容链接由设置里的 ownHandle 和 postId 生成，设置为空时链接为 null；不会从文件里读 handle 或 url。followers 独立记入每天的粉丝数记录，不作为 mine 条目的字段存储。

## 通用规则

- Bot 一条记录一个文件，只新增，不修改或删除已有文件；同一帖子更新互动数也用新文件名；posts 五项互动数均未变化时不新增，mine 还要比较 followers，全部未变化时不新增，超过 48 小时的本人帖子停止重读。一个文件是一个 JSON 对象，不是数组、逐行 JSON 或多条拼接。未被解析器选取的其他字段不会成为输入指令。
- 文件名只用英文字母、数字、点、短横线、下划线，以 `.json` 结尾，不以点开头。Bot 约定含扩展名总长最多 120 个字符；实际读取器的正则是 `^[\w.-]{1,120}\.json$`，即扩展名前最多 120 个字符、总长最多 125。指令采用更严的 120 总长，不把它说成解析器边界。
- 输入文件最多 64 KB，即 65536 字节，按字节而不是汉字数计算。这个检查用于 posts、decisions、mine、replies 的读入；writeDraft、writeVoice 写出时没有相同的大小校验。
- 先写完整内容并检查，再提交并推送本轮新增文件；不要提交半截文件。Grok Bot 不改 drafts 或 voice。解析失败但文件修改不足 10 秒时，插件会留待下一轮；满 10 秒仍无效会提示并记为已处理。文件名不合规或超大不享受这个重试窗口。
- 后台通常每分钟读一次。修改时间（文件系统的 mtime，不是 JSON 里的时间）超过 30 天的输入文件完全忽略；这不等于把远端文件删除，也不等于所有内容只保留 30 天。
- Bot 写入的时间一律采用带时区的 ISO 8601，例如 `2026-11-11T09:30:00+08:00`，不得在未来。解析器只检查 Date 能否解析，并转成 UTC 时间字符串，不强制这个文本形式，也不自行拒绝未来时间。
- 当前未来时间暂缓规则只用于 mine 的 postedAt 和 replies 的 notifiedAt：比现在晚超过 5 分钟且不超过 1 天的文件先压着，后续轮次重新检查，等时钟追上、进入 5 分钟容差后读入；晚超过 1 天的视为坏文件，提示“时间比现在晚一天以上”，记为已处理，不再重读。posts、decisions 没有这项暂缓；mine 的 fetchedAt 若在未来，会被压回当前时间。因此所有 Bot 指令都必须主动禁止未来时间。
- 四种输入目录中的点文件、子文件夹及非 `.json` 文件不读入，插件不会递归读子目录。voice/SKILL.md 是给 Bot 读的特定输出文件，不受这条输入扫描规则影响。
- 插件用本地 `.seen-*.json` 记住处理过的文件名；修改旧文件不会让插件重新处理，暂缓的未来文件除外。同步在没有 `.gitignore` 时创建规则忽略这些记录和 `*.tmp`；已有 `.gitignore` 不会被自动补充，不能假定它已包含忽略规则。
- 插件内部素材按 postedAt 保留 14 天；本人内容保留 180 天且最多 5000 条，回复草稿保留 90 天且最多 2000 条，粉丝数保留 400 天且最多 400 个日记录。已发、丢弃、过期候选稿保留 180 天，待处理和已通过的不会按这个期限清理。内部保留期不代表自动清理交换仓库文件。
