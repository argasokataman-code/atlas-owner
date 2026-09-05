# Plan Fixing Feedback — atlas-owner v2

> Dibuat: 2026-09-05
> Sumber feedback: `EVALUASI-SKILL.md`, `EVALUASI-DALAM-V2.md`, `ISSUE-ATLAS-PEKA.md`
> Status kode saat ini: TIDAK di-update sejak feedback ditulis (last commit `e97c395`, 2026-08-09). Semua poin relevan.

---

## 1. Tujuan

Bawa atlas-owner dari "memori pasif penuh noise" ke "graph memory yang dipakai,
cepat, dan nyambung ke kode". Ukuran keberhasilan (dari `EVALUASI-DALAM-V2.md` §7):

1. Tiap sesi agent dapat konteks relevan otomatis tanpa disuruh.
2. Auto-record bikin node yang bisa dibaca manusia (intent, bukan path).
3. Query bisa cari fungsi/simbol/commit, bukan cuma keyword.
4. Scan paham arsitektur repo (package, service, dependency).
5. Load cepat: query tanpa tags gak baca semua shard.
6. Token hemat: inject 200 token ganti manual-search 2-5k token.

---

## 2. Daftar Feedback (dipetakan ke status kode)

| # | Feedback | Status kode | Catatan |
|---|----------|-------------|---------|
| F1 | Parser CLI rapuh (`--tags` comma bikin `--status` salah) | ⚠️ Sebagian salah diagnosis | Comma BERFUNGSI. Bug asli: nilai berawalan `--` dibuang + tanpa validasi nilai (`atlas.mjs:175`). |
| F2 | Gak ada bulk operation (`update --filter`, `delete --filter`) | ❌ Belum ada | update/delete per-id. Konsolidasi masih pake script eksternal yang edit JSON raw (langgar CLI-first). |
| F3 | Gak ada pruning/TTL | ❌ Belum ada | `archived` cuma manual via `update`. |
| F4 | Detail `.md` jarang terisi, gak ada enforcement | ⚠️ Sebagian ada | Auto-overflow `.md` ada (`atlas.mjs:452-453, 520-523`); `check` verify ≤200 baris + orphan (`1131-1139`). Kurang: `edit ID`, enforcement "wajib detail". |
| F5 | Atlas pasif → aktif (preflight/afterflight, MCP aktif, dedupe, kategorisasi per fitur) | ❌ Belum ada | Plugin cuma hook `tool.execute.after` (edit/write only). |
| F6 | Semantic auto-record (intent, bukan "edited file") | ❌ Belum ada | `plugin/index.js:174` masih `summary: 'auto: edited ' + target`. |
| F7 | Upgrade versi atlas → data lama di repo gak auto-menyesuaikan (bisa double atlas / schema bentrok) | ❌ Belum ada | `manifest.version` dead field (gak pernah dibaca). `doctor` cuma cek drift versi install, BUKAN migrasi data. Nol mekanisme migrasi. |

**Prioritas:** P0 = F1, F2. P1 = F3, F4. P2 = F5, F6. P1 = F7 (v2 blocker — folderisasi M6 butuh migrasi data dulu).

---

## 3. Milestone

Urutan dipilih berdasar impact/effort. Tiap milestone mandiri + shipable + testable.

### M1 — Fix parser argumen CLI (F1) ✅ DONE 2026-09-05

**Tujuan:** Hilangkan bug parser + dukung nilai yang benar.

**Root cause** (`skill/scripts/atlas.mjs:166-182`):
- Nilai berawalan `--` dibuang → `--summary "--not-a-flag"` → error.
- Tanpa validasi nilai → `--status summary` nyerap token salah.

**Scope:**
- Audit `parseArgs` di `atlas.mjs` (~40-60 baris berubah).
- Validasi nilai per-flag (status harus salah satu `active|done|fixed|open|archived`).
- Dukung nilai berawalan `--` via `--flag=value`.
- Dukung nilai multi-token (unquoted list).

