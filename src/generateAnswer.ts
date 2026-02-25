import { Collection, Node } from './Collection'
import { query } from './query'

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
  const selected: string[] = []
  let used = 0

  for (const block of blocks) {
    const separator = selected.length === 0 ? 0 : 2
    const nextSize = used + separator + block.length
    if (nextSize <= maxChars) {
      if (separator > 0) {
        used += separator
      }
      selected.push(block)
      used += block.length
      continue
    }

    if (selected.length === 0) {
      const truncated = truncateBlockBySentence(block, maxChars)
      if (truncated.length > 0) {
        selected.push(truncated)
      }
    }
    break
  }

  return selected.join('\n\n')
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

function truncateBlockBySentence(block: string, maxChars: number): string {
  if (block.length <= maxChars) {
    return block
  }

  const clipped = block.slice(0, maxChars)
  const sentenceBreak = findLastSentenceBreak(clipped)
  if (sentenceBreak > 0) {
    return clipped.slice(0, sentenceBreak).trimEnd()
  }

  const newlineBreak = clipped.lastIndexOf('\n')
  if (newlineBreak > 0) {
    return clipped.slice(0, newlineBreak).trimEnd()
  }

  const wordBreak = clipped.lastIndexOf(' ')
  if (wordBreak > 0) {
    return clipped.slice(0, wordBreak).trimEnd()
  }

  return clipped.trimEnd()
}

function findLastSentenceBreak(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '.' || ch === '!' || ch === '?') {
      return i + 1
    }
  }
  return -1
}
