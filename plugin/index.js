// atlas-owner plugin — enforce Atlas graph memory in any opencode project.
// On project load: scaffolds atlas/ (manifest + shards + tags_index + PROTOCOL)
// if neither atlas/ nor legacy memory/ exists, then injects PROTOCOL.md into
// project instructions so the protocol is always in context.
//
// Install: add to opencode.json "plugin" array, e.g.
//   "plugin": ["/abs/path/to/atlas-owner/plugin/index.js"]
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCmd, SCHEMA_VERSION } from '../skill/scripts/atlas.mjs'

// ponytail: duplicated with skill/scripts/atlas.mjs PROTOCOL. Keep in sync.
const PROTOCOL = `# Atlas Protocol

Graph memory for Product Owner behavior. Read before work, follow after work.

## Skill — load otomatis
Kalau skill "atlas-owner" tersedia, load dulu (skill({ name: "atlas-owner" }))
sebelum pakai atlas — itu berisi aturan lengkap PO behavior + protocol.

## Pertama kali di project — scan dulu
Kalau atlas/ baru dibuat (atau query kosong), jalankan scan sekali buat peta
struktur repo, baru kerja:
node <atlas> scan [--depth 2] [--symbols]

## Retrieval — pakai MCP tools kalau ada (atlas_query/atlas_get/...), selain itu CLI:
node <atlas> query "keywords" [--tags a,b] [--limit N] [--compact] [--all] [--since N] [--feature F] [--features]
node <atlas> recent [--limit 10]    # node terbaru
node <atlas> get ID
node <atlas> context <filepath>     # infer feature from file, list nodes
node <atlas> feature <nama> --paths a,b,c   # map path-prefix -> feature
node <atlas> cluster                # group active nodes by topic
# <atlas> diisi path absolut ke atlas.mjs oleh installer — jangan diganti manual.

## Record — tiap kerja signifikan, langsung di command yang sama.
node <atlas> record --id TASK-003 --type task --status done --tags a,b --summary "max 140 char" --conn "BUG-001:fixes,DEC-002:led_to" [--loc file:line] [--commit hash]
node <atlas> record --id REQ-001 --type requirement --status active --tags core --summary "..." --conn "FEAT-001:relates" --file nodes/REQ-001.md

## Auto-record minimal — WAJIB setelah kerja signifikan
Selesai implement/analisa/fix? Record MINIMAL 1 node di command yang sama.
Kerja besar (banyak file)? Pecah jadi beberapa node per fitur/keputusan.
Keputusan arsitektur/kerangka -> type decision. Ketemu bug -> bug.
Bisnis berubah -> business + archive yang lama (led_to chain).
Ragu antara 2 tipe -> tanya user, jangan nebak.
# Plugin juga auto-record node tag "auto" setelah edit/bash — boleh kamu rapiin
# jadi tipe/summary yang tepat lewat update.

## Bisnis — Atlas paham produknya juga. Track perubahan bisnis.
node <atlas> record --id BUS-001 --type business --status active --tags biz,model --summary "keadaan bisnis sekarang" --conn "DEC-002:relates"
# bisnis berubah? archive yang lama, record yang baru (chain led_to = timeline)
node <atlas> update BUS-001 --status archived
node <atlas> record --id BUS-002 --type business --status active --tags biz,model --summary "keadaan baru" --conn "BUS-001:led_to"

## Maintenance — bulk, prune, schema
node <atlas> update|delete --filter "type=task&status=done&tags=auto" [--dry-run]  # bulk by filter
node <atlas> prune [--days N] [--dry-run] [--force]    # archive old/done/auto noise
node <atlas> migrate | edit ID | export --stats | verify   # schema / edit / dump / integrity

## Limits (dienforce oleh check)
- summary <= 140 chars (auto-truncate ke nodes/{ID}.md kalau lebih panjang — gak ada yang hilang)
- node detail file <= 200 lines
- 1 shard <= 300 nodes (auto-split saat record)
- >= 1 conn per node. No orphan.

## PO behavior
Never re-propose what a NEG- or DEC- node already settled. Check the graph
via \`atlas query\` before proposing requirements, features, or changes.
Uncertain about a flow or insight (business OR technical)? Ask the user
before recording a node. Never guess a fact.
`

