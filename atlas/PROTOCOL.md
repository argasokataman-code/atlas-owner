# Atlas Protocol

Graph memory for Product Owner behavior. Read before work, follow after work.

## Skill — load otomatis
Kalau skill "atlas-owner" tersedia, load dulu (skill({ name: "atlas-owner" }))
sebelum pakai atlas — itu berisi aturan lengkap PO behavior + protocol.

## Pertama kali di project — scan dulu
Kalau atlas/ baru dibuat (atau query kosong), jalankan scan sekali buat peta
struktur repo, baru kerja:
node /Users/vanviakingali/Documents/Project/atlas-owner/skill/scripts/atlas.mjs scan [--depth 2]

## Retrieval — pakai MCP tools kalau ada (atlas_query/atlas_get/...), selain itu CLI:
node /Users/vanviakingali/Documents/Project/atlas-owner/skill/scripts/atlas.mjs query "keywords" [--tags a,b] [--limit 5]
node /Users/vanviakingali/Documents/Project/atlas-owner/skill/scripts/atlas.mjs recent [--limit 10]    # node terbaru
node /Users/vanviakingali/Documents/Project/atlas-owner/skill/scripts/atlas.mjs get ID
node /Users/vanviakingali/Documents/Project/atlas-owner/skill/scripts/atlas.mjs scan [--depth 2]       # map struktur repo (code-walk, idempotent)
# /Users/vanviakingali/Documents/Project/atlas-owner/skill/scripts/atlas.mjs diisi path absolut ke atlas.mjs oleh installer — jangan diganti manual.

## Record — tiap kerja signifikan, langsung di command yang sama.
node /Users/vanviakingali/Documents/Project/atlas-owner/skill/scripts/atlas.mjs record --id TASK-003 --type task --status done --tags a,b --summary "max 140 char" --conn "BUG-001:fixes,DEC-002:led_to"
node /Users/vanviakingali/Documents/Project/atlas-owner/skill/scripts/atlas.mjs record --id REQ-001 --type requirement --status active --tags core --summary "..." --conn "FEAT-001:relates" --file nodes/REQ-001.md

## Auto-record minimal — WAJIB setelah kerja signifikan
Selesai implement/analisa/fix? Record MINIMAL 1 node di command yang sama.
Kerja besar (banyak file)? Pecah jadi beberapa node per fitur/keputusan.
Keputusan arsitektur/kerangka -> type decision. Ketemu bug -> bug.
Bisnis berubah -> business + archive yang lama (led_to chain).
Ragu antara 2 tipe -> tanya user, jangan nebak.
# Plugin juga auto-record node tag "auto" setelah edit/bash — boleh kamu rapiin
# jadi tipe/summary yang tepat lewat update.

## Bisnis — Atlas paham produknya juga. Track perubahan bisnis.
node /Users/vanviakingali/Documents/Project/atlas-owner/skill/scripts/atlas.mjs record --id BUS-001 --type business --status active --tags biz,model --summary "keadaan bisnis sekarang" --conn "DEC-002:relates"
# bisnis berubah? archive yang lama, record yang baru (chain led_to = timeline)
node /Users/vanviakingali/Documents/Project/atlas-owner/skill/scripts/atlas.mjs update BUS-001 --status archived
node /Users/vanviakingali/Documents/Project/atlas-owner/skill/scripts/atlas.mjs record --id BUS-002 --type business --status active --tags biz,model --summary "keadaan baru" --conn "BUS-001:led_to"

## Limits (dienforce oleh check)
- summary <= 140 chars (auto-truncate ke nodes/{ID}.md kalau lebih panjang — gak ada yang hilang)
- node detail file <= 200 lines
- 1 shard <= 300 nodes (auto-split saat record)
- >= 1 conn per node. No orphan.

## PO behavior
Never re-propose what a NEG- or DEC- node already settled. Check the graph
via `atlas query` before proposing requirements, features, or changes.
Uncertain about a flow or insight (business OR technical)? Ask the user
before recording a node. Never guess a fact.
