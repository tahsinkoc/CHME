import { Collection, Node } from './Collection'

const DEFAULT_TOP_K = 5

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were', 'will', 'with',
  'this', 'these', 'those', 'or', 'if', 'then', 'than', 'but', 'not', 'no', 'yes', 'you', 'your', 'we', 'our', 'they', 'their', 'i', 'me', 'my', 'mine', 'them',
  'his', 'her', 'hers', 'who', 'whom', 'what', 'which', 'when', 'where', 'why', 'how', 'into', 'out', 'up', 'down', 'over', 'under', 'again', 'further', 'once'
])

type ScoredChunk = {
  node: Node
  score: number
}

export async function query(collection: Collection, question: string, topK: number = DEFAULT_TOP_K): Promise<Node[]> {
  if (topK <= 0) {
    return []
  }

  const queryTokens = tokenize(question)
  const nodes = collection.getAllNodes()
  const keywordIndex = collection.getKeywordIndex()

  const candidateIds = new Set<string>()
  for (const token of queryTokens) {
    const ids = keywordIndex.get(token)
    if (!ids) {
      continue
    }
    for (const id of ids) {
      candidateIds.add(id)
    }
  }

  if (candidateIds.size === 0) {
    for (const [id, node] of nodes) {
      if (isChunkNode(node)) {
        candidateIds.add(id)
      }
    }
  }

  const scored: ScoredChunk[] = []
  for (const id of candidateIds) {
    const node = nodes.get(id)
    if (!node || !isChunkNode(node)) {
      continue
    }

    const score = scoreChunk(node, queryTokens)
    scored.push({ node, score })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score
    }
    return a.node.id.localeCompare(b.node.id)
  })

  const grouped = new Map<string, Node[]>()
  for (const item of scored) {
    const sectionId = item.node.parent || ''
    const list = grouped.get(sectionId)
    if (list) {
      list.push(item.node)
    } else {
      grouped.set(sectionId, [item.node])
    }
  }

  const result: Node[] = []
  while (result.length < topK) {
    let added = false

    for (const list of grouped.values()) {
      if (list.length === 0) {
        continue
      }

      result.push(list.shift() as Node)
      added = true

      if (result.length >= topK) {
        break
      }
    }

    if (!added) {
      break
    }
  }

  return result
}

function scoreChunk(chunk: Node, queryTokens: string[]): number {
  if (queryTokens.length === 0) {
    return 0
  }

  const chunkTokens = new Set(chunk.tokens && chunk.tokens.length > 0 ? chunk.tokens : tokenize(chunk.text))
  let overlap = 0

  for (const token of queryTokens) {
    if (chunkTokens.has(token)) {
      overlap += 1
    }
  }

  return overlap
}

function tokenize(input: string): string[] {
  const cleaned = input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
  const parts = cleaned.split(/\s+/)
  const unique = new Set<string>()

  for (const part of parts) {
    if (!part) {
      continue
    }
    if (STOPWORDS.has(part)) {
      continue
    }
    unique.add(part)
  }

  return Array.from(unique)
}

function isChunkNode(node: Node): boolean {
  return node.depth === 2
}
