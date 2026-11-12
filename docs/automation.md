# Local Media Desk automation

This document describes source version `2.7.0-accounts.5`. An existing installation is unchanged until this source build is explicitly installed. It includes a CLI, official MCP stdio server and an explicitly started authenticated HTTP adapter for the **installed desktop workbench**, sharing 20 tools. Start DeepSeek Harness and open Media Desk first. The adapter uses the Host's existing Store, Settings and Producer; it never starts another Harness or borrows browser cookies. Ordinary authoring uses `assist` with the workbench selected/subscription model; structured operations remain direct, and importing local media or a finished external draft requires no model call.

## Run

```sh
media-desk doctor
media-desk tools
media-desk tools media_desk_write_draft
media-desk items list --input '{"limit":5,"status":"draft"}'
media-desk idea add 'New story'
media-desk import './图片.png' --input '{"accountId":"ACCOUNT_ID","title":"Reference image"}'
media-desk items get ITEM_ID
media-desk write '请把这篇写成完整脚本并规划分镜' --input '{"focusId":"ITEM_ID"}'
media-desk assist '请修改这篇的开头' --input '{"focusId":"ITEM_ID"}'
media-desk call media_desk_write_draft --request-id draft-20261112-001 \
  --input '{"id":"ITEM_ID","title":"中文 English","article":"## Script\nYour externally authored script","coverText":"知识卡片","shots":[{"visual":"A station","voice":"Narration","seconds":5}]}'
media-desk schedule ITEM_ID '2026-11-13T20:00:00+08:00'
media-desk export ITEM_ID
```

The package exposes `bin/media-desk.js`. Run it with Node 20+ or the installed Harness's bundled Node runtime. A launcher on your PATH can expose it as `media-desk`; use its absolute path in clients that do not inherit PATH. The launcher should resolve the installed package, set its runtime's Node mode when needed, and forward arguments without printing banners. Update the example MCP configuration's command to match your installation.

Default stdout is one compact JSON envelope. Diagnostics use stderr. Exit codes: `0` success, `1` operation/availability failure, `2` invalid command/input, `3` uncertain mutation outcome. Use `--input-file FILE` for long scripts. `--home DSH_HOME` overrides the default `$DSH_HOME` or `~/.dsh`. `--profile desktop` is the default; named profiles select a separate endpoint namespace and must match the Host server's profile option. The Host uses `DSH_PROFILE`, otherwise the basename of `DSH_PROFILE_DIR`, otherwise `desktop`; clients must select the same profile. Flags may appear before or after commands.

## Account scope

Version `2.7.0-accounts.5` includes editorial profiles for many accounts, including multiple accounts on the same platform and manual Kuaishou accounts. These profiles do not log into or publish to social platforms. Manual CRUD, archive/restore, default-style/format selection, assignment and local-media/external-draft import require no model or Monid call. Kuaishou supports manual entry, CSV imports and structured API metrics. Monid's supported platforms remain unchanged; automatic Kuaishou fetching is unavailable.

Discover IDs with `accounts list` / `accounts get ID`. Names and platforms are not unique IDs. The desktop opens at the account list, with search, platform/group filters, archive/restore, 50-row pagination and CSV add (at most 100 rows, with failed rows retained). Choose one account, All accounts or Unassigned to enter Content, then use the nested Inspiration / Content / Schedule / Insights / Account / Styles tabs. The Account tab edits only the selected profile; virtual scopes explain that they have no profile. The Account list breadcrumb returns to the main menu and clears transient selections. The hub has no child tabs or assistant. All existing unattributed content remains Unassigned; migration never guesses ownership from a platform. Deleting a profile detaches content, metrics, rules and chat without deleting content; use archive for routine retirement.

Every relevant request accepts optional `accountId`: **omitted = All/backward compatibility**, **null = Unassigned**, **string = one account ID**. Selection in the desktop frontend is local to that frontend. There is no mutable shared server account selection, so concurrent robots must include the target account on each request. Focused assistant requests derive the item's account when omitted; an explicit mismatch fails before the model call. Scoped model context/history, returned operations and production actions stay within that account. Production always uses its item's account positioning, audience independent default style and script/article preference through the existing selected/subscription model.

```sh
media-desk accounts list --input '{"limit":20}'
media-desk accounts add 'AI explainers' --input '{"platform":"抖音","group":"Education","positioning":"Practical AI","audience":"Beginners"}'
media-desk accounts get ACCOUNT_ID
media-desk items list --input '{"accountId":"ACCOUNT_ID","limit":20}'
media-desk items list --input '{"accountId":null}'
media-desk idea add 'New idea' --input '{"accountId":"ACCOUNT_ID"}'
media-desk assist 'Write this script' --input '{"accountId":"ACCOUNT_ID","focusId":"ITEM_ID"}'
media-desk call media_desk_get_insights --input '{"accountId":"ACCOUNT_ID","platform":"快手"}'
media-desk call media_desk_apply_ops --request-id account-default-001 --input '{"ops":[{"op":"update_account","id":"ACCOUNT_ID","defaultStyleId":"STYLE_ID","archived":false}]}'
media-desk call media_desk_apply_ops --request-id assignment-001 --input '{"accountId":"SOURCE_ACCOUNT_ID","ops":[{"op":"assign_items","ids":["ITEM_ID"],"accountId":"TARGET_ACCOUNT_ID","updatePlatform":true}]}'
```

Account operations are `add_account`, `update_account`, `delete_account` and `assign_items`. Archive/restore uses `update_account.archived`; defaults use `defaultStyleId` or scoped `set_style`, and `draftFormat` (`script`, `article`, or `null` to inherit the global preference) or scoped `set_format`. `set_format` accepts only `script` or `article` through CLI/MCP. `assign_items` validates the whole list (1–100 distinct item IDs) and target before making any assignment; null unassigns. It updates linked metric attribution, preserves dates/status, and leaves descendants in place. Cross-platform moves require `updatePlatform:true`. Account changes and deletion are refused during active production/assets. Existing content cannot change ownership through `update_item.accountId`.

