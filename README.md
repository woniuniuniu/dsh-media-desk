# dsh-x-desk

**一句话：** DeepSeek Harness（DSH，一个桌面 AI 工具）的插件，服务于一个人运营一个 X 账号。它每天早上把素材整理成选题、写成候选推文放进收件箱；你只做三件事：看、改、点通过。到点后点一下"去 X 发布"，由你自己在 X 上发出，插件不代为发送。

## 数据放在哪里

全部在 `~/.dsh/x-desk/`（你的用户目录下，插件自己的文件夹）。密钥只存在其中的 `settings.json`，权限 600（只有你自己能读）。这个插件不会读写原版插件的 `~/.dsh/media-desk/`。

数据目录必须放在本机磁盘上，而且这块磁盘要支持硬链接（一种让两个文件名指向同一份内容的文件系统功能，后台用它防止两个程序同时处理）；不能放在 exFAT 格式的移动硬盘或网络共享盘上。

插件和外界交换内容靠一个"交换文件夹"，默认是 `~/.dsh/x-desk/exchange/`，也可以在设置里换成别的目录（不能设在原版插件的数据目录里）。里面按用途分子文件夹，每个文件都是一个小的文本文件（JSON 格式）。

## 交换文件夹里的六种文件

下面每种各给一个例子，写法与 `scripts/sample-exchange/` 里的示例完全一致。

**1. 帖子文件（放进 `posts/`）**：别人把读到的帖子放进来，插件读入后用来选题。

<!-- example: posts -->
```json
{
  "schema": 1,
  "handle": "karpathy",
  "postId": "1855000000000000001",
  "text": "Sample: a small model with a well-built eval set beats a big model you never measure. Write the evals first.",
  "postedAt": "2026-11-11T01:00:00Z",
  "fetchedAt": "2026-11-11T03:00:00Z",
  "metrics": { "likes": 5200, "replies": 310, "reposts": 780, "quotes": 140, "views": 610000 },
  "isRepost": false
}
```

**2. 处理结果文件（放进 `decisions/`）**：对某条候选稿做决定。`action` 可以是 `approve`（通过）、`discard`（丢掉）、`view`（附上你的看法让它重写）、`revise`（附上修改要求）、`sent`（标记已发出）。`view` 和 `revise` 必须用 `text` 字段带上那句话；`discard` 可以用 `reason` 说明原因，取值只有 `not_interested`（不感兴趣）、`not_me`（不像我）、`stale`（过时了）。

<!-- example: decisions -->
```json
{ "schema": 1, "candidateId": "c_sample1", "action": "approve", "at": "2026-11-11T04:00:00Z" }
```

<!-- example: decisions -->
```json
{ "schema": 1, "candidateId": "c_sample1", "action": "discard", "reason": "not_interested", "at": "2026-11-11T04:05:00Z" }
```

<!-- example: decisions -->
```json
{ "schema": 1, "candidateId": "c_sample1", "action": "view", "text": "Sample: shorten it and lead with the price drop.", "at": "2026-11-11T04:10:00Z" }
```

**3. 候选稿文件（插件写入 `drafts/`）**：每条候选稿每个修订版一个文件，文件名是 `<候选稿编号>-r<修订号>.json`。你不用手写，只读；`intentUrl` 是点开就能在 X 上预填这条推文的链接。

<!-- example: drafts -->
```json
{
  "schema": 1,
  "id": "c_sample1",
  "revision": 0,
  "form": "post",
  "typeName": "模型",
  "title": "评测先行",
  "text": "一条候选推文的正文。",
  "quoteUrl": null,
  "intentUrl": "https://x.com/intent/tweet?text=%E4%B8%80%E6%9D%A1",
  "status": "pending",
  "scheduledAt": null,
  "createdAt": "2026-11-11T03:05:00.000Z"
}
```

**4. 风格文件（插件写入 `voice/`）**：你不用手写，只读。`watchlist.json` 是你的账号名单，`topic` 是全部账号，`engage` 只含需要重点互动的：

<!-- example: watchlist -->
```json
{ "schema": 1, "engage": ["sama"], "topic": ["sama", "karpathy"] }
```

`SKILL.md` 是当前写作风格的说明，供外部工具参考：开头是名称和一句描述，正文依次是「风格」（核心风格；引入 skill 的用精简版）、「规则」（当前生效的写作规则）、「边界」（只起草和通知，不代为发送、点赞、转发或关注）。内容类型各自的结构要求不在这里面。

**5. 自己发出的内容（放进 `mine/`）**：外部工具把你自己账号发出的一条内容放进来，插件读入并保存，保留 180 天。`kind` 是 `post`、`reply` 或 `quote`，缺省按 `post`；只有 `reply` 才带 `inReplyTo`；`followers` 是读取时的粉丝数，可省略。链接不读文件里的值，由设置里的"自己的账号名"和 `postId` 拼出，没设置时没有链接。插件拿它做四件事：认出哪些候选稿已经发出（候选稿标为"已发"，从待处理里消失）、在"复盘"页统计粉丝数和互动、从你改过的稿子里学写作规则、攒够 30 条后提醒你提炼自己的风格。

