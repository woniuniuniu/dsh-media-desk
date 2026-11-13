# X 工作台：学习、长文与复盘 实施计划（计划 2 / 3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作台知道负责人实际发了什么、改了什么、效果如何，据此提出写作规则建议并帮助他过渡到自己的风格；另外提供每周长文的选题、初稿和改稿，以及一个复盘页。

**Architecture:** 仍然只通过交换文件夹取数据：`mine/` 是负责人自己账号发出的内容，`replies/` 是 Grok Bot 起草过的回复。后台每分钟读入这两类文件，按文字相似度把实发内容和候选稿配对，得到"已发"状态和"草稿到实发"的差异；每天至多一次据此生成规则建议。长文是独立的一条小流水线，用核心风格的完整版。

**Tech Stack:** 与计划 1 相同，不新增依赖。

**Spec:** `docs/product/2026-11-11-x-desk-design.md` 第 6.4（已发识别）、6.5（长文）、6.6（学习）、6.7（复盘）节。前置：计划 1 全部完成。

## Global Constraints

- 计划 1 的全部 Global Constraints 继续有效（包名、数据目录、不读 X、不可信数据、中文界面、不新增依赖、红线、提交信息格式、时间相关测试首行设 `TZ`）。
- 一切放进提示词的外部文字（实发内容、别人的帖子、草稿）都必须经 `wrapMaterial`。
- 规则建议永不自动生效：只有负责人点"采纳"才写入 `state.rules`。
- 核心风格永不被自动替换：提炼"自己的风格"只产生一份并排预览，由负责人决定。
- 后台自己的写入不占用撤销栈（`undoable: false`）。
- 状态新增字段都要在 `emptyState()` 给出初值，并在 `migrateState()` 里为已有的第 2 版数据补齐（不提升版本号）。

## Review Focus

1. **同一条实发内容被重复读入**（每次读取都带来新的互动数）：只保留一条，互动数取最新，配对结果不变。→ Task 1、Task 2
2. **负责人把草稿改得面目全非，或发了一条和任何草稿都无关的内容**：不得误配成某条候选稿；无关内容照常进入复盘。→ Task 2
3. **两条候选稿文字很像**（同一选题的两个版本）：一条实发内容只配给最像的那一条，另一条保持原状态。→ Task 2
4. **学习样本太少**（刚开始用、只发了两三条）：不提任何建议，不调用模型。→ Task 3
5. **长文写到一半模型失败或返回空内容**：已有正文不被清空，界面看到明确的失败原因，可重试。→ Task 5

---

## 数据模型的新增部分

```js
// state 新增
mine: [],        // {id(=postId), kind:'post'|'reply'|'quote', text, url, postedAt, fetchedAt,
                 //  likes, replies, reposts, quotes, views, inReplyTo: {handle, postId}|null,
                 //  candidateId: string|null, replyId: string|null}     保留 180 天
replyDrafts: [], // {id(r_xxxx), toHandle, toPostId, drafts: [string, string], notifiedAt,
                 //  sentText: string|null, sentAt: string|null}          保留 90 天
followers: [],   // {day:'YYYY-MM-DD', count}   每天一条，取当天最后一次读到的值
proposals: [],   // {id(p_xxxx), name, rule, evidence, source:'length'|'edits', createdAt}
longforms: [],   // {id(l_xxxx), title, angle, body, aiBody, status:'idea'|'draft'|'done',
                 //  createdAt, updatedAt, revision, error: string|null}
// runs 新增
runs.lastLearnDay: null, runs.learnedPairs: 0, runs.ownVoicePrompted: false, runs.lastLongformWeek: null
// 候选稿新增
candidate.sentText: null, candidate.sentPostId: null, candidate.sentAt: null
```

交换文件新增两种：