**File kena:** `skill/scripts/atlas.mjs` (+ PROTOCOL sync, lihat §4).

**Acceptance criteria:**
- `record --tags a,b --status done` jalan tanpa error. ✅
- `record --summary "--starts with flag"` tersimpan utuh (via `--summary=...`). ✅
- `record --status bogus` → error jelas (bukan silent). ✅
- `node --check atlas.mjs` lolos. ✅

**Hasil verifikasi (smoke /tmp):** 7/8 PASS. Comma tags, `=` form, validation jalan.
1 "FAIL" = `--flag value` space form kalau value berawalan `--` — ini ambiguitas CLI
inherent (gak bisa dibedain dari flag berikutnya). Workaround `=` form tersedia.
Bukan bug, gak perlu di-fix.

**Test:** smoke di /tmp (pola AGENTS.md "Verify before committing").

---

### M2 — Bulk operation `update --filter` / `delete --filter --force` (F2) ✅ DONE 2026-09-05

**Tujuan:** Konsolidasi tanpa script eksternal yang edit JSON raw. Ini juga FIX
pelanggaran hard rule #1 (CLI-first).

**Scope:**
- Filter syntax: `--filter "type=task&status=done&tags=auto"` (logika AND per shard).
- `update --filter ... --status archived [--tags x] [--summary y]`.
- `delete --filter ... --force` — WAJIB strip conn refs dari node lain (pola `deleteNode:990-1003`).
- Rebuild `id_map.json` + `tags_index.json` + `node_count` konsisten setelah operasi.
- Dukung `--dry-run` (print jumlah + contoh ID yang kena, tanpa ubah).

**File kena:** `skill/scripts/atlas.mjs` (~80-120 baris).

**Acceptance criteria:**
- `--dry-run` beneran gak ubah apa-apa.
- Archive massal → `check` tetap OK (no orphan, id_map sinkron).
- `delete --force` → node lain yang reference ke node terhapus ikut di-strip conn-nya.

**Test:** buat graph temp (20 node, 5 auto-noise), filter archive, `check` OK.

---

### M3 — Enforcement `.md` storage + command `edit ID` (F4) ✅ DONE 2026-09-05

**Tujuan:** Detail panjang gak hilang; agent bisa nulis/tambah detail aman.

**Scope:**
- Command `edit ID` — baca/tulis `nodes/{ID}.md` (append aman, ≤200 baris enforced).
- `record` dengan `--file` → tulis ke `nodes/{ID}.md`, jangan bikin summary panjang.
- `check` verifikasi: summary ≤140, md ≤200 baris, md tanpa orphan.

**File kena:** `skill/scripts/atlas.mjs` (~30-50 baris).

**Acceptance criteria:**
- `edit BUG-001` buka file detail (atau buat kalau belum ada).
- `check` nangkap md yang ≥200 baris + md tanpa node di index.

---

### M4 — Pruning otomatis (F3) ✅ DONE 2026-09-05

**Tujuan:** Graph bersih + load cepat tanpa nambah beban manual.

**Scope (bangun di atas filter M2):**
- Kriteria auto-archive:
  - `type=task & status=done` + umur > 90 hari + leaf (gak ada conn masuk).
  - `tags=auto` murni + `status=done` + leaf.
  - Node penting (bug/decision/requirement/business/negative/edge) GAK disentuh.
- ⚠️ **Guard keras:** jangan archive node edge-less (seed) → kalau kena, `check` orphan error.
- Hooks: `prune --auto` dijalankan probabilistik (5% / tiap 100 record) ATAU manual `prune`.
- Update `manifest.json`: `pruned_count`, `last_prune_at`.
- `query` default skip `archived` (periksa: sudah atau perlu flag `--all`).

**File kena:** `skill/scripts/atlas.mjs` (~60-90 baris).