New account items inherit its platform, and new branches inherit the parent account unless explicitly assigned consistently. Linked metrics follow the item's attribution. New exports use immutable account-ID folders, separating identical titles on different accounts. Existing saved locations are retained for their original attribution; after reassignment, a new folder prevents overwriting the old account's export. GUI and automation share this behavior. Monid reimports reuse the resolved external identity, retain user-edited text and existing attribution, and validate an explicit manual target before paid fetches.

## Account avatars

`add_account` and `update_account` accept an optional `avatar`; compact `list_accounts` and `get_account` include it without clipping valid URLs below the 4000-character limit. Use an HTTP(S) URL, or an existing plugin-owned image reference such as `media-desk/files/avatar.jpg` or `media-desk/assets/avatar.png` (JPEG, PNG, WebP or GIF). Arbitrary filesystem paths, path traversal, inline/base64 bytes, SVG and local videos are refused. Omit the field to preserve it; `null` or an empty string removes it. Normal account scope, durable request IDs, strict unknown-field checks and read-only restrictions apply. No API key, platform login, model or provider call is required.

The desktop account form also accepts local JPEG/PNG/WebP files up to 5 MiB (shown as 5 MB), previews a center-cropped/compressed 256 × 256 WebP and uploads through the existing Host upload endpoint only on Save. Choosing a file and cancelling creates no upload or content item. Replacing/removing an avatar retains uploaded files for Undo; retrying a failed account save in the same form reuses its successful upload. Account avatar operations accept references only. The separate media-import tool below can create a content item and return an owned image reference; it adds no upload endpoint.

```sh
media-desk call media_desk_apply_ops --request-id avatar-001 --input '{"ops":[{"op":"update_account","id":"ACCOUNT_ID","avatar":"https://example.com/avatar.png"}]}'
media-desk call media_desk_apply_ops --request-id avatar-local-001 --input '{"ops":[{"op":"update_account","id":"ACCOUNT_ID","avatar":"media-desk/files/existing-avatar.jpg"}]}'
media-desk call media_desk_apply_ops --request-id avatar-remove-001 --input '{"ops":[{"op":"update_account","id":"ACCOUNT_ID","avatar":null}]}'
```

## Local image and video import

Use `media-desk import FILE` or `media_desk_import_file` to create one image/video idea in the existing workbench Store. `FILE` is on the **workbench host**. The CLI resolves a relative argument from its current directory; MCP `path` must be absolute. A cloud MCP client's filesystem is separate: place the desired file on the workbench machine first. This tool does not download URLs or accept base64, raw bytes, arbitrary attachments, directories, symlinks, globs or batches. `--input-file` continues to read JSON options only.

```sh
media-desk import './中文 图片.png' --request-id media-20261112-001 \
  --input '{"accountId":"ACCOUNT_ID","title":"Reference image","body":"Editorial notes","tags":["reference"]}'
media-desk call media_desk_import_file --request-id media-20261112-002 \
  --input '{"path":"/ABSOLUTE/HOST/PATH/clip.mp4","accountId":"ACCOUNT_ID"}'
media-desk call media_desk_get_item --input '{"id":"ITEM_ID","fields":["media"]}'
```

JPEG (`.jpg`/`.jpeg`), PNG, WebP and GIF images are limited to **25,000,000 bytes**, **40,000,000 pixels** and **16384 pixels per side**. Header dimensions and complete format boundaries are checked before native decoding, then the decoded image is validated. If the image backend is unavailable, image import returns `ASSET_ERROR`; metadata reads and video import remain available. MP4, MOV and WebM videos are limited to **250,000,000 bytes**; bounded container and required track-metadata checks do not guarantee that every codec/frame will play. Extensions and format signatures must match. Empty, truncated, non-media, changed or unavailable sources are refused with a path-free `ASSET_ERROR`. At most two imports perform file work concurrently; a third receives `BUSY`.

MP4/MOV sample-table chunk references must fit inside actual `mdat` data ranges, including an `mdat` whose size is zero (extends to EOF). Common fragmented MP4 with empty initialization tables is supported when `trun` sizes, or `tfhd`/`trex` defaults, resolve its sample ranges. Fragment bases may be explicit, use `default-base-is-moof`, or use the first `traf`'s implicit movie-fragment base. Later `traf` boxes that depend on implicit base chaining, sample ranges outside this file's `mdat` data and initialization-only segments without video samples are unsupported and return `ASSET_ERROR`. These are byte-range/metadata checks, not codec or frame decoding.

Optional fields are `accountId`, `title` (300 characters), `body` (40000) and `tags` (at most 24 strings of 100 characters). Unknown fields are refused. Omitting `accountId` or passing null creates Unassigned content; an explicit account is validated before file work and again at commit, and the new item inherits its platform. The default title is the filename. The source remains unchanged and a private, uniquely named copy preserves its exact bytes: there is no transcoding, deletion, model, image-provider or Monid call.

Success returns only `{id, accountId, title, kind, media, mimeType, bytes, sha256}` plus the usual `requestId`. `media` contains the workbench `src` reference and image dimensions; no source path or media bytes are returned or stored in the item. `get_item.fields:["media"]` returns bounded `{src,poster,w,h}` references. Default item metadata stays compact and excludes media/body, with `importRequestId` present only on imported items.

To save a local image directly as an account avatar, set `destination:"avatar"` and a concrete `accountId`. This accepts the same supported images and limits, preserves exact bytes without cropping/compression, and creates **no content item**. `title`, `body` and `tags` are refused for this destination; videos, omitted/null accounts and unknown accounts are refused. Default `destination:"item"` retains the idea-import behavior above.

```sh
media-desk import './头像.png' --request-id avatar-20261112-001 \
  --input '{"destination":"avatar","accountId":"ACCOUNT_ID"}'
media-desk accounts get ACCOUNT_ID
```