const RULES = `# Atlas Rules

- Every fact = one node. No orphan nodes: each node has >= 1 conn edge.
- Modular: nodes live in index.{n}.json shards (auto-split at 300 default; ATLAS_MAX_SHARD overrides). id_map.json maps id -> shard; tags_index.json maps tag -> [{id, shard}].
- Never read atlas/*.json raw. Use the CLI: query, recent, get, record, update.
- summary <= 140 chars. node files <= 200 lines.

## Types: requirement, feature, task, bug, decision, business, positive, negative, edge, pitfall
## Status: active, done, fixed, open, archived
## Connections: fixes, caused, led_to, relates, blocks, depends, contradicts, example_of, implements, satisfies

## Classification — choose one type:
- business: market/pricing/value-proposition state
- decision: a choice made (with reason)
- positive/negative: what worked / what failed
- edge: boundary case worth remembering
- pitfall: a trap to avoid (not just a failure)
- requirement/feature/task/bug: standard dev backlog
`

const README = `# Atlas — Product Owner Graph Memory

- manifest.json + index.{n}.json (shards) + id_map.json + tags_index.json + nodes/*.md
- Read via CLI (query/recent/get/record), never raw JSON.
- Record every significant requirement, feature, decision, bug, task, gotcha.
`

function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// M5 semantic auto-record helpers. Zero deps, stdlib only.

function lineCount(s) {
  if (s == null) return 0
  return s.split('\n').length
}

function noteFragment(s) {
  if (s == null) return ''
  const line = (s.split('\n').find((l) => l.trim()) || '').trim()
  return line.slice(0, 40)
}

// ponytail: type hint lives in the note, not the base summary, so the canonical
// `change: file (+A/-D) — edit via tool` shape stays intact.
function buildSummary(tool, target, args) {
  const op = tool === 'write' ? 'write' : 'edit'
  let diff = ''
  if (tool === 'edit' && args?.oldString != null && args?.newString != null) {
    diff = ` (+${lineCount(args.newString)}/-${lineCount(args.oldString)})`
  } else if (tool === 'write' && args?.content != null) {
    diff = ` (+${lineCount(args.content)})`
  }
  const src = tool === 'write' ? args?.content : args?.newString
  const frag = noteFragment(src)
  const typeHint = /\.(ts|tsx|js|jsx)$/.exec(target)?.[1] || ''
  const note = frag ? (typeHint ? `${typeHint}: ${frag}` : frag) : ''
  let summary = `change: ${target}${diff} — ${op} via tool`
  if (note) summary += `: ${note}`
  return summary.slice(0, 140)
}

// ponytail: aggressive — strips ALL whitespace, so `foo bar` vs `foobar` counts
// as format-only and is skipped. Spec says strip all; leave it.
function isWhitespaceOnly(oldS, newS) {
  if (oldS == null || newS == null) return false
  return oldS.replace(/\s+/g, '') === newS.replace(/\s+/g, '')
}

// ponytail: in-memory map keyed by summary, pruned on read. A CLI query per
// record would be slower and still need an in-memory map. Fine for a session.
const recentSummaries = new Map()
function summarySeen(summary) {
  const now = Date.now()
  for (const [k, t] of recentSummaries) {
    if (now - t > 5 * 60 * 1000) recentSummaries.delete(k)
  }
  if (recentSummaries.has(summary)) return true
  recentSummaries.set(summary, now)
  return false
}

// M6b preflight: pull the target path out of a tool call. edit/write carry it
// in filePath; bash carries it inside the command. ponytail: for bash, take the
// first token that exists on disk, else the first code-file token — skips
// version strings like `1.2.3` and non-file noise.
function extractPath(root, tool, args) {
  if (!args) return ''
  if (tool === 'edit' || tool === 'write') return args.filePath || args.path || ''
  if (tool === 'bash') {
    const cmd = args.command || args.cmd || ''
    const m = cmd.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) || []
    if (!m.length) return ''
    const codeRe = /\.(js|jsx|ts|tsx|mjs|cjs|php|py|go|rb|java|kt|rs|c|cpp|h|json|md|vue|svelte|css|scss|html|xml|yaml|yml)$/i
    for (const c of m) {
      const p = c.startsWith('/') ? c : join(root, c)
      if (existsSync(p)) return c
    }
    return m.find((c) => codeRe.test(c)) || ''
  }
  return ''
}