**Acceptance criteria:**
- Prune kering: seed + node penting selamat.
- Prune basah: archive massal → `check` OK, `stat` nunjukin status pindah.
- Idempotent: prune 2x → hasil sama.

---

### M5 — Semantic auto-record (F6) ✅ DONE 2026-09-05

**Tujuan:** Auto-record berisi intent, bukan "edited file".

**Scope** (`plugin/index.js`):
- Ambil diff stat + nama fungsi/file yang berubah dari tool args (edit/write).
- Infer intent: summary jadi `"change: <fungsi> di <file> — <intent>"`.
- Filter noise: skip kalau cuma whitespace/format.
- Merge batch edit beruntun file sama (dalam 1 menit → 1 node), bukan 1 node/edit.

**File kena:** `plugin/index.js` (~40-60 baris). **Zero deps** — stdlib compare, gak ada fuzzy-match lib.

**Acceptance criteria:**
- Edit 1 file → 1 node dengan summary bermakna (bukan `auto: edited`).
- Edit 5x file sama dalam 1 menit → 1 node, bukan 5.
- Whitespace-only edit → gak record.

---

### M6 — Atlas aktif (preflight/afterflight, dedupe, kategorisasi) (F5) ✅ DONE 2026-09-05

**Tujuan:** Atlas datang sendiri, gak nunggu disuruh. Fase ini PALING BESAR,
dikerjakan terakhir setelah M1-M5 stabil.

**Sub-item:**
1. **MCP aktif:** server (bukan CLI manual) yang bisa nge-hook event kerja.
2. **Preflight otomatis:** sebelum edit/run bash → query otomatis "open bug/pitfall
   nyentuh path ini?" → warn kalau ada.
3. **Afterflight otomatis:** selesai kerja → record node dengan reasoning dari
   CMD/conversation (bukan "edited file").
4. **Auto-dedupe:** node mirip (summary/path/tags) → collide/merge, bukan node baru.
5. **Kategorisasi per fitur:** `atlas/features/<nama-fitur>/{index.md,BUGS.md,EDGES.md,ISSUES.md}`
   — infer nama fitur dari path → mapping path→fitur di manifest.

**File kena:** `plugin/index.js` + `mcp-server.js` + `atlas.mjs` (200+ baris, multi-file).

**Acceptance criteria:**
- Sesi baru: agent langsung dapat konteks relevan tanpa disuruh.
- Edit file dengan BUG terbuka di path sama → agent di-warn DULU, bukan setelah user nanya.
- Dedupe: 2 record dengan summary sama → 1 node.
- Fitur: node baru masuk folder fitur + update `index.md`.

---

### M7 — Auto-migrasi data versi lama (F7) ✅ DONE 2026-09-05

**Tujuan:** User upgrade versi atlas-owner → data `atlas/` di tiap repo yang udah
terinstall ikut menyesuaikan otomatis (folderisasi, penamaan, schema) tanpa user
action, tanpa bikin double atlas / data dobel.

**Kondisi sekarang (bukti):**
- `manifest.version: 1` = **dead field** — ditulis di `init` (`atlas.mjs:290`), gak pernah dibaca di manapun. Nol gate.
- `doctor` (`atlas.mjs:370-417`) = cek drift versi INSTALL (npm global vs skill copy vs MCP), **bukan migrasi data**.
- Nol commit migrasi dalam sejarah (0.7.0→0.7.5 semua feature/fix).
- Backward-compat yang ada cuma read-time tolerance (`tags_index` v2 `{id,shard}` vs legacy string, `atlas.mjs:556-570`) — bukan migrasi.