```jsonc
// mine/<任意名>.json   由 Grok Bot 写入：负责人自己账号发出的一条内容
{ "schema": 1, "postId": "1856000000000000001", "kind": "post"|"reply"|"quote", "text": "…",
  "postedAt": "…", "fetchedAt": "…",
  "metrics": { "likes": 0, "replies": 0, "reposts": 0, "quotes": 0, "views": 0 },
  "inReplyTo": { "handle": "karpathy", "postId": "1855000000000000001" },   // 仅 reply 有
  "followers": 1234 }                                                        // 可选：读取时的粉丝数

// replies/<任意名>.json   由 Grok Bot 写入：它起草并通知过的一次回复
{ "schema": 1, "toHandle": "karpathy", "toPostId": "1855000000000000001",
  "drafts": ["草稿一", "草稿二"], "notifiedAt": "…" }
```

`mine` 的链接不读文件里的值：设置里新增 `ownHandle`（负责人自己的账号名，同样只接受 `/^[A-Za-z0-9_]{1,15}$/`），链接由它和 `postId` 拼出；未设置时为 `null`。

---

### Task 1: 读入 `mine/` 与 `replies/`

**Files:** Modify `src/exchange.js`、`src/seed.js`、`src/settings.js`；Create `scripts/sample-exchange/mine/*.json`（5 个）、`scripts/sample-exchange/replies/*.json`（2 个）；Test `test/exchange-mine.test.js`

**Interfaces — Produces:**
- `parseMine(raw, {ownHandle}): Mine|null`、`parseReplyDraft(raw): ReplyDraft|null`，校验规则沿用 `parsePost` 的做法：`schema === 1`；`postId`/`toPostId` 匹配 `/^\d{5,25}$/`；`kind` 只能是三个枚举值，缺省按 `post`；`text` 截到 4000；`drafts` 必须是 1 到 3 个非空字符串，每个截到 1000；`inReplyTo` 仅在 `kind === 'reply'` 且两个字段都合法时保留，否则为 `null`；`followers` 为 0 到 1e9 的整数否则忽略；互动数同 `parsePost`。返回对象带 `followers`（数字或 `null`）供调用方记入粉丝序列，但它不属于 `Mine` 本身。
- `Exchange.readNew(kind)` 接受 `'mine'` 与 `'replies'`，行为与已有两种一致（已读记录、坏文件、10 秒内的半成品重试、读取失败不记已读）。`readNew('mine', {ownHandle})` 把 `ownHandle` 传给解析函数。
- `emptyState()` 与 `migrateState()` 补齐"数据模型的新增部分"里的全部字段；`Settings` 新增 `ownHandle`（默认 `''`，`update` 时去掉开头的 `@` 并校验格式，非法则 400）。

- [ ] **Step 1: 写失败的测试**，至少包含：合法样例解析结果的每个字段；非法 `postId`、非法 `kind`、空 `drafts`、4 个草稿（取前 3 个）、`drafts` 含非字符串；`kind: 'post'` 带 `inReplyTo` 时被置空；`followers` 为负数、小数、字符串时为 `null`；`ownHandle` 为空时 `url` 为 `null`，否则为 `https://x.com/<ownHandle>/status/<postId>`；`readNew('mine')` 与 `readNew('replies')` 对坏文件的处理与 `posts` 一致；每个新样例文件都能解析；旧的第 2 版状态经过 `migrateState` 后带有全部新字段且原有数据不变。
- [ ] **Step 2: 运行确认失败** — `node --test test/exchange-mine.test.js`
- [ ] **Step 3: 实现**。样例内容自拟：`mine/` 里 3 条 `post`（其中一条的文字与某个示例候选稿场景接近，供后续配对测试）、1 条 `reply`（`inReplyTo` 指向 `replies/` 样例里的帖子）、1 条 `quote`；带递增的 `followers`。
- [ ] **Step 4: 运行确认通过** — `npm test && npm run build`
- [ ] **Step 5: 提交** — "能读入自己账号发出的内容和 Grok Bot 起草过的回复"

---

### Task 2: 配对：识别"已发"并记录差异

**Files:** Create `src/match.js`；Test `test/match.test.js`

