import path from 'node:path'
import { access } from 'node:fs/promises'
import { MemoryEngine } from './MemoryEngine'

async function main(): Promise<void> {
  const engine = new MemoryEngine()
  const collectionId = 'testCollection'
  const testDir = path.resolve(process.cwd(), 'test')
  const question = process.argv.slice(2).join(' ').trim() || 'What is the main topic of the files?'

  await access(testDir)

  engine.createCollection(collectionId)
  await engine.ingest(collectionId, testDir)

  const answer = await engine.ask(collectionId, question)
  console.log(answer)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