Avatar success returns `{destination:"avatar",accountId,kind,media,mimeType,bytes,sha256}` and the usual request ID, without an item ID. `get_account` and `list_accounts` expose `avatarImportRequestId` only while that import's stored `src` equals the current avatar. A later manual change/removal hides the old marker; Undo restores the appropriate reference and retains imported files. After an uncertain avatar commit, inspect that account's current `avatar` and `avatarImportRequestId` plus request status before acting. Recovery markers are internal and cannot be supplied through `apply_ops`.

The durable request journal wraps validation, copying and commit. Identical IDs/arguments share one copy and cached results work even after the source disappears. A changed payload with the same ID conflicts. After `OUTCOME_UNKNOWN`, inspect `media_desk_request_status` and `list_items` with `query` equal to the request ID to find `importRequestId`; do not retry with a new ID. A potentially committed asset is retained for inspection. Known precommit failures remove only the import's own copy. Read-only CLI/MCP excludes and rejects import mutations before source access.

## Platform filters and Kuaishou

The Insights page has an All platforms / individual platform selector, including Kuaishou. `media_desk_get_insights` accepts an optional canonical `platform` value, applied after account scoping to metrics (including standalone metrics), content and follower accounts. Omit the platform to preserve the aggregate view. `media_desk_status.supportedPlatforms` and the strict tool schema expose the same ten canonical values. Natural-language schedules and account/metrics CSV accept `Kuaishou` and `Kwai` as aliases for `快手`; structured API requests use `快手`.

```sh
media-desk doctor
media-desk tools media_desk_get_insights
media-desk call media_desk_get_insights --input '{"platform":"快手"}'
media-desk call media_desk_get_insights --input '{"accountId":null,"platform":"快手"}'
media-desk call media_desk_apply_ops --request-id kuaishou-metric-001 --input '{"accountId":"ACCOUNT_ID","ops":[{"op":"add_metric","itemId":"ITEM_ID","platform":"快手","date":"2026-11-12T12:00:00+08:00","collectedAt":"2026-11-12T12:05:00+08:00","source":"manual","views":100,"likes":5}]}'
```

Manual/CSV/API metric storage and review make no provider calls. This support does not add a Monid endpoint or automatic fetching for Kuaishou.

Metrics are **cumulative snapshots**, not additive daily counts. Overall totals, platform distribution, ranking and new rule proposals share one reducer: each exact item ID and metric platform is an independent stream within the existing account scope. The latest valid value for each counter wins, including downward corrections; it is never a maximum or a sum of repeated snapshots. A previous valid field can be retained with its own source and collection provenance. Ranking lists platform streams separately, so one item can appear for multiple platforms. Exact, unambiguous external-ID links are accepted; titles are never identity evidence. Unidentified records remain stored and are counted as excluded from work totals and rules.

Each supplied counter must be a nonnegative safe integer (at most `9007199254740991`); omit it or use `null` when unknown. Known zero stays zero. New records have `semantics:"cumulative"` and an internal `recordedAt` save time. Optional `source` is a self-declared label, not external verification. Optional `collectedAt` must be an actual known, calendar-valid ISO8601 instant with `Z` or an explicit offset. The GUI labels manual input `manual` and leaves collection time unknown when omitted. `date` remains a stat/record date, never a collection instant. Legacy `fetchedAt` was an import-completion time, not an actual posts-response observation. It provides weak legacy import ordering/provenance only, is excluded from daily growth, and leaves collection time unknown. Account timestamps, publication dates, IDs and file times never establish collection time. Historical records are not migrated or rewritten. Old default zeros cannot be distinguished from originally measured zeros, so coverage includes a legacy-zero provenance warning.

Reliable collection instants determine ordering. Legacy `fetchedAt` (import completion) or `date` can only provide a weak ordering when no reliable collection instant is available; ties use a deterministic fallback with uncertainty/conflict flags. Timed observations are preferred to incomparable undated records without claiming those undated records are older. Every selected field includes its own provenance. Engagement totals can sum known interactions and explicitly report partial coverage. Engagement rate only uses positive views and all four known interaction counters from the same selected snapshot; coverage explains excluded streams. Empty or wholly unknown metrics return `null`, not zero. Sums beyond JavaScript's exact safe-integer range return `null` with explicit overflow metadata/reasons; individual safe-integer increments have no heuristic cap.

Daily values are **partial observed within-day increments**, never complete daily growth. They use adjacent reliable timed snapshots only. First baselines, missing/invalid counters, decreases and equal-time conflicts create unknown gaps. Exact duplicates add nothing. Cross-day intervals are available separately in `timeline.intervals` and excluded from daily values. Unknown, invalid and future collection timestamps are excluded from the timeline with reason counts. The page still renders totals and coverage when no growth timeline can be calculated.

CSV accepts `date,platform,views,likes,comments,shares,saves,itemId,collectedAt,source`, with the last three columns optional. An English header can select columns by name; the original seven-column layout remains supported. Blank counters remain unknown and invalid counters/time formats are reported as row errors. A CSV stat date never establishes collection time; source remains unknown unless explicitly supplied. Use an exact `itemId` to include a new snapshot in work totals.

`get_insights.coverage` reports published items with any data/views/a complete selected snapshot (plus `completeCounters` allowing retained fields), raw records versus unique item/platform streams, missing published works with factual reasons and missing fields, unknown sources/times and the latest confirmed collection instant among selected valid fields. `rawLatestCollectedAt` separately describes all raw records and is never used to claim counted works were updated. `missingWorksCount` counts unique published item IDs; `missingEntriesCount` counts item/platform detail rows. When some times are unknown, that instant is explicitly labeled as applying to the known subset. No stored snapshot means “no linked snapshot”; absent/invalid fields mean “missing/invalid fields,” without inventing an ingestion failure. The automation response limits every array to 30 and provides `collections["path.to.array"]` with `total`, `returned`, `limit` and `truncated`. Counts are computed before truncation. The GUI lists the first 30 missing entries with the full count.

