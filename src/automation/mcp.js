import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { AutomationClient } from './client.js'
import { catalogFor, PLUGIN_VERSION } from './catalog.js'
import { failure } from './errors.js'
export function createMcpServer(options = {}) {
  const client = new AutomationClient(options)
  const tools = catalogFor(options.readOnly)
  const server = new Server({ name: 'media-desk', version: PLUGIN_VERSION }, { capabilities: { tools: {} }, instructions: 'Discover accounts with list_accounts/get_account. Every request may provide accountId: omitted means All/backward compatibility, null means Unassigned, and a string is a specific account ID. There is no shared active-account selection. Same-platform accounts are distinct. Use assign_items for explicit bounded reassignment; archive via update_account. Use assist for ordinary model-assisted writing and revision with the workbench selected/subscription model. Use compact list metadata first; request bounded article/production fields only when needed. Save external scripts with write_draft without model calls. All mutations require a durable caller-provided requestId. Reuse an ID only with identical arguments. Poll production_status for progress. After OUTCOME_UNKNOWN, inspect request_status and item state; never blindly retry or change IDs to force replay. produce/regenerate_asset may incur configured provider costs. Calendar scheduling is local and does not publish to social platforms.' })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ mutation, ...tool }) => tool) }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const response = tools.some(t => t.name === params.name) ? await client.call(params.name, params.arguments ?? {}) : failure(options.readOnly ? 'READ_ONLY' : 'UNKNOWN_TOOL', 'Unknown or disabled tool.')
    return { structuredContent: response, content: [{ type: 'text', text: JSON.stringify(response) }], isError: !response.ok }
  })
  return server
}
export async function startMcp(options = {}) {
  const server = createMcpServer(options)
  await server.connect(new StdioServerTransport())
  return server
}
