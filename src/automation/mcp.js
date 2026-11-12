import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { AutomationClient } from './client.js'
import { catalogFor, PLUGIN_VERSION } from './catalog.js'
import { failure } from './errors.js'
export function createMcpServer(options = {}) {
  const client = new AutomationClient(options)
  const tools = catalogFor(options.readOnly)
  const server = new Server({ name: 'media-desk', version: PLUGIN_VERSION }, { capabilities: { tools: {} }, instructions: 'Discover accounts with list_accounts/get_account. Every request may provide accountId: omitted means All/backward compatibility, null means Unassigned, and a string is a specific account ID. New imports with omitted accountId create Unassigned content. There is no shared active-account selection. Same-platform accounts are distinct. Use assign_items for explicit bounded reassignment; archive via update_account. Use assist for ordinary model-assisted writing and revision with the workbench selected/subscription model. Use compact list metadata first; request bounded article/production fields or compact media references only when needed. Save external scripts with write_draft without model calls. Import one image/video with import_file: path must be absolute on the workbench HOST, not a cloud client filesystem. Supported JPEG/PNG/WebP/GIF images are limited to 25000000 bytes, 40 megapixels and 16384 pixels per side; MP4/MOV/WebM videos to 250000000 bytes. Exact bytes are copied without modifying the source, model calls or transcoding. Video checks validate the container, not every codec/frame. Destination avatar requires a concrete accountId, accepts images only, forbids title/body/tags and creates no item. Inspect get_account avatar and matching avatarImportRequestId after uncertainty. Never send base64 or raw media bytes. All mutations require a durable caller-provided requestId. Reuse an ID only with identical arguments. Poll production_status for progress. After OUTCOME_UNKNOWN, inspect request_status and item state; for imports, list_items query can find importRequestId. Never blindly retry or change IDs to force replay. produce/regenerate_asset may incur configured provider costs. Calendar scheduling is local and does not publish to social platforms. Content lab: use get_content_lab for bounded records/rubrics/queue, then content_lab_action to evaluate a saved version, forecast a separate preview, lock it before publication and target data, register actual publication, and select a due local metric for retro. Lab mutations always require explicit accountId (string or null), exact IDs and requestId. New rubric presets are uncalibrated; fresh context means only the whitelisted review input was supplied, not guaranteed global model ignorance. Publication is a user declaration and never posts to a platform. Manuscript detail is opt-in. queryRequestId finds durable record evidence after uncertainty; do not dispatch the model again.' })
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
