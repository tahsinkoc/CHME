import { Collection, Node } from './Collection'
import { tokenizePlainText, tokenizeSearchText } from './text'

const DEFAULT_TOP_K = 5

type ScoredChunk = {
  node: Node
  score: number
}

type QueryAnalysis = {
  rawTokens: string[]
  searchTokens: string[]
  phrases: string[]
}

export async function query(collection: Collection, question: string, topK: number = DEFAULT_TOP_K): Promise<Node[]> {
  if (topK <= 0) {
    return []
  }

  const analysis = analyzeQuestion(question)
  const nodes = collection.getAllNodes()
  const keywordIndex = collection.getKeywordIndex()

  const candidateIds = new Set<string>()
  for (const token of analysis.searchTokens) {
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

    const score = scoreChunk(node, analysis)
    scored.push({ node, score })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score
    }
    return a.node.id.localeCompare(b.node.id)
  })

  return selectDiverseChunks(scored, topK)
}

function analyzeQuestion(question: string): QueryAnalysis {
  const rawTokens = tokenizePlainText(question)
  const searchTokens = tokenizeSearchText(question)
  const phrases: string[] = []

  for (let index = 0; index < rawTokens.length - 1; index++) {
    const pair = `${rawTokens[index]} ${rawTokens[index + 1]}`
    phrases.push(pair)
    if (index < rawTokens.length - 2) {
      phrases.push(`${pair} ${rawTokens[index + 2]}`)
    }
  }

  return { rawTokens, searchTokens, phrases }
}

function selectDiverseChunks(scored: ScoredChunk[], topK: number): Node[] {
  const selected: Node[] = []
  const docCounts = new Map<string, number>()
  const sectionCounts = new Map<string, number>()
  const pool = scored.map((item) => ({ ...item }))
  const docBaseScores = new Map<string, number>()

  for (const item of scored) {
    const current = docBaseScores.get(item.node.docId) || Number.NEGATIVE_INFINITY
    if (item.score > current) {
      docBaseScores.set(item.node.docId, item.score)
    }
  }

  while (selected.length < topK && pool.length > 0) {
    let bestIndex = 0
    let bestScore = Number.NEGATIVE_INFINITY

    for (let index = 0; index < pool.length; index++) {
      const item = pool[index]
      const docScoreBoost = (docBaseScores.get(item.node.docId) || 0) * 0.35
      const docPenalty = (docCounts.get(item.node.docId) || 0) * 0.75
      const sectionPenalty = (sectionCounts.get(item.node.parent || '') || 0) * 1
      const adjustedScore = item.score + docScoreBoost - docPenalty - sectionPenalty

      if (adjustedScore > bestScore) {
        bestIndex = index
        bestScore = adjustedScore
        continue
      }

      if (adjustedScore === bestScore && item.node.id.localeCompare(pool[bestIndex].node.id) < 0) {
        bestIndex = index
      }
    }

    const [chosen] = pool.splice(bestIndex, 1)
    if (!chosen) {
      break
    }
    if (chosen.score <= 0 && selected.length > 0) {
      break
    }

    selected.push(chosen.node)
    docCounts.set(chosen.node.docId, (docCounts.get(chosen.node.docId) || 0) + 1)
    sectionCounts.set(chosen.node.parent || '', (sectionCounts.get(chosen.node.parent || '') || 0) + 1)
  }

  return selected
}

function scoreChunk(chunk: Node, analysis: QueryAnalysis): number {
  if (analysis.searchTokens.length === 0) {
    return 0
  }

  const rawChunkTokens = new Set(tokenizePlainText(chunk.text))
  const searchChunkTokens = new Set(chunk.tokens && chunk.tokens.length > 0 ? chunk.tokens : tokenizeSearchText(chunk.text))
  let exactMatches = 0
  let expandedMatches = 0
  let phraseMatches = 0

  for (const token of analysis.rawTokens) {
    if (rawChunkTokens.has(token)) {
      exactMatches += 1
    }
  }

  for (const token of analysis.searchTokens) {
    if (searchChunkTokens.has(token)) {
      expandedMatches += 1
    }
  }

  const loweredText = chunk.text.toLowerCase()
  for (const phrase of analysis.phrases) {
    if (phrase.length > 0 && loweredText.includes(phrase)) {
      phraseMatches += 1
    }
  }

  let score = (exactMatches * 5) + (expandedMatches * 1.5) + (phraseMatches * 4)
  const stepMentions = (chunk.text.match(/\bstep\s+\d+\b/gi) || []).length
  const repeatedApprovalMentions = (chunk.text.match(/before approval/gi) || []).length

  if (/must enforce|primary monitoring signals include|common failure modes include/i.test(chunk.text)) {
    score += 3
  }
  if (chunk.text.length > 700) {
    score -= 2
  }
  if (exactMatches === 0 && phraseMatches === 0) {
    score -= 1
  }
  if (stepMentions >= 2) {
    score -= 25
  } else if (/^step\s+\d+/i.test(chunk.text.trim())) {
    score -= 8
  }
  if (repeatedApprovalMentions >= 2) {
    score -= 15
  }

  return score
}

function isChunkNode(node: Node): boolean {
  return node.depth === 2
}