**Risiko double-atlas / bentrok (bukti konkret):**
- Rename file index (mis. `tags_index.json`→`tags.json`) → file lama orphan, `check` FAIL, `rebuild` gak sinkron.
- Pecah `nodes/` → `features/`+`tasks/` → detail `.md` tak terlihat, `check` salah hitung.
- Tambah field wajib node (mis. `priority`) → node lama tanpa field, silent misread.
- `memory/` + `atlas/` dua-duanya ada → dua memori jalan, data terpecah, PROTOCOL gak ke-inject (`plugin/index.js:106-112, 152`).
- Kopi kode beda versi (CLI A + MCP B) nulis schema sama → last-writer-wins, bentrok.

**Scope:**
- Ubah makna `manifest.version` → `schema_version` (package versi `VERSION` tetap terpisah — jangan digabung).
- Array migrasi idempotent di `atlas.mjs`:
  ```js
  const MIGRATIONS = [
    { from: 1, to: 2, up: async (dir, manifest) => { /* rename/reshape, idempotent */ } },
  ]
  ```
- **Choke point tunggal: `loadManifest()` (`atlas.mjs:202-208`)** — tiap command lewat situ. Begitu `schema_version < CURRENT` → jalanin semua step yang belum lewat berurutan → `saveManifest` → lanjut. Auto di init/record/query/check/get/scan/update/delete, tanpa user action.
- Deteksi legacy: `version` missing atau `1`, tapi `seed_id`/`node_count` ada → v1 → jalankan migrasi.
- Setiap step **additive + idempotent** (guard `existsSync` sebelum rename, `readdir` sebelum folderize). Jangan hapus data lama — archive/shift, bukan delete.
- `check` (`atlas.mjs:1045`): kalau schema drift → lapor `schema=X, latest=Y` + jalankan migrasi.
- `migrate` command eksplisit (opsional): dry-run + backup (pola `export` sudah ada `:1031`).
- Ini jadi **blocker M6** — folderisasi `atlas/features/` butuh migrasi data existing dulu.
- **Backup otomatis sebelum migrasi:** tiap schema bump → snapshot `atlas-backup-<ts>/` (pola `atlas-backup-2026-09-02T00-44-40-336Z/` yang udah dipakai di konsolidasi). Rollback tinggal `rm -rf atlas && mv backup atlas`.

**File kena:** `skill/scripts/atlas.mjs` (+ PROTOCOL sync §4, + plugin scaffold `plugin/index.js:116`).

**Acceptance criteria:**
- Repo dengan manifest lama (`version: 1`) → jalanin `record`/`check` → otomatis migrate ke schema terbaru, `check` OK.
- Migrasi idempotent: jalan 2x → hasil sama, gak dobel.
- Data lama gak ada yang hilang (semua node/details selamat).
- Upgrade versi package → data di repo lama nyambung tanpa langkah manual.

---

### M8 — Query performa & hemat token ✅ DONE 2026-09-05

**Tujuan:** Query gak baca semua shard, record cepat, output hemat token.

**Scope:**
- **Inverted index `words_index.json`** (kata → `[{id, shard}]`): update di `record`, dipakai `query`. Query baca cuma shard relevan, bukan O(n). Ini ngilangin hot path `allNodes` (`atlas.mjs:234-243`) yang dipanggil tiap `query` tanpa tags (`599-601`).
- **`nextId` counter di manifest**: `record` jadi O(1), bukan scan semua id (`atlas.mjs:429-438`).
- **`query --compact`**: output `ID | summary` aja (hemat token AI). Default tetap verbose.
- **`query --since N-hari`**: skip shard lama (butuh date-range per shard di manifest).
- **`rebuild`** update semua index baru.

**File kena:** `skill/scripts/atlas.mjs` + `manifest.json` (~100-150 baris).

**Acceptance criteria:**
- `query` tanpa tags gak baca semua shard (cek: log atau perf).
- `record` 1000x lebih cepat (counter ganti scan).
- `--compact` output sepertiga token dari verbose.
- `rebuild` benerin index dari shard existing.

---

### M9 — Koneksi ke kode (repo-aware) ✅ DONE 2026-09-05

