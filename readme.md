# Compact Hierarchical Memory Engine (CHME)

CHME is a compact, in-memory, TypeScript memory orchestration engine.

Core flow:

1. `ingest` / `ingestAuto` -> Markdown to document/section/chunk tree
2. keyword index build (chunk-level)
3. scoped or global `ask`
4. optional snapshot save/load for fast restart

## Key capabilities

1. Multi-collection memory (`MemoryEngine` single entrypoint)
2. Deterministic path-based auto routing + routing rules
3. Keyword retrieval with section-aware selection
4. Local-first LLM support (Ollama) + OpenAI-compatible mode
5. Snapshot persistence (`.chme.json.gz`) with freshness reingest (`mtime + size`)

## Install

```bash
npm install
```

## Main scripts

```bash
npm run verify
npm run pipeline
npm run test:ollama:dry
npm run test:ollama
```

## Quick usage

```ts
import { MemoryEngine } from './src/MemoryEngine'

async function main() {
  const engine = new MemoryEngine({
    provider: 'local',
    model: 'qwen2.5:7b',
    snapshotDir: './snapshots'
  })

  await engine.ingestAuto('./test', { defaultCollectionId: 'general' })
  await engine.saveSnapshots()

  const answer = await engine.ask('What is the main topic of the files?')
  console.log(answer)
}
```

## Snapshot path selection

Path resolution for snapshots:

1. method parameter (`saveSnapshots(path)` / `loadSnapshots(path)`)
2. engine default (`snapshotDir` option or `setSnapshotDir`)
3. fallback `./snapshots`

```ts
engine.setSnapshotDir('./my-snapshots')
await engine.saveSnapshots()
await engine.loadSnapshots(undefined, { sourceRootPath: './test' })
```

## Docs

1. Turkish complete guide: `usage.md`
2. English complete guide: `eng_usage.md`