<!-- example: mine -->
```json
{
  "schema": 1,
  "postId": "1856000000000000004",
  "kind": "reply",
  "text": "Sample: agreed, and the evals are also the best onboarding doc a new teammate can read.",
  "postedAt": "2026-11-11T09:20:00Z",
  "fetchedAt": "2026-11-11T14:00:00Z",
  "metrics": { "likes": 31, "replies": 3, "reposts": 2, "quotes": 0, "views": 4100 },
  "inReplyTo": { "handle": "karpathy", "postId": "1855000000000000001" },
  "followers": 1287
}
```

**6. 回复草稿（放进 `replies/`）**：外部工具替你起草并通知过的一次回复，1 到 3 条草稿，插件读入并保存，保留 90 天。插件把它和你后来真正发出的回复（`mine/` 里 `kind` 为 `reply` 的内容）对上，对上的回复也会被拿来学写作规则。

<!-- example: replies -->
```json
{
  "schema": 1,
  "toHandle": "karpathy",
  "toPostId": "1855000000000000001",
  "drafts": ["Sample: agreed. Ten real cases written before the first prompt beat a hundred synthetic ones afterwards."],
  "notifiedAt": "2026-11-11T03:10:00Z"
}
```

## 插件拿这些内容做什么

- **认出哪些候选稿已经发出。** 你自己发出的内容读入后，插件会把它和候选稿比对；改得不多的，就把那条候选稿标为"已发"，收件箱和排期页都能看到。改得面目全非或和任何候选稿都不像的，不会硬配，照常进入复盘。两条候选稿很像时，一条实发内容只配给最像的那一条。
- **复盘页。** 显示粉丝数的变化、最近 7 天和 30 天的数据卡片，以及互动最好的 5 条内容。
- **写作规则建议。** 每天最多一次：从你改稿的方式里找规律（比如总是删到更短），攒够 5 组改稿且比上次多出 5 组才会提。建议显示在"风格"页，只有你点"采纳"才会变成生效的规则，点"忽略"就不再提；样本不够时什么也不提。
- **提炼你自己的风格。** 你自己发出的帖子攒到 30 条，会有一条提示请你去风格页；不够 10 条时，点"用我发过的内容提炼"会告诉你还差几条。提炼只给出一份并排预览，核心风格不会被自动替换，由你决定要不要用。
- **每周一的长文选题。** 每周一当天成稿之后，插件根据你近两周发得最好的帖子和写过的看法，建议几个长文选题，放在"长文"页；每周只建议一次。你可以在那里让它出初稿，再用一句话让它改。长文不会发到任何地方，需要你自己复制出去。

## 设置：我的账号名

在设置里填你自己的 X 账号名（只能是字母、数字和下划线，最多 15 个字符，不带 @）。`mine/` 里内容的链接由它和 `postId` 拼出；不填，这些内容就没有链接，其余功能照常。

## 不连任何外部服务，怎么试一下

1. 在 DSH 里启用插件，打开"X 工作台"。
2. 把 `scripts/sample-exchange/posts/` 里的 6 个 `.json` 文件复制到 `<交换文件夹>/posts/`。
3. 想连 `mine/` 和 `replies/` 一起试，直接运行下面的 `scripts/seed-sandbox.sh`，它会把三类样例一起放好（`mine/` 5 个、`replies/` 2 个）。
4. 后台每分钟读一次交换文件夹，格式正确的文件在下一轮（一分钟内）被读入；只有看起来还没写完的文件会再等 10 秒确认。到了设置里的每日成稿时间，或在收件箱点"现在就出一批"，就会出现候选稿。

注意：超过 14 天的帖子会被当作过期素材丢掉；`mine/` 保留 180 天、`replies/` 保留 90 天，另外设有条数上限，超出的从最旧的开始丢；内容的时间如果比现在晚超过 5 分钟，会先压着不读，等到它的时间再读入；交换文件夹里修改时间超过 30 天的文件会被完全忽略。`scripts/sample-exchange/` 里的示例时间是固定的旧日期，直接复制会被丢掉；用沙盒造数脚本 `scripts/seed-sandbox.sh` 复制时会自动把时间改成最近。

## 已知限制

- 桌面版和 Web 版可以同时开着，但两边在同一时刻（毫秒级）都写入工作台数据时，其中一次写入可能丢失；后台处理靠锁文件只在一边运行，日常使用基本碰不到。

## 开发命令

安装依赖：

```bash
npm install
```

跑全部自动化测试：

```bash
npm test
```

打包界面：

```bash
npm run build
```

在隔离的沙盒里启动（需要终端里能用 `dsh` 命令，先在桌面版菜单里选"管理 dsh 命令"开启）：

```bash
scripts/dev-sandbox.sh
```

启动模拟模型（不花钱，沙盒里把文字模型指向它）：

```bash
node scripts/mock-llm.mjs
```

把示例（帖子、自己发出的内容、回复草稿）放进沙盒的交换文件夹：

```bash
scripts/seed-sandbox.sh
```

## 许可

基于 woniuniuniu/dsh-media-desk（MIT 许可）改造。
