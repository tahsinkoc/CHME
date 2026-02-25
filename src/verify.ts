import assert from 'node:assert/strict'
import path from 'node:path'
import { Collection, Node } from './Collection'
import { ingest, tokenizeChunk, chunkSection, parseMarkdownToSections } from './ingest'
import { query } from './query'
import { generateAnswer } from './generateAnswer'
import { callLLM } from './callLLM'
import { MemoryEngine } from './MemoryEngine'

async function run(): Promise<void> {
  await runUnitTests()
  await runIntegrationTests()
  console.log('All tests passed')
}

async function runUnitTests(): Promise<void> {
  const tokens = tokenizeChunk('Hello, hello! This is A test.')
  assert.deepEqual(tokens.sort(), ['hello', 'test'])

  const longText = buildLongText(2200)
  const chunks = chunkSection({ id: 'doc:section:0', text: longText })
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 800)
  }
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1].text
    const curr = chunks[i].text
    const overlap = prev.slice(-100)
    assert.equal(curr.slice(0, 100), overlap)
  }

  const structured = parseMarkdownToSections('# A\ntext\n## B\nchild text')
  assert.equal(structured.length, 1)
  assert.equal(structured[0].title, 'A')
  assert.equal(structured[0].children.length, 1)
  assert.equal(structured[0].children[0].title, 'B')

  const plain = parseMarkdownToSections('plain text only')
  assert.equal(plain.length, 1)
  assert.equal(plain[0].title, '')
  assert.equal(plain[0].text, 'plain text only')

  const retrievalCollection = buildQueryFixtureCollection()
  const ranked = await query(retrievalCollection, 'alpha', 2)
  assert.equal(ranked.length, 2)
  assert.ok(ranked[0].parent)
  assert.ok(ranked[1].parent)
  assert.notEqual(ranked[0].parent, ranked[1].parent)

  const emptyQ1 = await query(retrievalCollection, '', 3)
  const emptyQ2 = await query(retrievalCollection, '', 3)
  assert.deepEqual(emptyQ1.map((n) => n.id), emptyQ2.map((n) => n.id))

  const prompt1 = await generateAnswer(retrievalCollection, 'alpha', 2, 160)
  const prompt2 = await generateAnswer(retrievalCollection, 'alpha', 2, 160)
  assert.equal(prompt1, prompt2)
  assert.ok(prompt1.includes('## Section A'))
}

async function runIntegrationTests(): Promise<void> {
  const testDir = path.resolve(process.cwd(), 'test')

  const collection = new Collection('integration')
  await ingest(testDir, collection)

  const rootCount = Array.from(collection.getAllNodes().values()).filter((node) => node.depth === 0).length
  assert.ok(rootCount >= 5)

  const localResult = await withEnv(
    {
      LLM_PROVIDER: 'local',
      LOCAL_LLM_URL: 'http://127.0.0.1:1/api/generate'
    },
    async () => callLLM('hello')
  )
  assert.equal(localResult, '')

  const openaiResult = await withEnv(
    {
      LLM_PROVIDER: 'openai',
      OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
      OPENAI_API_KEY: undefined
    },
    async () => callLLM('hello', 'gpt-3.5-turbo', 0, 32)
  )
  assert.equal(openaiResult, '')

  const engine = new MemoryEngine({ temperature: 0 })
  engine.createCollection('testCollection')
  await engine.ingest('testCollection', testDir)

  const answer = await withEnv(
    {
      LLM_PROVIDER: 'local',
      LOCAL_LLM_URL: 'http://127.0.0.1:1/api/generate'
    },
    async () => engine.ask('testCollection', 'What is the main topic of the files?')
  )
  assert.equal(typeof answer, 'string')
}

function buildQueryFixtureCollection(): Collection {
  const collection = new Collection('q')
  const docId = 'doc'

  collection.addDocument(docId, 'doc.md')

  const root: Node = { id: `${docId}:root`, text: 'doc.md', children: [], depth: 0, docId, tokens: [] }
  const sectionA: Node = { id: `${docId}:section:0`, text: 'Section A', parent: root.id, children: [], depth: 1, docId, tokens: [] }
  const sectionB: Node = { id: `${docId}:section:1`, text: 'Section B', parent: root.id, children: [], depth: 1, docId, tokens: [] }

  const chunkA0: Node = {
    id: `${docId}:0:0`,
    text: 'alpha beta document one',
    parent: sectionA.id,
    children: [],
    depth: 2,
    docId,
    tokens: ['alpha', 'beta', 'document', 'one']
  }
  const chunkA1: Node = {
    id: `${docId}:0:1`,
    text: 'alpha second chunk',
    parent: sectionA.id,
    children: [],
    depth: 2,
    docId,
    tokens: ['alpha', 'second', 'chunk']
  }
  const chunkB0: Node = {
    id: `${docId}:1:0`,
    text: 'alpha gamma section two',
    parent: sectionB.id,
    children: [],
    depth: 2,
    docId,
    tokens: ['alpha', 'gamma', 'section', 'two']
  }

  collection.addNode(root)
  collection.addNode(sectionA)
  collection.addNode(sectionB)
  collection.addNode(chunkA0)
  collection.addNode(chunkA1)
  collection.addNode(chunkB0)

  for (const token of chunkA0.tokens) collection.addToKeywordIndex(token, chunkA0.id)
  for (const token of chunkA1.tokens) collection.addToKeywordIndex(token, chunkA1.id)
  for (const token of chunkB0.tokens) collection.addToKeywordIndex(token, chunkB0.id)

  return collection
}

function buildLongText(targetLength: number): string {
  const phrase = 'lorem ipsum dolor sit amet consectetur adipiscing elit '
  let text = ''
  while (text.length < targetLength) {
    text += phrase
  }
  return text.slice(0, targetLength)
}

async function withEnv<T>(
  changes: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(changes)) {
    previous[key] = process.env[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
