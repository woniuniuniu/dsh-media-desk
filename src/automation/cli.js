import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AutomationClient } from './client.js'
import { catalog, catalogFor, PLUGIN_VERSION } from './catalog.js'
import { failure } from './errors.js'
const HELP = `media-desk — local workbench automation (JSON output)\n\nUsage: media-desk [--home DSH_HOME] [--profile desktop] [--read-only] COMMAND\n  tools [TOOL]              concise catalog; TOOL includes its full JSON schema\n  doctor                    local workbench status\n  call TOOL --input JSON    call a tool (--input-file FILE also supported)\n  accounts list/get/add     profiles and counts; add NAME --input JSON\n  items list [--input JSON]  compact filtered item metadata\n  items get ID              metadata (use call for bounded text fields)\n  assist MESSAGE            author/revise using the selected workbench model\n  write MESSAGE             model-assisted authoring (same as assist)\n  write-draft ID            explicitly import finished text (--input JSON)\n  idea add TITLE            add one idea (--input JSON supports more fields)\n  schedule ID ISO8601|null   schedule with explicit timezone; null cancels\n  produce ID                start configured production; may incur model costs\n  production ID             compact production status\n  export ID                 export to workbench-configured location\n  mcp                       official MCP stdio server\n  mcp-http --token-file PATH [--port 41419] [--public-host HOST]\n                            authenticated loopback HTTP MCP server\n\nMutations accept --request-id ID. CLI generates one if omitted and returns it.\nAfter OUTCOME_UNKNOWN, inspect media_desk_request_status and item state. Never\nblindly retry with a new ID. MCP callers must always provide requestId.\n`
export async function runCli(argv = process.argv.slice(2)) {
  const options = {}; const args = []; let inputRaw; let inputFile; let requestId
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      if (['--home', '--profile', '--input', '--input-file', '--request-id', '--port', '--token-file', '--public-host'].includes(arg)) {
        const value = argv[++i]; if (value === undefined) throw new Error(`Missing value for ${arg}.`)
        if (arg === '--input') inputRaw = value
        else if (arg === '--input-file') inputFile = value
        else if (arg === '--request-id') requestId = value
        else if (arg === '--port') { if (!/^\d+$/.test(value)) throw new Error('Invalid port.'); options.port = Number(value) }
        else if (arg === '--token-file') options.tokenFile = value
        else if (arg === '--public-host') (options.publicHosts ??= []).push(value)
        else options[arg.slice(2)] = value
      } else if (arg === '--read-only') options.readOnly = true
      else args.push(arg)
    }
    if (!args.length || args[0] === '--help' || args[0] === 'help') { process.stdout.write(HELP); return 0 }
    if (args[0] === 'tools') {
      const list = catalogFor(options.readOnly)
      const result = args[1] ? list.find(t => t.name === args[1]) : list.map(t => ({ name: t.name, description: t.description, mutation: t.mutation }))
      if (!result) throw new Error('Unknown or disabled tool.')
      process.stdout.write(JSON.stringify({ ok: true, result }) + '\n'); return 0
    }
    if (args[0] === 'mcp') { const { startMcp } = await import('./mcp.js'); await startMcp(options); return 0 }
    if (args[0] === 'mcp-http') {
      if (args.length !== 1) throw new Error('Unexpected HTTP arguments.')
      const { startMcpHttp } = await import('./http.js')
      const bridge = await startMcpHttp(options)
      let stop
      try {
        await new Promise((resolve, reject) => {
          let stopping = false
          stop = () => { if (stopping) return; stopping = true; bridge.dispose().then(resolve, reject) }
          process.once('SIGINT', stop); process.once('SIGTERM', stop)
          process.stderr.write(`Media Desk MCP HTTP ${PLUGIN_VERSION} listening at ${bridge.url}\n`)
        })
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await bridge.dispose() }
      return 0
    }
    if (inputRaw !== undefined && inputFile !== undefined) throw new Error('Choose --input or --input-file.')
    const supplied = inputFile !== undefined ? JSON.parse(await readFile(inputFile, 'utf8')) : inputRaw !== undefined ? JSON.parse(inputRaw) : {}
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('Input must be a JSON object.')
    let tool; let input = supplied
    switch (args[0]) {
      case 'doctor': tool = 'media_desk_status'; break
      case 'call': tool = args[1]; break
      case 'items': tool = args[1] === 'get' ? 'media_desk_get_item' : args[1] === 'list' ? 'media_desk_list_items' : undefined; if (args[1] === 'get') input = { ...input, id: args[2] }; break
      case 'accounts': if(args[1]==='list')tool='media_desk_list_accounts'; else if(args[1]==='get'){tool='media_desk_get_account';input={...input,id:args[2]}} else if(args[1]==='add'){tool='media_desk_apply_ops';input={ops:[{op:'add_account',...(args[2]?{handle:args.slice(2).join(' ')}:{}),...input}]}} break
      case 'idea': if (args[1] === 'add') {
        tool = 'media_desk_apply_ops'
        const { accountId, requestId: suppliedId, ...fields } = input
        input = { accountId, ...(suppliedId ? {requestId:suppliedId} : {}), ops: [{ op: 'add_item', ...(args[2] ? { title: args.slice(2).join(' ') } : {}), ...fields }] }
      } break
      case 'schedule': {
        tool = 'media_desk_apply_ops'
        const { accountId, requestId: suppliedId, ...fields } = input
        input = { accountId, ...(suppliedId ? {requestId:suppliedId} : {}), ops: [{ op: 'schedule_item', id: args[1], scheduledAt: args[2] === 'null' ? null : args[2], ...fields }] }
        break
      }
      case 'assist':
      case 'write': tool = 'media_desk_assist'; input = { ...input, ...(args[1] ? { message: args.slice(1).join(' ') } : {}) }; break
      case 'write-draft': tool = 'media_desk_write_draft'; input = { ...input, id: args[1] }; break
      case 'produce': tool = 'media_desk_produce'; input = { ...input, id: args[1] }; break
      case 'production': tool = 'media_desk_production_status'; input = { ...input, id: args[1] }; break
      case 'export': tool = 'media_desk_export'; input = { ...input, id: args[1] }; break
      default: throw new Error('Unknown command. Use --help.')
    }
    const def = catalog.find(t => t.name === tool)
    if (!def) throw new Error('Unknown command or tool. Use tools to discover operations.')
    if (def.mutation) requestId ??= input.requestId ?? randomUUID()
    const response = await new AutomationClient(options).call(tool, input, requestId)
    process.stdout.write(JSON.stringify(response) + '\n'); return response.ok ? 0 : response.error.code === 'OUTCOME_UNKNOWN' ? 3 : 1
  } catch (e) {
    if (argv.includes('mcp-http')) { process.stderr.write('Media Desk MCP HTTP startup failed. Check token-file permissions, port and profile configuration.\n'); return 2 }
    if (args[0] === 'mcp') { process.stderr.write('Media Desk MCP startup failed. Check runtime dependencies and profile configuration.\n'); return 2 }
    // Parse/usage errors cannot include submitted bodies, credentials or paths.
    process.stdout.write(JSON.stringify(failure('INVALID_ARGUMENT', 'Invalid command or input. Use --help and tools TOOL for the schema.', undefined, requestId)) + '\n')
    return 2
  }
}