Monid captures `collectedAt` immediately after the posts response returns, before profile/relation fetches, cover downloads or saving; `collectionTimeBasis:"local-response-observed"` describes this local observation, not a guarantee that the provider refreshed its counters at that instant. The Host carries this instant through import while `recordedAt` remains the later save time. Direct imports without an explicit collection instant keep it unknown. Missing/invalid provider publication dates remain null; item creation time can use save time without claiming publication then. Monid reimports append immutable snapshots and deduplicate exact-time identical replays; they no longer overwrite previous counters. Unreported provider counters remain unknown. This changes future imports only. Existing saved rule evidence is historical and may use an earlier counting method: Analyze again proposes only previously unseen rule names and does not recompute or rewrite existing active rules.

## MCP

Configure the command and argument array in [media-desk.mcp.json](media-desk.mcp.json). `media-desk mcp` uses official `@modelcontextprotocol/sdk` 1.32.2 and publishes the same catalog/schema as CLI `tools`. Tool results include `structuredContent`, text, and `isError`. Its stdout contains MCP protocol messages only. The default local client timeout is 300 seconds for model-assisted turns and 30 seconds for other tools; an explicitly configured client timeout takes precedence.

Add `--read-only` before `mcp` to advertise only reads and reject mutations locally. Read-only is a restriction on that client process; another explicitly authorized client can still use the regular endpoint. For stdio, do not put the Host socket token in MCP configuration: clients discover it through private files. HTTP uses a separate, explicitly provisioned Bearer token as described below.

## HTTP MCP and cloud clients

`media-desk mcp` remains stdio. The Host does not start HTTP automatically. Start the adapter explicitly after installing this version, with a separate preexisting token file:

```sh
media-desk --home /ABSOLUTE/DSH_HOME --profile desktop mcp-http \
  --port 41419 --token-file /ABSOLUTE/PRIVATE_HTTP_TOKEN_FILE
```

Create the file using a cryptographically random generator, for example 32 random bytes encoded as 64 hexadecimal characters, without a newline. Keep it owned by the calling user with mode `0600` (or stricter). The adapter refuses relative paths, missing files, symlinks, directories, other owners, group/other permissions and invalid or trivially weak tokens; it never generates or prints a token. This HTTP token is separate from the Host socket token and grants access to the selected workbench profile. `--read-only` filters the HTTP catalog and rejects write calls. Diagnostics print the version and loopback endpoint only, on stderr.

The listener always binds `127.0.0.1`; the endpoint is `http://127.0.0.1:41419/mcp`. It accepts authenticated POST requests only, using `Authorization: Bearer TOKEN`. It uses stateless official SDK Streamable HTTP with JSON responses and a separate server/transport for each request. The default official SDK HTTP client works with `requestInit.headers.Authorization`; its Node fetch-generated standalone `Sec-Fetch-Mode: cors` is allowed. Any `Origin` header, other Sec-Fetch metadata, or a different fetch mode is rejected. Authentication precedes body parsing; inputs are limited to 256 KiB, active HTTP requests to 16; JSON-RPC batches are refused before dispatch so one request cannot bypass that bound. Other paths/methods and unexpected Host headers are refused. Forwarded headers never grant access.

Loopback Host headers are permitted. For a separately configured HTTPS reverse proxy or tunnel that preserves the public Host header, add `--public-host bridge.example.com` (repeat only for exact additional domains); URL syntax, ports and wildcards are refused. Public requests may use that exact hostname with no port or port `443`. This flag only permits the incoming header: it does not expose the listener, start a tunnel or configure HTTPS. SIGINT/SIGTERM stop new work and drain accepted calls, including calls whose HTTP client has disconnected, before disposing the adapter. Durable request IDs and uncertain-outcome handling remain unchanged.

A remote MCP client running only in the cloud cannot directly reach the desktop machine's executable, Unix socket or loopback endpoint. That transport needs a separately configured reachable **HTTPS** endpoint plus the Bearer header. Grok Bot also has a distinct desktop **local execution** capability: it can run this CLI on the desktop under the existing approval policy, using the private Unix socket without a tunnel. Prefer that path when the Bot and workbench share a machine; verify the actual Bot-to-workbench connection for your installation. See [Grok Bot connection](GROK_BOT.md). Optional temporary tunnel URLs change when restarted and require connector updates. The package does not deploy an external tunnel or HTTPS endpoint.

## Tools

| Tool | Behavior |
| --- | --- |
| `media_desk_status` | Protocol/plugin version, availability and supportedPlatforms |
| `media_desk_list_accounts` | Search/query, platform/group/archive filters; default 20, max 100; offset/nextOffset; compact account metadata and counts |
| `media_desk_get_account` | One account profile, positioning/audience/default style/format and counts; no credentials |
| `media_desk_list_items` | Query/status/platform filters; default 20, max 100; offset/nextOffset pagination; metadata only |
| `media_desk_get_item` | One item's metadata; opt into `fields: ["body","article","production","media","versions"]`; `maxChars` default 8000, max 200000 per selected text field; explicit `truncated` flags for text |
| `media_desk_import_file` | One host-local JPEG/PNG/WebP/GIF or MP4/MOV/WebM, copied exactly into an image/video idea; `destination:"avatar"` imports an image directly to a concrete account without an item; compact metadata, byte count and SHA-256 only; no model call |
| `media_desk_apply_ops` | Up to 100 explicit whitelisted operations using the existing validation/receipts and undo semantics |
| `media_desk_assist` | Default authoring/revision through the existing assistant and selected/subscription model; starts requested production jobs once; open/nav actions are returned as UI hints |
| `media_desk_write_draft` | External title/article/cover text/textual storyboard directly into studio/export; zero model calls; retains existing assets; keeps published items published |
| `media_desk_produce` | Existing configured Producer; optional boolean `withImages` overrides the image default; may incur model/image costs |
| `media_desk_production_status` | One job/production's stored and live status, format and image choice without changing it; no streaming article text |
| `media_desk_cancel_production` | Requests cancellation; inspect status for completion |
| `media_desk_regenerate_asset` | One existing `cover`, `image:0` or `shot:0` asset; may incur model/image costs |
| `media_desk_export` | A sealed content version in a new exclusive folder on every export; script, storyboard/assets and 1920×1080 composited JPEG cover |
| `media_desk_get_insights` | Bounded insights for accountId, optionally filtered by canonical platform |
| `media_desk_list_styles` | Bounded style cards (including logic/story/flow) and active style; raw reference text omitted |
| `media_desk_models` | Provider/model identifiers, no keys or full settings |
| `media_desk_request_status` | Durable mutation status and compact recorded result |
| `media_desk_get_content_lab` | Scoped metadata, detail, queue and uncalibrated rubric presets; no model; manuscripts opt-in |
| `media_desk_content_lab_action` | Explicit evaluate / forecast / lock / publish / retro; exact IDs, account scope and durable request ID required |