**Interfaces — Produces（纯函数，不做读写，不取时钟）:**
- `normalizeText(text): string`：去掉网址、`@账号`、首尾空白，把连续空白压成一个空格，转小写。
- `similarity(a, b): number`（0 到 1）：对 `normalizeText` 后的两段文字取**字符二元组**集合的 Jaccard 系数；任一为空返回 0。
- `matchSent(state, {now}): {changed: number}`，就地修改 `state`：
  - 对每条 `kind` 为 `post` 或 `quote`、尚无 `candidateId` 的 `mine`：在状态为 `pending`、`approved`、`sent` 且 `sentPostId` 为空的候选稿中，取 `createdAt` 在该条 `postedAt` 之前 96 小时内的，计算与候选稿 `text` 的相似度；最高者不低于 **0.55** 才算配上。配上后：候选稿 `status = 'sent'`、`sentText`、`sentPostId`、`sentAt = postedAt`、`decidedAt` 若为空则设为 `postedAt`；`mine.candidateId` 记下。一条候选稿只能配给一条实发内容，一条实发内容只配给一条候选稿；多对多时按相似度从高到低贪心分配。
  - 对每条 `kind === 'reply'`、带 `inReplyTo`、尚无 `replyId` 的 `mine`：找 `toPostId` 相同且 `sentText` 为空的 `replyDrafts`，取 `notifiedAt` 最近的一条，写入 `sentText`、`sentAt`，并记 `mine.replyId`。回复不要求相似度（负责人可能完全重写）。
- `editPairs(state): {aiText, sentText, kind:'post'|'reply'}[]`：所有"模型最初版本"与"实发版本"都存在且 `similarity < 0.98` 的对子。候选稿用 `aiText` 对 `sentText`；回复用与 `sentText` 最相似的那个草稿对 `sentText`。

- [ ] **Step 1: 写失败的测试**，至少包含：
  - `similarity('今天聊聊模型评测', '今天聊聊模型评测') === 1`；只差一个网址或一个 `@账号` 时仍为 1；完全无关的两句低于 0.2；任一为空为 0。
  - 负责人小改（删一句、换几个词）后仍配上，候选稿变 `sent` 且 `sentText` 是实发文字。
  - **Review Focus 2**：改得面目全非（相似度低于 0.55）不配对，候选稿状态不变；一条与任何草稿无关的实发内容保持 `candidateId: null`。
  - **Review Focus 3**：两条相似的候选稿、一条实发内容，只有最像的那条变 `sent`，另一条不变；两条实发内容与两条候选稿交叉相似时，分配结果是相似度总和更高的那一种贪心结果（给出具体数值的夹具）。
  - 已丢弃、已过期的候选稿不参与配对；创建时间在发帖时间之后或早于 96 小时的不参与。
  - **Review Focus 1**：对同一状态连续调用两次 `matchSent`，第二次 `changed === 0`，结果不变。
  - 回复按 `toPostId` 配对；同一帖子有两次起草时取 `notifiedAt` 最近的；`editPairs` 对回复取最相似的草稿。
- [ ] **Step 2–4:** 运行确认失败 → 实现 → `npm test`
- [ ] **Step 5: 提交** — "能认出哪些稿子已经发出，并记下实际发出的文字"

---

### Task 3: 规则建议与"自己的风格"

**Files:** Create `src/learn.js`；Modify `src/ai.js`（新增 `rulePrompts`）、`src/ops.js`（新增两个操作）、`src/compose.js`（选题参考历史）；Test `test/learn.test.js`