// ponytail: global 10s throttle — one context call per tool burst, no timer
// cleanup, no per-path dedupe (a burst edits one file anyway).
const PREFLIGHT_MS = 10 * 1000
let lastPreflightAt = 0

function openIssueIds(text) {
  const ids = []
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^\[([A-Z]+-\d+)\] [a-z]+\/(open) /)
    if (m) ids.push(m[1])
  }
  return ids
}

// Preflight: query the graph for open bugs/issues touching this path and warn.
// Best-effort — never blocks the tool, never throws.
async function preflight(root, atlas, path) {
  const now = Date.now()
  if (now - lastPreflightAt < PREFLIGHT_MS) return
  lastPreflightAt = now
  try {
    const res = await runCmd(['node', 'atlas', 'context', path, root])
    const open = openIssueIds(res.output)
    if (open.length) {
      console.log(`[atlas] ⚠ open bug ${open.join(', ')} on ${path} — see context`)
    }
  } catch { /* preflight is best-effort */ }
}

// M6b afterflight: build/test commands get a `verify:` node when they pass.
// ponytail: substring match on common build/test verbs — enough to catch the
// documented cases (npm test, npm run build, go test, pytest, make).
function isVerifyCmd(cmd) {
  return /npm test|npm run test|npm run build|npm run lint|go test|pytest|make\b|phpunit|composer test|yarn test|yarn build/.test(cmd)
}

// ponytail: conservative — any failure marker skips the "passed" node, so we
// never record a false success. False-negative (a passing build that prints
// "Error" in a test name) is the safer failure mode here.
function looksFailed(text) {
  return /(\bFAIL(ED)?\b|Error:|npm error|make: \*\*\*|Traceback|AssertionError|exit status|exited with code|✖|tests? failed)/i.test(text || '')
}

async function afterflightVerify(root, atlas, args, output) {
  const cmd = (args?.command || args?.cmd || '').trim()
  if (!cmd || !isVerifyCmd(cmd)) return
  if (output && looksFailed(output.output)) return
  const summary = `verify: ${cmd} passed`.slice(0, 140)
  if (summarySeen(summary)) return
  // Anchor to an existing node so the graph stays connected (same as M5).
  let anchor = ''
  try {
    const mapFile = join(atlas, 'id_map.json')
    if (existsSync(mapFile)) {
      const map = JSON.parse(readFileSync(mapFile, 'utf8'))
      anchor = Object.keys(map)[0] || ''
    }
  } catch { /* no anchor */ }
  try {
    await runCmd(['node', 'atlas', 'record', '--type', 'task', '--status', 'done',
      '--tags', 'auto,verify', '--summary', summary,
      ...(anchor ? ['--conn', `${anchor}:relates`] : []), root])
  } catch { /* memory write is best-effort */ }
}

// M6b CLI-backed dedupe on top of the in-memory map. Query first 3 words,
// exact-summary match. Archived excluded by default, so open/fixed/done only.
// ponytail: single exact-match pass over the compact results, no scoring math.
async function nodeExists(root, summary) {
  const q = summary.split(/\s+/).slice(0, 3).join(' ')
  try {
    const res = await runCmd(['node', 'atlas', 'query', q, '--compact', '--limit', '20', root])
    const want = summary.trim()
    for (const line of (res.output || '').split('\n')) {
      const m = line.match(/^\s*([A-Z]+-\d+)\s*\|\s*(.+)$/)
      if (m && m[2].trim() === want) return m[1]
    }
  } catch { /* dedupe is best-effort */ }
  return null
}

