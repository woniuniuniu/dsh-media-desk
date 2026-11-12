# dsh-x-desk

**一句话：** DeepSeek Harness（DSH，一个桌面 AI 工具）的插件，服务于一个人运营一个 X 账号。它每天早上把素材整理成选题、写成候选推文放进收件箱；你只做三件事：看、改、点通过。到点后点一下"去 X 发布"，由你自己在 X 上发出，插件不代为发送。

## 数据放在哪里

全部在 `~/.dsh/x-desk/`（你的用户目录下，插件自己的文件夹）。密钥只存在其中的 `settings.json`，权限 600（只有你自己能读）。这个插件不会读写原版插件的 `~/.dsh/media-desk/`。

数据目录必须放在本机磁盘上，而且这块磁盘要支持硬链接（一种让两个文件名指向同一份内容的文件系统功能，后台用它防止两个程序同时处理）；不能放在 exFAT 格式的移动硬盘或网络共享盘上。

插件和外界交换内容靠一个"交换文件夹"，默认是 `~/.dsh/x-desk/exchange/`，也可以在设置里换成别的目录（不能设在原版插件的数据目录里）。里面按用途分子文件夹，每个文件都是一个小的文本文件（JSON 格式）。

## 交换文件夹里的四种文件

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

## 不连任何外部服务，怎么试一下

1. 在 DSH 里启用插件，打开"X 工作台"。
2. 把 `scripts/sample-exchange/posts/` 里的 6 个 `.json` 文件复制到 `<交换文件夹>/posts/`。
3. 后台每分钟读一次交换文件夹，格式正确的文件在下一轮（一分钟内）被读入；只有看起来还没写完的文件会再等 10 秒确认。到了设置里的每日成稿时间，或在收件箱点"现在就出一批"，就会出现候选稿。

注意：超过 14 天的帖子会被当作过期素材丢掉；交换文件夹里修改时间超过 30 天的文件会被完全忽略。`scripts/sample-exchange/` 里的示例时间是固定的旧日期，直接复制会被丢掉；用沙盒造数脚本 `scripts/seed-sandbox.sh` 复制时会自动把时间改成最近。

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

把示例帖子放进沙盒的交换文件夹：

```bash
scripts/seed-sandbox.sh
```

## 许可

基于 woniuniuniu/dsh-media-desk（MIT 许可）改造。