`apply_ops` supports item add/update/delete/status/schedule/draft/production text, styles add/update/delete/select, script/article format selection, rules (`*_skill`) add/update/delete, metrics add, and `save_version` / `restore_version`. Unknown operations/fields, arbitrary media paths and `savedPath` are rejected. Use `tools media_desk_apply_ops` for the exact JSON schema. Schedule timestamps must include `Z` or an explicit timezone offset; `null` cancels scheduling. Scheduling changes only the local editorial calendar. It does not post to social platforms.

`assist` (CLI `assist` or `write`) uses the same workbench assistant as the UI and then executes requested production jobs server-side once. Existing revisions/asset regeneration inside that turn are not repeated. The compact response includes reply, receipts/errors, started jobs and UI hints; it never includes chat history or full workspace state. Poll production status for background jobs. If the configured model is unavailable, the existing UI fallback is reported through `modelUsed:false` and its notice. Provider errors remain private.

`write_draft` (CLI `write-draft ID --input JSON`) explicitly imports a finished externally authored draft without another generation. It accepts text only, with optional `format:"script"|"article"`. If omitted, it retains the existing production format or uses the item account's effective preference for a new draft. Asset references cannot be submitted through it; legitimate existing cover, images and corresponding storyboard images remain. It refuses writes during active production. Existing Producer's own provider rate-limit handling is preserved; the adapter adds no generation or dispatch retries.

## Saved-version review, prediction and timed retrospective

Source `2.7.0-accounts.5` implements this first increment only. It is not an npm publication or an installed runtime update: the previously verified installed runtime remains `2.7.0-accounts.3` until explicitly replaced. The market index remains upstream `2.7.0`. Personas, benchmark imports, topic generation and formula recalibration are later increments and are not implemented here.

The account list remains the main menu. Choose an account, open a work in Content and use **Content review and retrospectives** beside version history. Insights contains its account-scoped prediction queue even with no chart data. Nothing calls a model automatically on load, version changes, account changes or refresh. Complete/cancel article edits and finish saving first. Failed title/body saves prevent review and locking. Queued or accepted retired saves are reconciled through the same capture guard used by versions and exports.

| Stage | Required input | Model use and behavior |
| --- | --- | --- |
| `evaluate` | `itemId`, exact saved `versionId`, `format`, matching `rubricId` | One model call; only rubric plus selected manuscript in the fresh review user JSON |
| `forecast` | `evaluationId`, optional `horizonDays` 1–30 (default 3) | A separate model call; saves an immutable preview and frozen comparison basis |
| `lock` | `forecastId` after reading the full preview | No model; explicitly freezes evaluation and forecast before publication or target performance is known |
| `publish` | `predictionId`, actual zoned `publishedAt`, optional HTTP(S) `url` | No model; immutable **user declaration**, never social publishing or platform verification |
| `retro` | `predictionId`, exact matching `metricId`, optional `notes` | One model call; only at/after due time with a reliable local observation |

Every mutation requires **explicit `accountId` (string or null)** and a stable durable `requestId`. This differs from reads, where omission means All and null means Unassigned. The chosen subscription/default model connection is reused; no extra API key is needed when that connection already works. Model explanations follow the UI request language. Scores use preset integer dimensions 0–5 and a server-computed weighted composite 0–100. `general-script-v1`, `general-article-v1` and explicitly selected `opinion-video-v1` are **uncalibrated criteria**, not measured predictive accuracy. Dimension confidence is the model's own assessment. A fresh limited input does not establish that the model is globally ignorant of the work or its historical results. Historical/data-known work may be evaluated, but is labeled `historical-nonblind` and cannot become a fresh locked prediction.

Forecasts freeze comparable prior works from the **same account, platform, format and horizon**. Choose the earliest reliable observation for each prior work between its due instant and six hours later, then select the recent **20 distinct works** by collection time. `baseline.count` is the selected count; `totalEligibleCount` is all available eligible distinct works. The explicit timing/selection policy and source observation times are retained. Fewer than three works or a zero median produces qualitative bets with `probabilities:null`, never invented traffic counts. Otherwise five relative buckets (`<0.3x`, `0.3x..<1x`, `1x..<3x`, `3x..<10x`, `>=10x`) use frozen exact rational intervals. `medianViewsExact` contains decimal-string numerator/denominator; `medianViews` is the display number and `medianViewsApproximate` warns when it is rounded. `topBuckets` are zero-based bucket indices. Tied maxima have `predictedBucket:null`, so no unique winner or invented hit/miss.

Locking rechecks the current saved creative version, hash and sticky creative epoch on the server. Editing then Undo/restoring the old text does not revive a stale preview. The UI requires complete relevant preview details and an explicit acknowledgement before Lock. Truncated details are not treated as complete. Actual publication time must be calendar-valid, zoned, no earlier than lock and no later than now. A scheduled time is never prefilled as actual. The UI supports seconds or an explicit declaration at the current submission instant. Publication also synchronizes the local item's status/time. If the working copy differs from the locked manuscript, registration is allowed with a retained `manuscriptMatch:"mismatch"`, registration fingerprint and warning; that observation cannot calibrate a forecast.

Retrospectives use one unambiguous metric for the same work/account/platform, with reliable `collectedAt` at/after publication plus horizon and no later than now. Unknown counters remain unknown, never zero; a stat date or historical import completion time is not reliable collection time. The result freezes a copy of actuals, source, collection-time basis, elapsed time and lateness. A late cumulative count is **not exact T+3 data**. The UI shows actual observation time and age. Quantitative comparison is nullable for missing views, qualitative forecasts, tied maxima and publication mismatch; records expose `comparisonStatus`, `observedBucket`, `assignedProbability`, `predictedBucket`, `topBuckets` and `bucketHit` honestly. A same-observation logical duplicate returns the original immutable record and its original `requestId`; newly typed notes do not replace original notes. Completed histories are read-only.

