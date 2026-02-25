import assert from 'node:assert/strict'
import path from 'node:path'
import { Collection } from '../src/Collection'
import { ingest } from '../src/ingest'
import { query } from '../src/query'

async function main(): Promise<void> {
  const testDir = path.resolve(process.cwd(), 'test')
  const collection = new Collection('memoryToolTestCollection')

  await ingest(testDir, collection)

  const nodes = collection.getAllNodes()
  const all = Array.from(nodes.values())

  const roots = all.filter((n) => n.depth === 0)
  const sections = all.filter((n) => n.depth === 1)
  const chunks = all.filter((n) => n.depth === 2)

  assert.ok(roots.length >= 5, 'En az 5 document root bekleniyor')
  assert.ok(sections.length > 0, 'Section node bulunamadý')
  assert.ok(chunks.length > 0, 'Chunk node bulunamadý')

  for (const root of roots) {
    assert.ok(root.children.length > 0, `Root section içermiyor: ${root.id}`)

    for (const sectionId of root.children) {
      const section = nodes.get(sectionId)
      assert.ok(section, `Section bulunamadý: ${sectionId}`)
      assert.equal(section?.parent, root.id)

      if (!section) {
        continue
      }

      for (const chunkId of section.children) {
        const chunk = nodes.get(chunkId)
        assert.ok(chunk, `Chunk bulunamadý: ${chunkId}`)
        assert.equal(chunk?.parent, section.id)
        assert.equal(chunk?.depth, 2)
      }
    }
  }

  const keywordSize = collection.getKeywordIndex().size
  assert.ok(keywordSize > 0, 'Keyword index boþ olmamalý')

  const results = await query(collection, 'memory engine topic', 5)

  console.log('Ingest tamamlandý')
  console.log(`Documents: ${roots.length}`)
  console.log(`Sections: ${sections.length}`)
  console.log(`Chunks: ${chunks.length}`)
  console.log(`Keyword terms: ${keywordSize}`)
  console.log('--- Tree Snapshot ---')

  const sortedRoots = [...roots].sort((a, b) => a.id.localeCompare(b.id))
  for (const root of sortedRoots) {
    console.log(root.id)
    const sectionIds = [...root.children].sort((a, b) => a.localeCompare(b))
    for (const sectionId of sectionIds) {
      const section = nodes.get(sectionId)
      if (!section) {
        continue
      }
      console.log(`  ${section.id} (${section.children.length} chunks)`) 
    }
  }

  console.log('--- Query Results ---')
  for (const item of results) {
    console.log(`${item.id} | parent=${item.parent}`)
  }

  console.log('Memory tool test passed')
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