**Tujuan:** Atlas nyambung ke file/fungsi/commit, bukan grafik teks abstrak.

**Scope:**
- **`scan --symbols`**: AST-lite via regex (Go `func X`, JS `function/const/export`, class) → `symbol_index.json` (simbol → node). Query bisa cari nama fungsi.
- **Field `loc` + `commit`** di node schema: `get` tampilkan `file:line` + commit hash. Backward compat (opsional, kosong di node lama).
- **File→node index** (kebalikan `loc`): cari semua node yang nyentuh file X — langsung kepake buat preflight peka (M6) + dedupe.
- **Ingest semua `docs/**/*.md`** (bukan cuma AGENTS.md): heading → feature node, tabel limit → decision node.

**File kena:** `skill/scripts/atlas.mjs` + schema node (~120-180 baris).

**Acceptance criteria:**
- `scan --symbols` di repo JS/Go → `query "namaFungsi"` balikin node yang nyentuh fungsi itu.
- Node punya `loc` → `get` tampilin path:line.
- `query file:src/x.ts` → semua node yang nyentuh file itu.
- `ingest` baca semua `docs/*.md`, bukan cuma AGENTS.md.

---

### M10 — Utilitas & otomasi pelengkap ✅ DONE 2026-09-05

**Tujuan:** Command praktis yang dipakai tiap hari.

**Scope:**
- **`cluster`**: auto-tag topik dari keyword summary → ringkas per topik (pola SUM-00X manual yang udah dipakai di konsolidasi).
- **`export --stats`**: ringkasan struktur graph (jumlah per type/status/fitur).
- **`verify`**: versi `check` yang verifikasi connector gak putus (bukan cuma orphan).
- **Session summary auto-record** (plugin): selesai sesi, ringkas kerja → 1 node reasoning (bukan "edited file"). Ini natural pairing sama M5.

**File kena:** `skill/scripts/atlas.mjs` + `plugin/index.js` (~100-140 baris).

**Acceptance criteria:**
- `cluster` bikin ringkasan per topik yang kebaca manusia.
- `export --stats` keluar tabel ringkas.
- `verify` nangkap connector putus yang `check` gak lihat.
- Selesai sesi → 1 node ringkasan otomatis.

---

## 4. Constraint & Hard Rules (WAJIB dijaga)

| Rule | Implikasi implement |
|------|---------------------|
| **CLI-first** | Semua read/write lewat `atlas.mjs`. Bulk/prune WAJIB jadi command CLI, bukan edit JSON raw. |
| **Zero deps** | Gak boleh tambah dep. Dedupe/folderisasi = stdlib string compare. |
| **PROTOCOL sync** | Perubahan CLI → update PROTOCOL di SEMUA tempat: `atlas.mjs` (bagian PROTOCOL template), `plugin/index.js` (template), `skill/SKILL.md`, `README.md`. ⚠️ Fix juga: PROTOCOL di `atlas.mjs` belum ada marker `ponytail:` (drift pre-existing). |
| **Limits** | Jangan naikkan `MAX_SUMMARY_CHARS` (140) / `MAX_MD_LINES` (200) / `MAX_NODES_PER_SHARD` (300). |
| **Seed rule** | Seed exemption derive dari data. Prune/bulk archive WAJIB guard node edge-less. |
| **check strict** | Semua operasi bulk WAJIB jaga konsistensi `id_map`/`tags_index`/`node_count` → kalau tidak, `check` FAIL. |
| **Schema gate (baru, M7)** | Semua command lewat `loadManifest()` WAJIB cek `schema_version` → auto-migrate kalau drift. Migrasi additive + idempotent, data lama gak boleh hilang. |

---

## 5. Timeline estimasi