**Interfaces — Produces:**
- `lengthProposal(pairs): Proposal|null`（纯函数）：只看 `kind === 'post'` 的对子，不足 5 对返回 `null`；取 `sentText` 字数除以 `aiText` 字数的中位数，低于 0.8 时建议"写短一点"，规则文字为"正文控制在 N 个字以内"，`N` 为实发字数中位数向上取整到 10；高于 1.25 时建议"可以写长一点"，同理；其余返回 `null`。`evidence` 写明样本数和比例。
- `rulePrompts(pairs): {system, user}`：给模型最多 10 个对子（每个对子的两段文字各自经 `wrapMaterial`，各截到 600 字符），要求找出作者**反复出现**的修改习惯，只输出 JSON 数组，最多 3 项，每项 `{"name"(≤12字),"rule"(≤60字),"evidence"(≤60字)}`；只出现一次的修改不要总结。
- `async proposeFromEdits({callText}, pairs): Proposal[]`：不足 5 对直接返回 `[]` 且**不调用模型**（Review Focus 4）；模型失败或返回无法解析时返回 `[]`；结果逐项截断长度，丢弃 `rule` 为空的项。
- `async learnDaily({store, callText, now}): {proposals: number}`：当天已跑过（`runs.lastLearnDay`）则跳过；`editPairs` 的数量没有比 `runs.learnedPairs` 多出至少 5 对也跳过（并更新 `lastLearnDay`）；否则生成建议，与现有 `state.rules` 和 `state.proposals` 中 `rule` 文字相同的去重后追加到 `state.proposals`（最多保留 10 条，超出丢弃最旧的），更新 `runs.learnedPairs` 与 `lastLearnDay`。另外：`mine` 里 `kind === 'post'` 的条数达到 **30** 且 `runs.ownVoicePrompted` 为假时，追加一条提示"你自己发出的内容已有 30 条，可以到风格页提炼你自己的核心风格了"并置 `ownVoicePrompted = true`。
- `async extractOwnVoice({callText, state}): Style`：取最近 40 条自己的 `post` 文字拼接，调用已有的 `stylePrompts` 与 `normalizeStyle`，**只返回卡片，不保存**。
- 操作：`accept_proposal {id}`（移入 `state.rules`，`status: 'active'`）、`dismiss_proposal {id}`。
- `topicPrompts(posts, types, history)`：新增第三个可选参数 `{approved: string[], discarded: string[]}`（各最多 20 个候选稿标题，经 `wrapMaterial`），提示词中说明"作者近期采纳过和丢弃过的选题，仅作偏好参考"；`Composer.composeDaily` 传入最近的标题。不传时行为与原来完全一致。

- [ ] **Step 1: 写失败的测试**，至少包含：`lengthProposal` 的三个分支与样本不足；`proposeFromEdits` 在 4 对时不调用模型（断言假模型的调用次数为 0）；模型返回乱码时为 `[]`；`learnDaily` 的去重、上限 10 条、每天只跑一次、样本增量不足时不调用模型；第 30 条时只提示一次；`extractOwnVoice` 不改变状态；两个操作；`composeDaily` 的选题提示词在有历史时包含被采纳和被丢弃的标题、且标题里的 `</material>` 不能关闭素材块。
- [ ] **Step 2–4:** 运行确认失败 → 实现 → `npm test`
- [ ] **Step 5: 提交** — "从你的修改里提出写作规则建议，攒够内容后提醒你提炼自己的风格"

---

### Task 4: 后台接入与路由

**Files:** Modify `src/worker.js`、`src/host.js`；Test `test/worker-learn.test.js`

**Interfaces — Produces:**
- `Worker.tick()` 在"读入处理结果"之后、"过期"之前增加：读入 `mine`（按 `id` 合并，已存在的只在 `fetchedAt` 更晚时更新互动数，`candidateId`/`replyId` 保持不变；带 `followers` 的记入当天的 `state.followers`，同一天取 `fetchedAt` 最晚的值）；读入 `replies`（按 `toPostId + notifiedAt` 去重后追加到 `replyDrafts`）；调用 `matchSent`。在"每日成稿"之后调用 `learnDaily`。各自的保留期（180 天、90 天、粉丝序列 400 天）在这里裁剪。任何一步抛错只记提示，不影响其余步骤。
- 路由：`POST voice/extract-own` → `{style}`（自己的 `post` 不足 10 条时 400，说明还差多少条）；`GET insights` 见 Task 6。
- `GET state` 的返回值不变（新字段已在 `state` 里）。