The queue distinguishes `awaiting-publication`, `upcoming`, `due`, `awaiting-data`, `finished` and `late`. Upcoming is not due. No scheduler, provider fetch or social publishing is added. Immutable records survive ordinary Undo, deletion and reassignment. Archived records remain in their original account and All, not the new account. Legacy published works may enter historical evaluation; do not manufacture a past blind prediction.

```sh
media-desk lab rubrics
media-desk lab list --input '{"accountId":"ACCOUNT_ID","limit":20}'
media-desk lab evaluate ITEM_ID --request-id review-001 --input '{"accountId":"ACCOUNT_ID","versionId":"VERSION_ID","format":"script","rubricId":"general-script-v1"}'
media-desk lab get EVALUATION_ID --input '{"accountId":"ACCOUNT_ID","maxChars":100000}'
media-desk lab forecast EVALUATION_ID --request-id forecast-001 --input '{"accountId":"ACCOUNT_ID","horizonDays":3}'
media-desk lab get FORECAST_ID --input '{"accountId":"ACCOUNT_ID","maxChars":100000}'
media-desk lab lock FORECAST_ID --request-id lock-001 --input '{"accountId":"ACCOUNT_ID"}'
media-desk lab publish PREDICTION_ID --request-id publication-001 --input '{"accountId":"ACCOUNT_ID","publishedAt":"2026-11-12T16:30:01+08:00","url":"https://example.com/work"}'
media-desk lab retro PREDICTION_ID --request-id retro-001 --input '{"accountId":"ACCOUNT_ID","metricId":"METRIC_ID","notes":"Observed cumulative count"}'
media-desk call media_desk_get_content_lab --input '{"accountId":"ACCOUNT_ID","view":"queue","limit":20}'
media-desk call media_desk_request_status --input '{"requestId":"forecast-001"}'
media-desk call media_desk_get_content_lab --input '{"accountId":"ACCOUNT_ID","queryRequestId":"forecast-001","limit":10}'
```

`get_content_lab` reads support `view:records|list|rubrics|queue|detail` (`detail` requires `recordId`), `itemId`, `kind`, `queryRequestId`, `limit` 1–100, `offset` and `maxChars` 1–100000. List pages return metadata only with `total/offset/nextOffset`. Detail returns `{record,truncated}`. Manuscript text, including nested originals, is hidden unless `includeManuscript:true` is explicitly requested. Oversized detail is metadata plus a `json-fragment` preview, not a complete/parseable record. Evaluation/forecast details also include read-only `currentEligibility:{lockable,reason}` computed from current state, separate from immutable records. Generic state/ops/Undo responses omit internal lab state.

Prediction details include bounded read-only `currentRelations:{predictionId,publication,retrospectiveCount,latestRetrospectiveId}`. `publication` is its exact same-account/item/platform publication metadata or null, not a manuscript or narrative. The count and latest ID describe matching retrospective records without returning a history array or notes. These relations are computed independently of list pagination, remain available for archived records and never rewrite the prediction. The UI withholds registration/review forms if relations are not confirmed; loading more history is not required to discover an existing publication or completed review.

The observation picker uses the same exact identity resolver as the backend: explicit item ID, or an unambiguous external ID within its account, with matching platform/account and one exact unique metric ID. Ambiguous identities are never broad-matched. Timed legacy zero views without cumulative semantics or explicit measurement provenance remain unknown; an explicitly measured/manual zero remains zero. The UI and backend share the same browser-safe provenance policy. Median display uses exact human integers or half decimals, including very large halves, and shows an approximate numeric display only when rounding is necessary.

Authenticated desktop POST routes `/media-desk/content-lab/read` and `/media-desk/content-lab/action` share the exact automation dispatcher and durable journal with MCP. `/media-desk/content-lab/request-status` is a narrow desktop alias to the existing request-status read tool; it adds no MCP tool. They return normal `{ok,result,requestId?}` or `{ok:false,error:{code,message,details?},requestId}` envelopes: **HTTP 200 alone does not mean success**. For example the action JSON is `{"accountId":"ACCOUNT_ID","requestId":"review-001","action":"evaluate","itemId":"ITEM_ID","versionId":"VERSION_ID","format":"script","rubricId":"general-script-v1"}`. Model/provider details are sanitized at the lab boundary; ordinary authoring diagnostics retain their existing behavior.

On network loss retain the **same request ID and exact intent**. The UI holds operation ownership across close/reopen and account navigation, prevents prepaint double clicks, shows “Result needs checking” and offers a read-only manual check. It never automatically resubmits or mints a new ID to bypass an uncertain action. `media_desk_request_status` reports `pending|done|unknown|not_found`; use `queryRequestId` and bounded `error.details.contentLab.records` identifiers to find saved evidence. An existing record may carry a different original request ID for a logical duplicate. Keep notes and inputs after failure/uncertainty. No recovery read starts a model. UI pending ownership lasts for the current application session; retain the displayed recovery ID externally before a full reload.

Each selection/intent has a monotonic UI revision: switching versions or history records and then switching back cannot let an older action or manual recovery replace the newer focus. Saved results remain available through the operation notice/history even when they are not automatically opened.

