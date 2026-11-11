# 沙盒走查记录（2026-11-12）

## 结论

**真实环境里的 8 步走查没有做。** 原因：这台电脑的终端里找不到 `dsh` 命令（`command -v dsh` 无输出），而开启它需要负责人在 DeepSeek Harness 桌面版菜单里选"管理 dsh 命令"。没有绕过，也没有启动桌面应用。下面的 8 步请负责人开启 `dsh` 后自行走一遍，并把结果补在这份记录里。

## 待负责人执行的 8 步

前提：先开启 `dsh` 命令，然后运行 `node scripts/mock-llm.mjs &` 和 `scripts/dev-sandbox.sh`，在沙盒的 DSH 设置里把文字模型指向模拟模型，另开终端执行 `scripts/seed-sandbox.sh`。

- [ ] 1. 设置里把每日成稿时间改为当前时间的后两分钟，两分钟后收件箱出现候选稿（或点"现在就出一批"）。
- [ ] 2. 对一条候选稿"加一句我的看法"，正文发生变化。
- [ ] 3. 通过一条，排期页出现它；点"去 X 发布"，新窗口地址以 `https://x.com/intent/tweet?text=` 开头（不需要登录或真的发出）。
- [ ] 4. 丢掉一条并选原因；点撤销，它回到待处理。
- [ ] 5. 风格页用粘贴全文的方式引入一段 skill，出现可编辑的精简版。
- [ ] 6. 账号名单加两个账号，沙盒的 `x-desk/exchange/voice/watchlist.json` 内容随之变化。
- [ ] 7. 往 `x-desk/exchange/posts/` 放一个内容为 `{oops` 的文件，一分钟后收件箱出现一条提示，其他功能不受影响。
- [ ] 8. 往 `x-desk/exchange/decisions/` 放一个对某条待处理候选稿的 `approve` 文件，一分钟后该稿进入排期。

## 已自动验证的内容（不需要 dsh）

- `test/e2e.test.js`：在进程内启动模拟模型，用真实的存储、设置、成稿、交换文件夹、锁和后台处理，走通：示例帖子读入、出候选稿、写出 `drafts/*.json`（`intentUrl` 以 `https://x.com/intent/tweet?text=` 开头）、`voice/SKILL.md` 含"不代为发送"、`approve` 后进入排期、`view` 后修订号为 1 并写出 `-r1.json`、坏文件 `{oops` 只留一条点名该文件的提示而其他照常。对应上面第 1、3（前半）、7、8 步的后台部分，以及第 2 步的"手机端看法"路径。
- `test/mock-llm.test.js`：模拟模型识别用的措辞与真实提示词一致（提示词改了会失败）；通过 HTTP 应答选题、精简版、推文三类请求，选题引用的帖子编号取自请求。
- `test/seed-sandbox.test.js`：`scripts/seed-sandbox.sh` 对临时沙盒目录复制出全部示例帖子；`scripts/dev-sandbox.sh` 在找不到 `dsh` 时给出中文提示并非零退出。
- `test/guard.test.js`：后台代码不碰 X 接口和抓取服务；x.com 只出现在约定文件里；只有 `src/images.js` 与 `src/harvest.js` 可联网；不出现 `media-desk`；没有点赞、发帖、转发、关注的调用；没有运行时依赖，开发依赖只有 `esbuild`。

## 没有验证的内容

界面本身（第 2、4、5、6 步的页面操作、撤销、新窗口跳转）、与真实 DSH 的对接、真实模型的输出质量。

## 发现的问题

无（走查未进行）。本任务顺手清理：`src/harvest.js` 里已无调用方的网页抓取函数已删除，只保留给生图用的内网地址校验。