- [ ] **Step 1: 写失败的测试**，至少包含：放入 `mine/` 样例后候选稿被标为已发，且下一轮不再为它写新的 `drafts/` 文件；同一条实发内容再次出现只更新互动数（Review Focus 1）；粉丝序列一天一条；`replies/` 重复文件不重复入库；`learnDaily` 抛错时本轮其余步骤照常完成。
- [ ] **Step 2–4:** 运行确认失败 → 实现 → `npm test && npm run build`
- [ ] **Step 5: 提交** — "后台自动读入实发内容、识别已发、每天学习一次"

---

### Task 5: 长文

**Files:** Create `src/longform.js`；Modify `src/ai.js`（新增三组提示词）、`src/ops.js`、`src/host.js`；Test `test/longform.test.js`

**Interfaces — Produces:**
- `longformIdeaPrompts({bestPosts, views, types})`、`longformDraftPrompts({title, angle, materials, voice})`、`longformRevisePrompts({body, instruction, voice})`。初稿要求：1500 到 2500 字，Markdown，小标题不超过 5 个；不得编造亲身经历，需要处写"【此处填你的经历】"；素材全部经 `wrapMaterial`；风格用 `voiceFor(state, typeId, {long: true})`。
- `class Longform { constructor({store, callText, now}) }`
  - `async suggest(): Promise<{created: number, error: string|null}>`：素材为最近 14 天互动最高的 8 条自己的 `post`，加上候选稿里负责人写过的 `view`（最多 10 条）。要求模型给 2 到 3 个选题 `{"title","angle","typeId"}`，存为 `status: 'idea'`。素材为空时不调用模型，返回 `error: '还没有足够的内容来建议长文选题'`。未处理的 `idea` 已有 6 个时不再生成。
  - `async draft(id)`：`idea → draft`，写入 `body` 与 `aiBody`。**模型失败或返回空内容时保持 `idea` 状态并把原因写入 `error` 字段，已有 `body` 不变**（Review Focus 5）。
  - `async revise(id, instruction)`：只对 `draft`；成功后 `revision += 1`；失败时 `body` 不变、`error` 记原因。
- 操作：`add_longform {title, angle?}`（手动加选题）、`edit_longform {id, title?, body?}`（`body` 上限 20000 字符）、`finish_longform {id}`（`draft → done`）、`delete_longform {id}`。
- 路由：`POST longform/suggest`、`POST longform/draft {id}`、`POST longform/revise {id, instruction}`。`maxTokens`：选题 1500，初稿与改稿 6000。
- 后台：每周一次（周一成稿之后，`runs.lastLongformWeek` 记 ISO 周）自动调用 `suggest()`；失败只记提示。

- [ ] **Step 1: 写失败的测试**，至少包含：`suggest` 的正常、素材为空（不调用模型）、已有 6 个选题时不再生成；`draft` 成功；**Review Focus 5**：`draft` 遇到模型抛错与返回空内容两种情况；`revise` 失败时正文不变；初稿提示词含完整版风格与"【此处填你的经历】"；四个操作及其状态限制；`body` 超长被拒绝；每周只自动建议一次。
- [ ] **Step 2–4:** 运行确认失败 → 实现 → `npm test && npm run build`
- [ ] **Step 5: 提交** — "每周建议长文选题，一键出初稿，说一句话就能改"

---

### Task 6: 复盘数据

**Files:** Create `src/insights.js`；Modify `src/host.js`（`GET insights`）；Test `test/insights.test.js`