export default async ({ directory }) => {
  const root = resolve(directory || process.cwd())
  // Never scaffold into the home directory or a bare shell dir without a project marker.
  if (root === homedir()) return {}
  const atlas = join(root, 'atlas')
  const proto = join(atlas, 'PROTOCOL.md')
  const hasAtlas = existsSync(join(atlas, 'manifest.json'))
  const hasLegacy = existsSync(join(root, 'memory'))
  // <atlas> placeholder in PROTOCOL -> real path to atlas.mjs (this plugin's sibling).
  const cliPath = fileURLToPath(new URL('../skill/scripts/atlas.mjs', import.meta.url))
  const protocolText = PROTOCOL.replaceAll('<atlas>', cliPath)

  if (!hasAtlas && !hasLegacy) {
    mkdirSync(join(atlas, 'nodes'), { recursive: true })
    const today = todayStr()
    const manifest = `{
  "schema_version": ${SCHEMA_VERSION},
  "updated": "${today}",
  "active_shard": 0,
  "node_count": 0,
  "seed_id": null
}
`
    const shard = `{
  "shard": 0,
  "nodes": []
}
`
    // 'wx' = fail if file already exists (concurrent plugin load race)
    for (const [f, c] of [
      ['manifest.json', manifest],
      ['index.0.json', shard],
      ['tags_index.json', '{}\n'],
      ['id_map.json', '{}\n'],
    ]) {
      try {
        writeFileSync(join(atlas, f), c, { flag: 'wx' })
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
      }
    }
    writeFileSync(proto, protocolText)
    writeFileSync(join(atlas, 'rules.md'), RULES)
    writeFileSync(join(atlas, 'README.md'), README)
    console.log('[atlas-owner] scaffolded atlas/ graph memory (modular shards)')
  } else if (hasAtlas && !existsSync(proto)) {
    // Repair: atlas/ exists but protocol was lost. Only inject paths that exist.
    writeFileSync(proto, protocolText)
  }

  return {
    config: (cfg) => {
      if (hasLegacy || !existsSync(proto)) return
      const instructions = cfg.instructions ?? []
      if (!instructions.includes('atlas/PROTOCOL.md')) {
        instructions.push('atlas/PROTOCOL.md')
        cfg.instructions = instructions
      }
    },
    // M6b preflight: warn about open bugs/issues on the file being touched
    // before the tool runs. Best-effort, 10s throttle, skip when no atlas/.
    'tool.execute.before': async (input, output) => {
      if (hasLegacy || !existsSync(join(atlas, 'manifest.json'))) return
      if (input.tool !== 'edit' && input.tool !== 'write' && input.tool !== 'bash') return
      const path = extractPath(root, input.tool, output?.args || {})
      if (!path) return
      await preflight(root, atlas, path)
    },
    // Enforce: after the AI edits/writes files, auto-record a task node so
    // memory updates even when the model forgets to. One node per edit path per
    // minute (batch merge), whitespace-only edits skipped, 5-min summary dedupe.
    'tool.execute.after': async (input, output) => {
      if (hasLegacy || !existsSync(join(atlas, 'manifest.json'))) return
      const { tool, args } = input
      // Build/test bash commands leave a verify trace; other bash (queries, git
      // status, npm view...) is noise — recording it pollutes the graph with
      // #auto nodes (see PF-002 in the atlas-owner graph).
      if (tool === 'bash') { await afterflightVerify(root, atlas, args, output); return }
      // Only file edits/writes leave work traces.
      if (tool !== 'edit' && tool !== 'write') return
      const target = args?.filePath || args?.path || ''
      if (!target) return
      // Whitespace/format-only edit is noise (M5) — skip the record entirely.
      if (tool === 'edit' && isWhitespaceOnly(args?.oldString, args?.newString)) return
      const key = `${new Date().toISOString().slice(0, 16)}|${target}` // ~1/min bucket
      if (lastRecorded[key]) return
      lastRecorded[key] = true
      const summary = buildSummary(tool, target, args)
      // 5-min dedupe: same logical change (same summary) recorded twice? skip.
      if (summarySeen(summary)) return
      // M6b CLI dedupe: an identical summary already in the graph (open/fixed/
      // done)? skip the record instead of creating a duplicate node.
      const dup = await nodeExists(root, summary)
      if (dup) { console.log('[atlas] dedupe: node exists'); return }
      // Anchor to an existing node so the graph stays connected; empty graph
      // (no id_map) falls through and the first node becomes the seed.
      let anchor = ''
      try {
        const mapFile = join(atlas, 'id_map.json')
        if (existsSync(mapFile)) {
          const map = JSON.parse(readFileSync(mapFile, 'utf8'))
          anchor = Object.keys(map)[0] || ''
        }
      } catch { /* no anchor */ }
      try {
        await runCmd(['node', 'atlas', 'record', '--type', 'task', '--status', 'done',
          '--tags', 'auto', '--summary', summary, '--loc', target,
          ...(anchor ? ['--conn', `${anchor}:relates`] : []), root])
      } catch { /* memory write is best-effort */ }
    },
  }
}

// Keeps auto-record from firing repeatedly for the same edit in one minute.
const lastRecorded = {}
