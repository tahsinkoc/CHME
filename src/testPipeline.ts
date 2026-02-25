import path from 'node:path'
import { access } from 'node:fs/promises'
import { MemoryEngine } from './MemoryEngine'

async function main(): Promise<void> {
  const engine = new MemoryEngine()
  const collectionId = 'testCollection'
  const testDir = path.resolve(process.cwd(), 'test')
  const question = process.argv.slice(2).join(' ').trim() || 'What is the main topic of the files?'

  await access(testDir)

  const report = await engine.ingestAuto(testDir, { defaultCollectionId: collectionId })
  if (report.files < 1) {
    throw new Error('No markdown files found in test directory')
  }

  const answer = await engine.ask(question, { topCollections: 3, topKPerCollection: 3, maxContextChars: 2000 })
  console.log(answer)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