| Milestone | Effort | Dependensi | Estimasi |
|-----------|--------|------------|----------|
| M1 Parser audit | Kecil (~40-60 baris) | — | 0.5-1 hari |
| M2 Bulk filter | Sedang (~80-120 baris) | — | 1-2 hari |
| M3 `.md` enforcement | Kecil (~30-50 baris) | — | 0.5-1 hari |
| M4 Prune | Sedang (~60-90 baris) | M2 (reuse filter) | 1 hari |
| M5 Semantic record | Sedang (~40-60 baris, plugin) | — | 1-2 hari |
| M6 Atlas aktif | Besar (200+ baris, 3 file) | M1-M5 stabil | 3-5 hari |
| M7 Auto-migrasi data | Sedang (~80-120 baris) | — (bisa lebih awal) | 1-2 hari |
| M8 Query performa | Sedang (~100-150 baris) | — | 2-3 hari |
| M9 Koneksi ke kode | Sedang-besar (~120-180 baris) | M7 (schema field loc) | 2-3 hari |
| M10 Utilitas | Sedang (~100-140 baris) | — | 1-2 hari |

**Fase:** Fase 1 = M1+M2 (P0). Fase 2 = M3+M4+M7+M10 (P1). Fase 3 = M5+M6 (P2). Fase 4 = M8+M9 (P3, performa + repo-aware).
**Catatan:** M7 gak tergantung milestone lain & jadi **prasyarat M6** — bisa dikerjakan duluan pas ada perubahan schema apa pun.

---

## 6. Verify sebelum commit (tiap milestone)

```bash
node --check skill/scripts/atlas.mjs
node --check plugin/index.js

# smoke (temp dir, pola AGENTS.md)
cd /tmp && rm -rf atv && mkdir atv && A=<repo>/skill/scripts/atlas.mjs
node $A init atv
node $A record --id REQ-001 --type requirement --status active --tags core --summary "seed req" atv
node $A record --type feature --status active --tags seo --summary "hreflang" --conn "REQ-001:satisfies" atv
node $A check atv
node $A query "hreflang" atv
```

Plus smoke spesifik per milestone:
- **M1:** `record --tags a,b --status done`, `record --summary "--flag-ish"`, `record --status bogus` (harus error jelas).
- **M2:** filter `type=task&status=done&tags=auto` dengan `--dry-run`, lalu archive, `check` OK.
- **M3:** `edit <ID>`, buat md >200 baris, `check` harus nangkap.
- **M4:** prune 2x → idempotent, seed selamat, `check` OK.
- **M5:** 5 edit file sama 1 menit → 1 node; whitespace edit → 0 node.
- **M6:** sesi baru auto-dapat konteks; edit path ber-BUG → warn dulu.
- **M7:** buat repo temp dengan manifest `version:1` → jalanin `check`/`record` → auto-migrate, `check` OK; jalankan 2x → idempotent; semua node selamat.
- **M8:** `query` tanpa tags gak baca semua shard; `record` 1000x (counter); `--compact` hemat token; `rebuild` sinkron index.
- **M9:** `scan --symbols` → `query "namaFungsi"` ketemu; node dengan `loc` tampil path:line; `query file:...` balikin node nyentuh file itu.
- **M10:** `cluster` bikin ringkasan topik; `export --stats` tabel ringkas; `verify` nangkap connector putus; sesi → 1 node ringkasan.

---

## 7. Rollback

Tiap milestone commit terpisah + semantic (Conventional Commits, subject ≤50 chars).
Gak ada migrasi data destruktif (archive ≠ hapus; data tetap di index, cuma status beda).

---

## 8. Out of scope (deferred)

- Embedding search lokal (all-MiniLM-L6-v2 ONNX) — paham konsep, bukan cuma keyword. Sangat tinggi impact, tinggi effort. Evaluasi setelah graph bermakna + M8 inverted index kepake.
- Changelog generator — dari node history → release notes per fitur.
- Git-friendly export/import — pindah repo, atlas ikut di clone (butuh desain biar gak double).
- Effort stats per fitur — dari node count + timestamps (fitur mana paling sering berubah).