The review-loop approach is attributed to [XBuilderLAB/cheat-on-content](https://github.com/XBuilderLAB/cheat-on-content), [MIT license](https://github.com/XBuilderLAB/cheat-on-content/blob/d88d004abcabfe6656a007b8fb4e7ed4ea7a4c89/LICENSE), commit [d88d004abcabfe6656a007b8fb4e7ed4ea7a4c89](https://github.com/XBuilderLAB/cheat-on-content/commit/d88d004abcabfe6656a007b8fb4e7ed4ea7a4c89). This implementation does not claim that later persona, benchmark, topic or recalibration stages are present.

## Format and image choices

The studio format picker and scoped `set_format` change only the item account's preference. `update_account.draftFormat:null` restores inheritance from the global preference; Unassigned and unscoped global operations retain the old global behavior. Migration adds nullable preferences without rewriting existing articles or production formats. Production snapshots the effective format at start, so changing an account preference while a job runs cannot retarget that job. Undoing an older draft import preserves the complete newer production, both while it runs and after completion; ordinary edits within the same production and unrelated changes remain undoable.

```sh
media-desk call media_desk_apply_ops --request-id format-001 --input '{"accountId":"ACCOUNT_ID","ops":[{"op":"set_format","format":"article"}]}'
media-desk produce ITEM_ID --request-id text-only-001 --input '{"accountId":"ACCOUNT_ID","withImages":false}'
media-desk write-draft ITEM_ID --request-id external-article-001 --input '{"accountId":"ACCOUNT_ID","format":"article","article":"A finished article"}'
```

`produce.withImages` is optional and strictly boolean. Omit it to follow the existing `generateImages` setting. `false` still creates the script/article and textual storyboard with planned assets marked skipped; `regenerate_asset` can draw individual assets later. Scope is checked before provider work and again before continuation writes. Concurrent starts for one item reserve one job before asynchronous settings reads, preventing duplicate model/image pipelines. Production status and bounded production reads include the saved `format` and `withImages` when present.

Style operations and compact reads include `logic`, `story` and `flow`. Extraction stores a bounded reference excerpt and activates the style for the targeted account; compact automation reads omit raw reference material.

## Durable requests and partial results

All MCP mutations require a caller-provided `requestId`. CLI generates one when omitted and returns it. IDs allow letters/digits followed by letters/digits/period/underscore/colon/hyphen, at most 128 characters. Keep the same ID and exactly the same arguments when inspecting/reusing a completed request. A different payload with the same ID returns `REQUEST_ID_CONFLICT`.

Before mutation dispatch, a private journal durably records the ID, tool, canonical argument hash and pending status. It does not store full input bodies or credentials. Concurrent duplicates execute once. Completed duplicate calls return the recorded result with `cached:true`. A batch with successful receipts and per-operation errors returns `PARTIAL_FAILURE` with both receipts and errors; replaying the same ID returns that exact partial result without applying successful operations again.

On timeout, disconnect or uncertain dispatch, preserve the returned ID and inspect:

```sh
media-desk call media_desk_request_status --input '{"requestId":"draft-20261112-001"}'
```

After Host restart, an unfinished journal entry becomes `unknown` and returns `OUTCOME_UNKNOWN`; the adapter **never replays it automatically**. Inspect the item and platform/job state before deciding any new intent. A transport error may arrive while the Host is still finishing a recorded mutation. `not_found` immediately after a disconnect is not permission to retry. Request IDs and journals are scoped to the selected endpoint profile; named profiles keep their journal in `automation/profiles/NAME`, while desktop keeps `automation/journal.json`. They do not implement transactions across multiple Host processes. The journal's hashes/results persist for duplicate protection; do not delete it to force a retry.

Envelopes are `{ok:true,result,requestId?,cached?}` or `{ok:false,error:{code,message,details?},requestId?}`. Internal provider error details, tokens, cookies, settings and entire workspace state are not exposed.

## Local boundary and diagnostics

The Host owns `$DSH_HOME/media-desk/automation/rpc.sock` (named profiles live beneath `automation/profiles/NAME`). The directory is `0700`; random token, socket, lock and journal are `0600`. The Host opens no TCP listener; only an explicitly started `mcp-http` adapter opens its loopback TCP port. Browser-origin requests are rejected even with a token. Requests are limited to 256 KiB and responses to 1 MiB; request smaller field selections when a response is too large. This local capability allows the same operating-system user to operate the workbench; give it only to agents you authorize.

A live/uncertain owner or connectable orphan socket prevents takeover. Stale cleanup requires reliable process-death evidence and a non-connectable socket. A malformed owner file or abandoned recovery lock is deliberately refused for manual investigation. Disposal stops accepting new work and drains already-dispatched operations before releasing ownership; it removes only this instance's files. Socket path limits and unsupported platforms fail explicitly; use a short DSH_HOME on macOS if needed. Bridge startup failure is reported on stderr and leaves the regular authenticated workbench usable.

Export uses the workbench-configured export directory and previous saved folder, matching the Save button. The cover painter is shared with the browser. The native canvas dependency is loaded only on export, so renderer availability cannot prevent ordinary Host startup. Cover backgrounds and copied assets must resolve to regular plugin-owned local files; URL fetching, traversal, symlinks and missing/invalid images fail explicitly. Known fixed system font paths provide Chinese font support. Explicit finished-draft import, local cover composition and export need no extra generation; default writing/revision uses the selected model.

## Validation

Tests use temporary real Stores, actual Unix sockets, CLI subprocesses, the official SDK stdio and default HTTP clients, actual loopback HTTP requests, and a real JPEG/export renderer. They do not call subscribed models or image services. On restricted test runners, Unix socket tests may need the runner's normal local-network permission.

## Persistent content versions and exports

These operations use the same 20 tools, Store, account boundaries, read-only mode and durable request IDs. They call no model or Monid. Use a newly built/installed source version to access them; this document does not change a running installation.

```sh
media-desk call media_desk_apply_ops --request-id save-v1 --input '{"accountId":"ACCOUNT_ID","ops":[{"op":"save_version","id":"ITEM_ID","name":"Initial draft"}]}'
media-desk call media_desk_get_item --input '{"id":"ITEM_ID","accountId":"ACCOUNT_ID","fields":["versions"],"versionOffset":0,"versionLimit":20}'
media-desk call media_desk_get_item --input '{"id":"ITEM_ID","accountId":"ACCOUNT_ID","fields":["versions"],"versionId":"VERSION_UUID","maxChars":8000}'
media-desk call media_desk_apply_ops --request-id restore-v1 --input '{"accountId":"ACCOUNT_ID","ops":[{"op":"restore_version","id":"ITEM_ID","versionId":"VERSION_UUID"}]}'
media-desk export ITEM_ID --input '{"accountId":"ACCOUNT_ID"}' --request-id export-v1
```

Each saved snapshot has a UUID, increasing V-number, optional name (at most 80 characters), time, source and SHA-256. Names may repeat and never overwrite another version. Snapshots preserve existing creative text without truncation: idea fields/material references, handwritten drafts (including `by`/`aiText`), production title/article/format/cover text/plans and asset references. Account settings, credentials, provider replies, export paths and binary bytes are excluded. Old items need no eager migration. History is append-only and is not automatically pruned; deleting a work removes its containing history. Keep the state file and referenced assets in your regular backups.

Restore checks snapshot schema and integrity before any change, archives the current creative state as another numbered version (`before_restore`), then restores the selected content. Item identity, account/platform, published state, scheduling, metrics and account defaults remain. Restored production gets a new identity and clears stale export pointers. Older Undo cannot remove history or overwrite a later restore/generation; ordinary editing Undo and Undo of a restore retain archived versions. Save/restore refuse running/pending production or assets, including jobs reserved before settings load. In the UI, finish or cancel local article editing first; pending title/body writes must finish successfully before version actions proceed.

Automatic backups occur before whole-production replacement (`before_produce`), external draft replacement (`before_write_draft`) and export sealing (`export`). Consecutive automatic backups of identical creative content reuse the last snapshot. Explicit Save Version and every pre-restore backup always allocate a new number. Ordinary typing and polling do not create versions. Replaying the same durable request ID does not create extra snapshots; a conflicting reuse fails. After an uncertain result, inspect request status and the work rather than issuing another mutation ID.

Default item/list/model context omits historical content. `fields:["versions"]` opts into compact metadata only: `versions.items`, `total`, `offset`, `nextOffset`; `versionLimit` defaults to 20 and is at most 100. A `versionId` requires the versions opt-in and selects a single content snapshot. Its JSON is bounded by `maxChars` (default 8000, max 200000); an oversized snapshot returns `version.content.preview` with `encoding:"json-fragment"` and `truncated.version:true`. Saved snapshots themselves are never truncated. Integrity failures refuse restoration. Asset references are retained without deleting existing files; missing files cannot be recovered from the snapshot alone.

Exports seal a stable snapshot before asynchronous cover rendering/settings reads. Output uses that snapshot even if the working content is edited/restored while waiting. Account membership and active work are rechecked before filesystem output. Every export exclusively creates a unique leaf directory with safe title/version/name/identity components; same titles, repeated saves and concurrent exports never reuse `savedPath` or overwrite earlier files. Legacy low-level callers without a version receive a unique `unversioned` folder. Existing cover composition and asset selection are unchanged.

`manifest.json` records item/account IDs, version UUID/number/name, content SHA-256, export time and generated file names; no credentials, settings or absolute source paths. Successful outcomes are recorded separately from immutable snapshots. Current working production receives `savedPath`/`savedAt` only when the creative fingerprint and account still match; otherwise the response has `currentMatches:false` and identifies the exported historical version. If persistence is uncertain after output, the files remain, the response is `OUTCOME_UNKNOWN` with output evidence, and no completion is claimed. Earlier folders and user-edited files are never deleted. A partially failed filesystem write can leave its newly created folder for inspection.

GUI failures also retain `code:"OUTCOME_UNKNOWN"` and bounded `details.export` evidence (output path, version metadata and at most 100 generated file names with total/truncation flags). The studio shows a recovery notice with the exported version and folder so you can inspect the existing output; it never retries automatically. GUI creative writes are sent in order per item, including across closing/reopening a studio or changing workspaces. Field dispatch tokens and editor registration ownership prevent an older completion from replacing newer unsaved text, clearing a newer failure or releasing another editor's guard. Cancelling an article edit discards only that editor's own article failure; unrelated failed title/body writes still block version actions.

Edit intent is tracked independently of stale displayed props: changing `ORIGINAL → A → ORIGINAL` while A is saving queues the final ORIGINAL write, and article history actions remain blocked until that edit is acknowledged. Cancelling editing does not withdraw a save already sent. When a save completes after its editor was cancelled, closed or replaced, the next version/export action first drains that item's write queue and reads authoritative state before capturing content. Failed reconciliation stops the action and remains retryable; a new dirty editor, a later workspace or a newer write invalidates the pending reconciliation response. These local state reads require no model call.

Save/restore version mutations share the short per-item mutation queue. Version and export responses also check later mutation epochs and workspace/studio ownership before applying a full state response; an older response cannot replace a newer accepted edit. A frozen export does not hold that queue while composing/writing files, so typing can continue. Skipped stale responses require authoritative reconciliation before a later version/export action.

Sealed GUI and automation exports use the same asset policy: every referenced cover, figure and storyboard asset is validated before any output directory is created. Existing `media-desk/files/...` imports and owned `media-desk/assets/...` builtins are copied with their exact bytes and linked in Markdown. Remote URLs, missing files, unsafe paths and symlinks fail with `ASSET_ERROR`; nothing is downloaded and earlier export folders remain unchanged. Assets without a source reference remain text-only planning entries. Legacy unversioned low-level callers retain their earlier ignored-reference behavior.

If only final automation receipt persistence fails after an export, the response and live request status retain bounded export evidence while that process marks the request `unknown`; live same-ID replay stays blocked. One metadata-only attempt may persist the unknown receipt, without dispatching the export again. A failure can occur after the completed receipt was renamed into place but before directory synchronization succeeded. On restart, an intact completed receipt is accepted as authoritative recovery: the original success may be returned with `cached:true`, including its output evidence, without invoking the action or creating another export. If the unknown repair reached disk instead, recovery remains unknown and replay stays blocked. Permanently failing storage cannot guarantee new metadata: the immediate response/live status and existing output manifest/work export record still provide evidence, but a restart can only recover the receipt actually present on disk. A status change from live unknown to recovered cached success does not mean the export ran again.
