import { Collection, Node } from './Collection'
import { query } from './query'
import { fitTextBlocksToLimit } from './text'

const DEFAULT_TOP_K = 5
const DEFAULT_MAX_CONTEXT_CHARS = 2000

export async function generateAnswer(
  collection: Collection,
  question: string,
  topK: number = DEFAULT_TOP_K,
  maxContextChars: number = DEFAULT_MAX_CONTEXT_CHARS
): Promise<string> {
  const chunks = await query(collection, question, topK)
  const context = buildContext(collection, chunks, maxContextChars)

  return [
    'You are an assistant with access to company knowledge.',
    'Use the following context to answer the question:',
    '',
    'CONTEXT:',
    context,
    '',
    'QUESTION:',
    question,
    '',
    'Answer:'
  ].join('\n')
}

function buildContext(collection: Collection, chunks: Node[], maxChars: number): string {
  if (maxChars <= 0 || chunks.length === 0) {
    return ''
  }

  const blocks = chunks.map((chunk) => formatChunkBlock(collection, chunk))
  return fitTextBlocksToLimit(blocks, maxChars)
}

function formatChunkBlock(collection: Collection, chunk: Node): string {
  const sectionTitle = getSectionTitle(collection, chunk)
  const heading = sectionTitle ? `## ${sectionTitle}` : '## Section'
  return `${heading}\n${chunk.text}`
}

function getSectionTitle(collection: Collection, chunk: Node): string {
  if (!chunk.parent) {
    return ''
  }

  const sectionNode = collection.getNode(chunk.parent)
  if (!sectionNode) {
    return ''
  }

  return sectionNode.text.trim()
}
