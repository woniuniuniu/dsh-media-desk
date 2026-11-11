# Grok Bot connection

## Preferred on the workbench machine: local execution and CLI

Grok Bot's desktop app has a **local execution** capability separate from its cloud computer and MCP connectors. When the Bot runs a task on this Mac under the existing local-execution approval policy, it can invoke the installed CLI directly:

```sh
media-desk doctor
media-desk accounts list --input '{"limit":20}'
media-desk items list --input '{"limit":5}'
media-desk call media_desk_get_insights --input '{"accountId":"ACCOUNT_ID","platform":"快手"}'
media-desk assist '请修改这篇稿件的开头' --input '{"focusId":"ITEM_ID"}' --request-id grok-revise-001
```

In the desktop UI, the account list is the main menu. Choose an account (or All accounts / Unassigned) to enter its nested Inspiration, Content, Schedule, Insights, Account and Styles tabs; return with the Account list breadcrumb. The Account tab edits only that selected profile.

For platform discovery, inspect `media_desk_status.supportedPlatforms` and `media_desk_get_insights` schema. Kuaishou uses canonical `快手` in structured requests; natural-language schedules and CSV also accept Kuaishou/Kwai. Insights supports an optional platform filter after account scoping, including standalone metrics. Kuaishou metrics can be entered manually or imported through CSV/API; automatic Monid fetching is unavailable.

The task must explicitly target the desktop machine running the workbench. Keep DeepSeek Harness running. Local CLI calls reach the existing private Unix socket; they require no public HTTP endpoint, tunnel, or model API key. Inspect Settings → Computer → Your computer → Execution on this computer to understand the current approval policy; do not silently broaden it.

The CLI and official MCP transports are covered by the project tests. Configure the executable path for your installation and verify the actual Bot-to-workbench connection before relying on it. See [official local execution controls](https://docs.x.ai/grok-bot/approvals-security-and-privacy#control-access-to-your-local-computer).

## Alternative: cloud MCP connector

Grok Bot command/STDIO **connectors** execute on **Grok Bot's cloud computer**. An executable installed only on the desktop machine is unavailable on that cloud computer. This restriction does not mean the desktop app cannot run the same command through its separate local-execution capability. The bundled [media-desk.mcp.json](media-desk.mcp.json) remains suitable for an MCP client running on the Mac.

The package includes an optional authenticated Streamable HTTP adapter. Its listener, external reachability and Bot connector must be configured and verified separately for each installation.

### Optional HTTPS connection path

1. Install the prepared package into the existing desktop Harness and restart the workbench. Confirm `media-desk doctor` returns `ok:true` for the selected home/profile.
2. Provision a separate owner-private random HTTP token file, then explicitly start the adapter described in [automation.md](automation.md#http-mcp-and-cloud-clients), for example `media-desk mcp-http --port 41419 --token-file /ABSOLUTE/PRIVATE_HTTP_TOKEN_FILE`. The Host does not enable HTTP automatically.
3. Select and configure a supported HTTPS tunnel or reverse proxy to `http://127.0.0.1:41419/mcp`. If it preserves its public Host header, supply that exact domain with `--public-host DOMAIN` when starting the adapter. Creating this external access path requires a separate deployment decision; no tunnel provider/account, credentials or stable domain are inferred.
4. In Grok Bot's custom MCP form, choose **Streamable HTTP**, enter the actual public `https://DOMAIN/mcp` URL, and configure the static `Authorization` header as `Bearer TOKEN` using the separately provisioned HTTP token. Keep the token private; do not place the Host socket token, cookies or provider keys in the connector.
5. Grant access only to the user's selected bots. Verify tool discovery, a `media_desk_status` read, and the intended read-only/write scope before declaring the connection complete. All mutations require durable caller-provided `requestId` values.

Grok's remote MCP connector requires a reachable HTTPS URL; the workbench machine's loopback URL and Unix socket cannot serve as that cloud endpoint. The official [Grok MCP tunneling guide](https://docs.x.ai/grok/connectors/custom-mcp-tunneling) describes this optional route. Temporary tunnel URLs rotate when the tunnel restarts, so update the saved connector URL and `--public-host` accordingly. A stable URL requires an appropriate persistent tunnel/domain arrangement. Choose a tunnel that supports Streamable HTTP JSON responses. This route is not required when the Bot uses local execution and the CLI above.

For a read-only connection, start `media-desk --read-only mcp-http ...`; this both removes mutations from discovery and rejects direct mutation calls. Existing local stdio clients continue to use `media-desk mcp` unchanged.

Suggested agent instructions:

> Discover account IDs with media_desk_list_accounts/get_account first. Include accountId on every targeted request: omitted means All, null means Unassigned, a string means that exact profile. There is no shared server account selection. Follow pagination and distinguish multiple accounts on the same platform by ID. Use media_desk_assist for ordinary writing and revision with the workbench selected/subscription model; its requested production jobs run server-side. Use Media Desk's structured tools directly for explicit operations. First check status and its supportedPlatforms, then list compact items. For platform-specific reviews use media_desk_get_insights with canonical platform (快手 for Kuaishou); omit it only for aggregate results. Kuaishou supports manual/CSV/API metrics but no automatic Monid fetch. Follow list_items nextOffset with the same filters until it is null when you need the complete matching list. Read full article/production text only when needed. Explicitly import already-finished externally authored scripts with media_desk_write_draft when no additional generation is wanted. Use a unique durable requestId for every intended mutation and retain it. After OUTCOME_UNKNOWN, inspect request_status and item state; never retry blindly or change the ID to force a repeat. For PARTIAL_FAILURE, preserve successful receipts and do not repeat the partly successful batch; the same requestId returns its recorded result. Poll media_desk_production_status after starting/cancelling production or regenerating assets. Production and image regeneration can call paid configured providers. Calendar scheduling is local and does not publish to social platforms. Export uses the workbench's existing configured location and includes the composited cover.
