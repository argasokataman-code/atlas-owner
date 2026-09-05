#!/usr/bin/env node
// atlas-owner MCP server — exposes the atlas CLI as in-process tools.
//
// Unlike the shell CLI (spawns node per call, ~50ms), this keeps one node
// process alive and runs every command in-process (~1ms per call). Tools:
// query, get, recent, stat, scan, record, update, delete, ingest, export,
// context, prune, check. Zero dependencies
// (stdio JSON-RPC over node:child_process-free imports).
//
// Install: add to opencode.json (or any MCP client) as a stdio server:
//   "mcp": { "atlas": { "type": "stdio", "command": "node", "args": ["<repo>/plugin/mcp-server.js"] } }
//
// Uses <repo>/skill/scripts/atlas.mjs via runCmd (no per-call process spawn).
import { readFileSync } from 'node:fs'
import { runCmd } from '../skill/scripts/atlas.mjs'

// --version / -v: print package version and exit (mirrors the CLI). Without
// this the server would sit silent waiting on stdin, which looks hung.
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  try {
    const p = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(p.version)
  } catch { console.log('unknown') }
  process.exit(0)
}

let buf = ''
const pending = new Map()

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function parsePath(s) { return s || '.' }

async function handle(method, params, id) {
  try {
    if (method === 'initialize') {
      return reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'atlas-mcp', version: '0.0.1' } })
    }
    if (method === 'notifications/initialized') return
    if (method === 'tools/list') {
      const tools = [
        { name: 'atlas_query', description: 'search graph memory', inputSchema: { type: 'object', properties: { q: { type: 'string' }, tags: { type: 'string' }, limit: { type: 'number' }, dir: { type: 'string' } } } },
        { name: 'atlas_get', description: 'get node by id', inputSchema: { type: 'object', properties: { id: { type: 'string' }, dir: { type: 'string' } } } },
        { name: 'atlas_recent', description: 'newest nodes', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, dir: { type: 'string' } } } },
        { name: 'atlas_stat', description: 'counts by type/status', inputSchema: { type: 'object', properties: { dir: { type: 'string' } } } },
        { name: 'atlas_scan', description: 'map repo structure', inputSchema: { type: 'object', properties: { target: { type: 'string' }, depth: { type: 'number' }, dir: { type: 'string' } } } },
        { name: 'atlas_record', description: 'add node', inputSchema: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string' }, status: { type: 'string' }, tags: { type: 'string' }, summary: { type: 'string' }, conn: { type: 'string' }, dir: { type: 'string' } } } },
        { name: 'atlas_update', description: 'change node', inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' }, tags: { type: 'string' }, dir: { type: 'string' } } } },
        { name: 'atlas_delete', description: 'remove node', inputSchema: { type: 'object', properties: { id: { type: 'string' }, force: { type: 'boolean' }, dir: { type: 'string' } } } },
        { name: 'atlas_ingest', description: 'read AGENTS.md/docs into knowledge nodes', inputSchema: { type: 'object', properties: { dir: { type: 'string' } } } },
        { name: 'atlas_export', description: 'dump full graph as JSON', inputSchema: { type: 'object', properties: { dir: { type: 'string' } } } },
        { name: 'atlas_context', description: 'preflight: infer feature from a path, list its nodes (open first)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, dir: { type: 'string' } } } },
        { name: 'atlas_prune', description: 'archive old done task nodes', inputSchema: { type: 'object', properties: { days: { type: 'number' }, dryRun: { type: 'boolean' }, force: { type: 'boolean' }, dir: { type: 'string' } } } },
        { name: 'atlas_check', description: 'verify integrity', inputSchema: { type: 'object', properties: { dir: { type: 'string' } } } },
      ]
      return reply(id, { tools })
    }
    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params
      const dir = parsePath(args.dir)
      const a = ['node', 'atlas']
      if (name === 'atlas_query') a.push('query', args.q || '', ...(args.tags ? ['--tags', args.tags] : []), ...(args.limit ? ['--limit', String(args.limit)] : []), dir)
      if (name === 'atlas_get') {
        if (!args.id) return reply(id, { content: [{ type: 'text', text: 'FAIL: atlas_get requires id' }], isError: true })
        a.push('get', args.id, dir)
      }
      if (name === 'atlas_recent') a.push('recent', ...(args.limit ? ['--limit', String(args.limit)] : []), dir)
      if (name === 'atlas_stat') a.push('stat', dir)
      if (name === 'atlas_scan') a.push('scan', dir, ...(args.target ? ['--target', args.target] : []), ...(args.depth ? ['--depth', String(args.depth)] : []))
      if (name === 'atlas_record') {
        if (!args.type || !args.status || !args.summary) return reply(id, { content: [{ type: 'text', text: 'FAIL: atlas_record requires type, status, summary' }], isError: true })
        a.push('record', ...(args.id ? ['--id', args.id] : []), '--type', args.type, '--status', args.status, ...(args.tags ? ['--tags', args.tags] : []), '--summary', args.summary, ...(args.conn ? ['--conn', args.conn] : []), dir)
      }
      if (name === 'atlas_update') {
        if (!args.id) return reply(id, { content: [{ type: 'text', text: 'FAIL: atlas_update requires id' }], isError: true })
        a.push('update', args.id, ...(args.status ? ['--status', args.status] : []), ...(args.summary ? ['--summary', args.summary] : []), ...(args.tags ? ['--tags', args.tags] : []), dir)
      }
      if (name === 'atlas_delete') {
        if (!args.id) return reply(id, { content: [{ type: 'text', text: 'FAIL: atlas_delete requires id' }], isError: true })
        a.push('delete', args.id, ...(args.force ? ['--force'] : []), dir)
      }
      if (name === 'atlas_ingest') a.push('ingest', dir)
      if (name === 'atlas_export') a.push('export', dir)
      if (name === 'atlas_context') {
        if (!args.path) return reply(id, { content: [{ type: 'text', text: 'FAIL: atlas_context requires path' }], isError: true })
        a.push('context', args.path, dir)
      }
      if (name === 'atlas_prune') a.push('prune', ...(args.days ? ['--days', String(args.days)] : []), ...(args.dryRun ? ['--dry-run'] : []), ...(args.force ? ['--force'] : []), dir)
      if (name === 'atlas_check') a.push('check', dir)
      const res = await runCmd(a)
      return reply(id, { content: [{ type: 'text', text: res.output }], isError: res.code !== 0 })
    }
    reply(id, { content: [{ type: 'text', text: `unknown method ${method}` }], isError: true })
  } catch (e) {
    reply(id, { content: [{ type: 'text', text: String(e && e.stack || e) }], isError: true })
  }
}

process.stdin.on('data', async (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.id !== undefined) await handle(msg.method, msg.params, msg.id).catch(e => console.error('atlas MCP error', e))
  }
})