**Interfaces — Produces（纯函数）:** `computeInsights(state, now)` 返回：
```js
{ followers: { series: [{day, count}], now, delta7, delta30 },      // 没有数据时 now/delta 为 null
  totals: { d7: {posts, replies, views, likes}, d30: {…} },
  byType: [{typeId, name, posts, avgViews, avgEngagement}],        // 只统计配上候选稿的内容
  top: [{id, text(截 80 字), url, views, likes, replies, reposts, typeName|null}],   // 30 天内按 engagement 取前 5
  replies: { drafted, sent, sentRate, avgEngagement },             // 30 天内
  funnel: { drafted, approved, sent, discarded, expired, discardReasons: {not_interested, not_me, stale, none} },  // 30 天内的候选稿
  edits: { pairs, medianLengthRatio } }
```
`engagement` 复用 `src/score.js` 的同名函数。除数为 0 时结果为 0，不得出现 `NaN`。

- [ ] **Step 1: 写失败的测试**：空状态下每个字段的形状和零值；一个手工构造的小数据集上每个数字的精确值；粉丝序列只有一天时 `delta7` 为 `null`。
- [ ] **Step 2–4:** 运行确认失败 → 实现 → `npm test`
- [ ] **Step 5: 提交** — "复盘数据：粉丝变化、每条内容的表现、哪类内容更好、回复的效果"

---

### Task 7: 界面：长文、复盘、规则建议、已发标记

**Files:** Create `client/longform.jsx`、`client/insights.jsx`；Modify `client/index.jsx`、`client/desk.js`、`client/style.jsx`、`client/inbox.jsx`、`client/schedule.jsx`、`client/settings.jsx`、`client/styles.css`

**Interfaces — Produces:**
- 导航改为 **收件箱 · 长文 · 排期 · 复盘 · 风格**。
- **长文页**：左侧选题列表（`idea`、`draft`、`done` 分组），顶部"建议几个选题"与"自己加一个"；选中后右侧显示正文编辑区（失焦保存）、"出初稿"（仅 `idea`）、"说一句来改"、"复制全文"、"标为完成"、删除；`error` 非空时在正文上方显示原因和"重试"；正文里的"【此处填你的经历】"高亮。
- **复盘页**：粉丝曲线（内联 SVG 折线，不引入图表库）、7 天与 30 天的数字卡、按类型的对比表、表现最好的 5 条、回复的起草数与发出数、候选稿去向（通过、发出、丢弃及原因、过期）。没有任何 `mine` 数据时显示说明："这里的数据来自交换文件夹的 mine/ 目录，接上 Grok Bot 后才会有。"
- **风格页**新增"规则建议"区（每条有采纳、忽略）和"提炼我自己的风格"入口（调用 `voice/extract-own`，结果与当前核心风格左右并排，三个按钮：替换、不动、手动合并后保存）。
- **收件箱与排期**：`sent` 的稿子显示"已发"和实发时间；实发文字与草稿不同时可展开对比。
- **设置**新增"我的账号名"（`ownHandle`）。

- [ ] **Step 1: 实现**
- [ ] **Step 2: 验证** — `npm test && npm run build`
- [ ] **Step 3: 提交** — "新增长文页和复盘页；风格页能处理规则建议和提炼自己的风格"

---

### Task 8: 收尾

**Files:** Modify `scripts/seed-sandbox.sh`（一并复制 `mine/` 与 `replies/` 样例）、`scripts/mock-llm.mjs`（应答规则建议、长文选题、长文初稿三类请求）、`README.md`（补充两种新文件格式）、`test/guard.test.js`（若新增文件触碰了防护名单则更新）；Create `docs/spikes/2026-11-12-plan2-walkthrough.md`

- [ ] **Step 1:** 更新脚本与说明；`npm test && npm run build`。
- [ ] **Step 2:** 若终端里有 `dsh` 命令，在沙盒里走一遍：放入样例 → 候选稿被标为已发 → 复盘页有数字 → 长文页出选题和初稿 → 风格页出现规则建议。没有 `dsh` 命令则跳过实机步骤，在走查记录里如实写明"未做实机验证，原因是终端里没有 dsh 命令"。
- [ ] **Step 3:** 写走查记录并提交 — "计划 2 收尾：样例、模拟模型和说明"
