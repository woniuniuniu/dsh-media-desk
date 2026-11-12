<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-en-dark.webp">
    <img src="docs/assets/hero-en-light.webp" alt="Media Desk: from one idea to a finished post" width="100%">
  </picture>
</p>

<h1 align="center">Media Desk</h1>

<p align="center"><b>A DeepSeek Harness plugin. Capture an idea, and one click drafts the script, cover, images and storyboard.</b></p>

<p align="center">Built by <a href="https://www.xiaohongshu.com/user/profile/5faedce8000000000101c8a3"><b>蜗牛的科技笔记</b></a> (Snail's Tech Notes), a tech creator on RedNote, as the desk behind their own daily posts.</p>

<p align="center">
  <a href="#get-started">Install</a> ·
  <a href="#what-it-costs">What it costs</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="README.md">简体中文</a>
</p>

<p align="center">
  <img alt="DeepSeek Harness 0.2.x" src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-111?style=flat-square">
  <img alt="Mac desktop and web" src="https://img.shields.io/badge/Mac%20desktop-web-111?style=flat-square">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/MIT-open%20source-111?style=flat-square"></a>
  <a href="https://github.com/woniuniuniu/dsh-media-desk/stargazers"><img alt="Star" src="https://img.shields.io/github/stars/woniuniuniu/dsh-media-desk?style=flat-square&color=111&label=Star"></a>
</p>

<br>

## What it is

Media Desk is a page in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sidebar. Choose an account from the account list to enter its content workspace. Record an idea, open it, click **Draft it**, and you get a spoken script, a title, a video cover, images and a six-frame storyboard. Ask for changes in the chat on the left and the draft updates on the right. Then drag the finished piece onto the calendar, publish it, and come back for the numbers.

Each account has six child pages: **Ideas · Content · Schedule · Insights · Account · Styles**. The interface is available in English and Chinese. By default it follows the DeepSeek Harness language, and you can lock it to either one in the plugin settings. When the interface is in English, scripts, titles and storyboards are written in English. The web version also works in a phone browser.

The account list is the main menu: choose an account to enter its Content workspace, then use Inspiration, Content, Schedule, Insights, Account and Styles within that account. The Account tab shows only that profile and its independent defaults; the Account list breadcrumb returns to the main menu. Search, groups, CSV add and archive/restore stay in the main menu. All accounts and Unassigned entries retain access to existing content.

Add or edit an account to upload, preview, change or remove its avatar, or enter an optional image URL. Avatars appear in the account list, profile and workspace header, with initials as a fallback. CLI/MCP `add_account` and `update_account` accept `avatar` as an HTTP(S) URL or existing workbench image reference; `list_accounts` and `get_account` return it, and `null` removes it. Uploads happen on Save; files remain available for Undo.

The source version prepared in this repository is `2.7.0-accounts.5`; changing source does not update an existing installation. The studio now provides named persistent V1/V2/V3 content versions, read-only previews and restore. Restoring first archives your current content. Versions survive restarts and older Undo records. Finish or cancel article editing first; failed title/body saves block version actions.

The first review increment lives inside account Content and Insights: select a saved version and explicit format, evaluate, generate a separate forecast preview, explicitly lock after reading, declare actual publication, then select an exact due observation for retrospective. Evaluation, forecast and retrospective each use the existing model once; reading, locking and registration do not. Presets are uncalibrated. Historical reviews cannot become fresh predictions; fewer than three comparable prior works or a zero median supports qualitative bets only. The UI retains real observation times, lateness, unknown counters and publication manuscript mismatches. Uncertain actions keep their recovery ID and require manual read-only checking. See [the full workflow and API](docs/automation.md#saved-version-review-prediction-and-timed-retrospective).

This is source preparation, not an npm release or desktop installation update. The previously verified installed runtime remains `2.7.0-accounts.3`; the market index remains upstream `2.7.0`. Personas, benchmark imports, topics and formula recalibration are future increments. Review-loop attribution: [XBuilderLAB/cheat-on-content](https://github.com/XBuilderLAB/cheat-on-content), [MIT license](https://github.com/XBuilderLAB/cheat-on-content/blob/d88d004abcabfe6656a007b8fb4e7ed4ea7a4c89/LICENSE), commit [d88d004abcabfe6656a007b8fb4e7ed4ea7a4c89](https://github.com/XBuilderLAB/cheat-on-content/commit/d88d004abcabfe6656a007b8fb4e7ed4ea7a4c89).

Every export seals a content version and creates a new folder, preserving earlier exports and user edits. Its `manifest.json` identifies the item, version, content SHA-256 and export time. Edits/restores during an export do not change the sealed output; the current production is marked saved only if its content still matches. Versions, restore and export require no model or Monid. History is not automatically pruned and contains text and asset references, not copied binary assets; missing assets cannot be reconstructed from history. See [automation](docs/automation.md#persistent-content-versions-and-exports) for CLI/MCP usage and limits.

Version `2.7.0-accounts.5` adds local image/video import to the upstream 2.7.0 features and account workspaces: independent script/article preferences per account, a format snapshot for each production, per-run image overrides and later individual asset drawing. It retains reference excerpts, reasoning/storytelling/transitions, Bailian/Wan protocols and better-sidebar support. Migration preserves existing text, attribution and settings.

CLI and MCP share 20 tools. `media-desk import '/local/path/image.png' --input '{"accountId":"ACCOUNT_ID"}'` adds one image or video idea to that account; omitting the account creates Unassigned content. JPEG/PNG/WebP/GIF images are limited to 25,000,000 bytes, 40 megapixels and 16384 pixels per side; MP4/MOV/WebM videos to 250,000,000 bytes. The source stays unchanged, the copy preserves its exact bytes, and no model is called. MCP `media_desk_import_file` requires an absolute path on the computer running the workbench, including for cloud callers. Responses contain compact metadata, SHA-256 and a workbench media reference only. `--input-file` always reads JSON options. See [automation](docs/automation.md) for request IDs, recovery and media inspection.

To import an account avatar directly, use `--input '{"destination":"avatar","accountId":"ACCOUNT_ID"}'`. This accepts images only, preserves their bytes without cropping, and creates no idea. Title/body/tags are not accepted. Inspect the account's `avatar` and matching `avatarImportRequestId` after an uncertain outcome; Undo retains imported files.

Insights has a platform filter including Kuaishou. Kuaishou supports manual entry, CSV and API metrics; automatic Monid fetching is unavailable. Natural language and CSV accept Kuaishou/Kwai, while structured CLI/MCP requests use canonical `快手`. `media_desk_status.supportedPlatforms` advertises all supported platforms, and `media_desk_get_insights` accepts optional `platform` after explicit account scoping. Account profiles need no social login, model or Monid call. See [automation](docs/automation.md).

It works with TikTok, Instagram, YouTube and X as well as Chinese platforms (RedNote, Douyin, Kuaishou, Bilibili, WeChat). See [account workspaces and Kuaishou support](docs/multi-account-workspaces.md) for migration, scope and validation notes.

<br>

## Draft it in one click

<table>
<tr>
<td width="62%">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/f-studio-en-dark.webp">
    <img src="docs/assets/f-studio-en-light.webp" width="100%" alt="The studio: chat on the left; title, cover, script and a six-frame storyboard on the right">
  </picture>
</td>
<td valign="top">
<p><b>Everything fills in together.</b></p>
<p>The layout appears as soon as you open an idea. The title, script, cover, images and six storyboard frames are generated in parallel and appear as each one is ready.</p>
<p><b>Script or article, your call.</b></p>
<p>A script puts one sentence per line in short blocks, ready to read aloud. An article is written in full paragraphs, ready to post. Both get a headline, and both stay close to the style and reference you chose.</p>
<p><b>Ask for a change.</b></p>
<p>Try "make it clearer", "shoot frame 3 from above" or "bolder cover text". The draft updates as you watch, and every change can be undone.</p>
<p><b>Take it with you.</b></p>
<p>Edit the script in place, copy it, or save the whole piece (cover, images and frames) to one folder.</p>
</td>
</tr>
</table>

<br>

## The idea wall

<table>
<tr>
<td valign="top" width="38%">
<p><b>One line, one idea.</b></p>
<p>Text, links, images, videos and quotes all become cards. Spread them out on an infinite canvas, or switch to a feed sorted by date.</p>
<p><b>Related ideas come to you.</b></p>
<p>Type "agent" and press Enter. Your new idea is saved, and every earlier idea that mentions agents moves next to it, sorted by relevance.</p>
<p><b>An assistant on the side.</b></p>
<p>"Write up today's best idea", "What's coming up?", "From now on, keep titles under 10 words". Ask in a sentence and it's done.</p>
</td>
<td>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/f-home-en-dark.webp">
    <img src="docs/assets/f-home-en-light.webp" width="100%" alt="The idea wall as a freeform canvas with the assistant open, and as a feed">
  </picture>
</td>
</tr>
</table>

<br>

## Schedule

<table>
<tr>
<td width="62%">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/f-schedule-en-dark.webp">
    <img src="docs/assets/f-schedule-en-light.webp" width="100%" alt="The schedule calendar with the next post and the list of unscheduled pieces">
  </picture>
</td>
<td valign="top">
<p><b>One calendar for ideas and posts.</b></p>
<p>Each day you capture an idea gets a stamp, so you can see your streak. Drag a finished piece from the side list onto a day to schedule it.</p>
<p>Your next post is always pinned in the top right.</p>
</td>
</tr>
</table>

<br>

## Insights

<table>
<tr>
<td valign="top" width="38%">
<p><b>See what worked, and keep doing it.</b></p>
<p>Enter numbers by hand, paste a CSV, or import your own account. You'll see daily views, a breakdown by platform and your top pieces in one place.</p>
<p>Turn a suggestion into a writing rule with one click and it applies to everything you write next. Rules can be exported as a DeepSeek Harness skill.</p>
</td>
<td>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/f-insights-en-dark.webp">
    <img src="docs/assets/f-insights-en-light.webp" width="100%" alt="Insights: a one-line summary, daily views, views by platform, top pieces and suggestions">
  </picture>
</td>
</tr>
</table>

<br>

## Styles

<table>
<tr>
<td width="62%">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/f-style-en-dark.webp">
    <img src="docs/assets/f-style-en-light.webp" width="100%" alt="Style presets grouped by category, and the content board">
  </picture>
</td>
<td valign="top">
<p><b>Pick a voice.</b></p>
<p>Fifteen creator presets in eight categories: tech, travel and food, lifestyle, opinion, tutorials, reviews, stories and news. Pick one and start writing.</p>
<p><b>Or use your own.</b></p>
<p>Import your account or paste a few of your posts, and Media Desk learns your style into a card you can edit.</p>
<p>The content board shows where every piece stands: idea, outline, draft, ready or published.</p>
</td>
</tr>
</table>

<br>

<a id="get-started"></a>
## Get started

Requires DeepSeek Harness `0.2.1-rc.5` or later in the `0.2.x` line. Tested on `0.2.2-rc.1`, desktop and web.

**1. Install.** Open **Plugins** in the DeepSeek Harness sidebar and switch on the experimental index support: on DSH `0.2.2` and later it is **Custom plugin indexes** under **Experimental plugins**; on the `0.2.1` line it is **Custom plugin markets**, under **More** beside **Experimental plugins**. The page then shows the **Installed** and **Discover** tabs.

Switch to **Discover** and add this index URL — once is enough:

```
https://raw.githubusercontent.com/woniuniuniu/dsh-media-desk/main/index.json
```

If github.com is hard to reach from your network, use this CDN mirror instead — it can lag up to 12 hours behind the latest release:

```
https://cdn.jsdelivr.net/gh/woniuniuniu/dsh-media-desk@main/index.json
```

**Media Desk** shows up in the list; install it from there. It installs the same `dsh-media-desk` npm package, the index just saves typing the package name.

Without the index, go to Plugins → Add plugin, enter `dsh-media-desk`, and install. You can also install from the command line. Quit the desktop app completely (⌘Q) first and reopen it afterwards. For the web version, restart `dsh web`. If the `dsh` command isn't available in your terminal, choose "Manage dsh command" from the desktop app's menu.

```bash
dsh plugin --profile desktop add dsh-media-desk
```

```bash
dsh plugin --profile web add dsh-media-desk
```

**2. Update.** When a new version comes out, the Plugins page shows an update — click it; a command-line install runs the same command again. To install offline, download `dsh-media-desk-*.tgz` from [Releases](https://github.com/woniuniuniu/dsh-media-desk/releases/latest) and use `"file:$PWD/dsh-media-desk-VERSION.tgz"` in place of the package name.

**3. Open.** **Media Desk** appears in the sidebar. On first launch it's filled with sample data so you can explore every page. Click **Clear sample data** in the top right when you're ready to start with your own.

To uninstall, replace `add` with `remove`. Your content stays in `~/.dsh/media-desk/`.

<br>

<a id="what-it-costs"></a>
## What it costs

The plugin is free and ships with no API keys. Anything that uses a model runs on your own accounts.

| | What it uses | Without it |
| --- | --- | --- |
| **Script** | The model you've set up in DeepSeek Harness | A structural outline only |
| **Cover, images, storyboard** | Your image API key, or a registered DSH subscription image tool, selected in settings | Script and storyboard text still work, and the cover is made from text |
| **Account import** (optional) | Monid, a third-party data service billed per request. Under a cent per TikTok, Instagram or X account; about $0.02 for RedNote | Enter numbers by hand, or paste posts to learn a style |

Images work with any service compatible with the OpenAI Images API (`POST {endpoint}/images/generations`), and with Alibaba Bailian: Qwen-Image uses the sync endpoint, while Wan 2.5 and earlier use the async task API. OpenAI, xAI, Volcengine Ark, Zhipu, SiliconFlow, Alibaba Bailian, Bailian Token Plan and Bailian Wan (async) come pre-filled, or you can add a custom endpoint. Click **Generate test image** to check that it works. Each draft makes 9 images by default, and you can change that; you can also uncheck **Draw images** before **Draft it** to get text only this time, and draw individual images later. Your key is stored only in the local `settings.json` (file mode 600). It never goes into your content data and is never sent to the text model.

<br>

### Use DSH generation tools

Reuse subscription image generation made available to DSH by a plugin. For example, if a plugin lets you generate images in DSH with a ChatGPT (GPT) subscription, Media Desk can reuse that capability without a separate image API key. Subscriptions from other services also require plugin-provided image generation supported by Media Desk; signing in or connecting a chat model alone does not enable it. Currently supports `dsh-plugin-subscriptions`, which controls service and account selection and fallback.

In Settings, choose **DSH generation tools** as the image source to reuse `image_generate` registered by `dsh-plugin-subscriptions` (including its collision alias). No additional API key is needed. Existing HTTP settings (including size and quality) are preserved; tool size and quality are configured separately, and Image API remains the default. Detection only confirms a compatible registration and a direct-call schema from the default executor, not sign-in or quota; **Generate test image** makes a real request and consumes subscription quota. Name/schema checks do not authenticate plugin identity; enable only trusted tool plugins.

The host must support `tools.executable()`, `tools.selectExecutor().describe()` and standalone `tools.execute()` batches (public contracts verified against DSH 0.2.2-rc.1). Calls go through the host execution pipeline without reading credentials or importing subscription-plugin internals. Only images inside the DSH home `plugins/subscriptions/images/` directory are imported into the existing Media Desk asset workflow. Discovery currently checks only `dsh_subscriptions_image_generate` and `image_generate`, not arbitrary tool names. Other plugins must also match the parameters, output structure and output directory even when the name matches. Tools registered only in an Agent-private scope are unavailable.

This is an independent background service operation, not a call on behalf of the visible chat session: it does not inherit that session's restrictions, historical toggles or account affinity. Global host tool policies and current subscription-tool preferences still apply. Approval-required calls without a suitable session fail closed. The tool owns provider/account selection and fallback (for example, Grok may be used when ChatGPT is logged out); Media Desk never falls back to HTTP or adds retries to tool requests.

A pure Code Mode / PTC executor currently rejects direct root image-tool calls and is detected as unavailable. Use a native executor supporting direct calls or HTTP images. Missing tools or unsupported host APIs do not affect existing HTTP functionality.

## Import your own account

In Styles or Insights, click **Import account** and paste your profile link. Supported: TikTok, Instagram, X, RedNote, Douyin and Bilibili. Your latest public posts and their engagement go into Content and Insights, and Media Desk learns your style from them. Importing again only refreshes the numbers.

The first time, connect [Monid](https://monid.ai) in three steps:

1. In a new DeepSeek Harness session, send `set up https://monid.ai/SKILL.md`. It installs the Monid command-line tool.
2. Sign up at [app.monid.ai](https://app.monid.ai/access/api-keys) and create an API key.
3. In your terminal, run `monid keys add -k YOUR_KEY -l main`. Don't paste the key into a chat.

The plugin only runs the local `monid` command and never sees your key.

<br>

<a id="faq"></a>
## FAQ

<details>
<summary><b>Can I import someone else's account?</b></summary>
<br>

Import only accounts you own. Profile links are sent to Monid and its data providers, so check that this fits your platform's terms. Only public data is available: RedNote and Douyin don't show view counts publicly, so Insights uses engagement instead. YouTube, WeChat and WeChat Channels can't be imported yet. You can still schedule posts for them, and paste content or public links to learn a style.

</details>

<details>
<summary><b>Can it post for me?</b></summary>
<br>

No. Platforms don't offer a common publishing API, so copy the script or save the folder and post it yourself. Saved folders go to `~/Documents/Media Desk/` by default and include the script, storyboard, cover, images and frames.

</details>

<details>
<summary><b>Where is my data?</b></summary>
<br>

Everything stays on your computer in `~/.dsh/media-desk/`, shared by the desktop and web versions. No cloud and no sign-up.

</details>

<details>
<summary><b>Does it work without an image model?</b></summary>
<br>

Yes. The script, title and storyboard text are written as usual, and the cover is made from the cover text. Connect an image model to draw the cover, images and frames too.

</details>

<details>
<summary><b>Do I have to generate images every time?</b></summary>
<br>

No. Uncheck **Draw images** next to **Draft it** and that draft gets only the title, cover text, script and storyboard text; you can also change the default in settings. Add images later with **Draw cover** or **Draw this** on any single frame. Without an image model, drawing is skipped anyway and the saved cover is composed from text.

</details>

<details>
<summary><b>Is this made by DeepSeek?</b></summary>
<br>

No. It's a community plugin. Scripts are written by the model you've set up in DeepSeek Harness and billed to your own account.

</details>

<br>

## About the author

I'm [蜗牛的科技笔记](https://www.xiaohongshu.com/user/profile/5faedce8000000000101c8a3) (Snail's Tech Notes), a tech creator on RedNote (ID `1097519508`). I use this desk every day. It's built around three problems I kept running into: losing ideas, drafts that took too long, and never checking how posts did. Issues and ideas are welcome on [GitHub](https://github.com/woniuniuniu/dsh-media-desk/issues).

## Thanks

- The [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) team, for an open plugin system to build on.
- [dsh-Go](https://github.com/ccch1mneyyy/dsh-Go), whose README layout inspired this one.

### Special thanks

To the people who tried it carefully, tracked problems down and sent fixes:

- [secountAiAccount](https://github.com/secountAiAccount), for spotting the unreadable style dropdown in dark mode ([#1](https://github.com/woniuniuniu/dsh-media-desk/issues/1)) and the settings icon that looked like a theme toggle ([#2](https://github.com/woniuniuniu/dsh-media-desk/issues/2))
- [isxiaokunos](https://github.com/isxiaokunos), for pinning down why image gateways that return relative URLs always failed, were misreported and needlessly retried, with a patch and real measurements ([#3](https://github.com/woniuniuniu/dsh-media-desk/issues/3))
- [townmi (Harry Tang)](https://github.com/townmi), for finding that opencode-go needs a session header and that the panel misreported the failure as "offline" ([#4](https://github.com/woniuniuniu/dsh-media-desk/issues/4))
- [zach22-1999](https://github.com/zach22-1999), for fixing the crash when importing X posts whose media field isn't a list ([#6](https://github.com/woniuniuniu/dsh-media-desk/pull/6))
- [chenxupeng1990-eng](https://github.com/chenxupeng1990-eng), for letting the assistant use any connected model instead of only the DSH default ([#5](https://github.com/woniuniuniu/dsh-media-desk/pull/5))
- [dsh-agent-sixtyseven](https://github.com/dsh-agent-sixtyseven), for tracking down why account import on Windows kept saying "Monid isn’t installed yet" and fixing both how the command is found and how it's run ([#7](https://github.com/woniuniuniu/dsh-media-desk/issues/7), [#8](https://github.com/woniuniuniu/dsh-media-desk/pull/8))
- [smallflycar](https://github.com/smallflycar), for letting the desk draw images with a GPT subscription, no separate image API needed ([#9](https://github.com/woniuniuniu/dsh-media-desk/pull/9))
- [cofftea114](https://github.com/cofftea114), for pointing out that the desk has no entry once another plugin takes over the left sidebar, and for showing how to mount it as a dsh-better-sidebar tab ([#10](https://github.com/woniuniuniu/dsh-media-desk/issues/10))
- [Feahter](https://github.com/Feahter), for the plugin market index that makes the desk a one-click install from Discover, validation and tests included ([#11](https://github.com/woniuniuniu/dsh-media-desk/pull/11))
- [TerryWang9112 (Terry)](https://github.com/TerryWang9112), for adding Alibaba Cloud Bailian and Wan image generation, and for letting each draft skip images ([#12](https://github.com/woniuniuniu/dsh-media-desk/pull/12))
- [ytzhangFTD](https://github.com/ytzhangFTD), for noticing that an idea's notes disappear inside the studio and pinpointing the missing render path ([#13](https://github.com/woniuniuniu/dsh-media-desk/issues/13))

[Issues](https://github.com/woniuniuniu/dsh-media-desk/issues) are always welcome. Every one gets read.

### Contributors

Thanks to everyone who has contributed code:

[![Contributors](https://contrib.rocks/image?repo=woniuniuniu/dsh-media-desk)](https://github.com/woniuniuniu/dsh-media-desk/graphs/contributors)

## Development

```bash
npm install && npm test        # host logic tests
npm run watch                  # rebuild when client/ changes
npm run index                  # refresh index.json after a release
scripts/dev-sandbox.sh         # run the web version in an isolated DSH_HOME
node scripts/mock-llm.mjs      # mock text and image models, no quota used
npm pack                       # build the installable tgz
```

`index.json` is the plugin market index; `npm run index` refreshes its version and publish time from the latest npm release, so run it once after every public release. This custom branch is not published to npm; the index retains the public upstream `2.7.0` release.

`scripts/mock-monid.mjs` is a fake `monid` command that returns made-up content, so you can test the import flow for free. Wrap it as an executable named `monid` and put it first on your `PATH`.

| Path | Contents |
| --- | --- |
| `client/` | UI: idea wall, studio, chat, content, schedule, insights, styles, settings |
| `src/` | Host routes, drafting pipeline, prompts, image generation, style learning, Monid import, local storage |
| `scripts/` | Bundling, sandbox, mock models, sample asset generation, market index |
| `assets/` | Sample images and videos, all generated by `scripts/gen-assets.py` |
| `docs/assets/` | The images on this page |

Restart DeepSeek Harness after changing `src/`.

**Security:** Every route is authenticated by the host. Model output and fetched content are reduced to known fields with length limits, and only allow-listed operations run. Pasted links can't reach localhost or private networks. `monid` runs without a shell, and account IDs must match fixed formats. Please report vulnerabilities privately through [Security Advisories](https://github.com/woniuniuniu/dsh-media-desk/security/advisories/new).

<br>

<p align="center"><sub><a href="LICENSE">MIT</a> · A community plugin, not affiliated with DeepSeek. DeepSeek Harness and its marks belong to their respective owners.</sub></p>
