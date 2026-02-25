import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Collection, Node as MemoryNode } from './Collection'

const MAX_CHUNK_CHARS = 800
const CHUNK_OVERLAP_CHARS = 100

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were', 'will', 'with', 'this', 'these', 'those', 'or', 'if', 'then', 'than', 'but', 'not', 'no', 'yes', 'you', 'your', 'we', 'our', 'they', 'their', 'i', 'me', 'my', 'mine', 'them', 'his', 'her', 'hers', 'who', 'whom', 'what', 'which', 'when', 'where', 'why', 'how', 'into', 'out', 'up', 'down', 'over', 'under', 'again', 'further', 'once'
])

type ParsedSection = {
  title: string
  text: string
}

export type Section = {
  id: string
  title: string
  text: string
  depth: number
  parent?: string
  children: Section[]
}

export type Chunk = {
  id: string
  parent: string
  text: string
}

function createDocId(rootPath: string, filePath: string): string {
  const relative = path.relative(rootPath, filePath)
  const normalized = relative.replace(/\\/g, '/')
  const withoutExt = normalized.replace(/\.md$/i, '')
  const compact = withoutExt.replace(/[^a-zA-Z0-9/_-]/g, '_')
  return compact.replace(/\//g, '__') || 'doc'
}

export async function ingest(targetPath: string, collection: Collection): Promise<void> {
  const absoluteRoot = path.resolve(targetPath)
  const files = await collectMarkdownFiles(absoluteRoot)
  files.sort((a, b) => a.localeCompare(b))

  for (const filePath of files) {
    const docId = createDocId(absoluteRoot, filePath)
    const content = await readFile(filePath, 'utf8')
    const sections = flattenSections(parseMarkdownToSections(content))

    collection.addDocument(docId, filePath)

    const rootNode: MemoryNode = {
      id: `${docId}:root`,
      text: path.basename(filePath),
      children: [],
      depth: 0,
      docId,
      tokens: []
    }
    collection.addNode(rootNode)

    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
      const section = sections[sectionIndex]
      const sectionId = `${docId}:section:${sectionIndex}`
      const sectionNode: MemoryNode = {
        id: sectionId,
        text: section.title,
        parent: rootNode.id,
        children: [],
        depth: 1,
        docId,
        tokens: []
      }
      collection.addNode(sectionNode)

      const chunks = chunkSection({ id: sectionId, text: section.text })
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunkTextValue = chunks[chunkIndex].text
        const chunkId = `${docId}:${sectionIndex}:${chunkIndex}`
        const tokens = tokenizeChunk(chunkTextValue)

        const chunkNode: MemoryNode = {
          id: chunkId,
          text: chunkTextValue,
          parent: sectionId,
          children: [],
          depth: 2,
          docId,
          tokens
        }

        collection.addNode(chunkNode)
        for (const token of tokens) {
          collection.addToKeywordIndex(token, chunkId)
        }
      }
    }
  }
}

async function collectMarkdownFiles(rootPath: string): Promise<string[]> {
  const results: string[] = []
  await walk(rootPath, results)
  return results
}

async function walk(currentPath: string, results: string[]): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name)
    if (entry.isDirectory()) {
      await walk(fullPath, results)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      results.push(fullPath)
    }
  }
}

export function parseMarkdownToSections(fileContent: string): Section[] {
  const lines = fileContent.split(/\r?\n/)
  const sections: Section[] = []
  const stack: Section[] = []
  const preambleLines: string[] = []
  let sectionCounter = 0

  const createSection = (title: string, depth: number): Section => {
    const section: Section = {
      id: `section:${sectionCounter++}`,
      title,
      text: '',
      depth,
      children: []
    }
    return section
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/)
    if (!headingMatch) {
      if (stack.length > 0) {
        const current = stack[stack.length - 1]
        current.text = current.text.length > 0 ? `${current.text}\n${line}` : line
      } else {
        preambleLines.push(line)
      }
      continue
    }

    if (stack.length === 0 && sections.length === 0 && preambleLines.join('').trim().length > 0) {
      const preamble = createSection('', 1)
      preamble.text = preambleLines.join('\n')
      sections.push(preamble)
    }

    const depth = headingMatch[1].length
    const title = headingMatch[2].trim()
    const nextSection = createSection(title, depth)

    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop()
    }

    if (stack.length === 0) {
      sections.push(nextSection)
    } else {
      const parent = stack[stack.length - 1]
      nextSection.parent = parent.id
      parent.children.push(nextSection)
    }
    stack.push(nextSection)
  }

  if (sections.length === 0) {
    return [{
      id: 'section:0',
      title: '',
      text: fileContent,
      depth: 1,
      children: []
    }]
  }

  return sections
}

export function chunkSection(section: Pick<Section, 'id' | 'text'>): Chunk[] {
  const text = section.text || ''
  if (text.length === 0) {
    return [{ id: `${section.id}:0`, parent: section.id, text: '' }]
  }

  const sectionIndex = extractSectionIndex(section.id)
  const chunks: Chunk[] = []
  let start = 0
  let chunkIndex = 0

  while (start < text.length) {
    const end = findChunkEnd(text, start, MAX_CHUNK_CHARS)
    const piece = text.slice(start, end)

    chunks.push({
      id: `${sectionIndex}:${chunkIndex}`,
      parent: section.id,
      text: piece
    })

    chunkIndex += 1
    if (end >= text.length) {
      break
    }
    start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1)
  }

  return chunks
}

function findChunkEnd(text: string, start: number, maxChars: number): number {
  const limit = Math.min(start + maxChars, text.length)
  if (limit >= text.length) {
    return text.length
  }

  const sentenceWindowStart = Math.max(start + 1, limit - 200)
  for (let i = limit; i >= sentenceWindowStart; i--) {
    const ch = text[i]
    if (ch === '.' || ch === '!' || ch === '?' || ch === '\n') {
      return i < limit ? i + 1 : limit
    }
  }

  for (let i = limit; i > start; i--) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      return i
    }
  }

  return limit
}

export function tokenizeChunk(chunkText: string): string[] {
  const cleaned = chunkText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')

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

function extractSectionIndex(sectionId: string): number {
  const match = sectionId.match(/section:(\d+)$/)
  return match ? Number(match[1]) : 0
}

function flattenSections(sections: Section[]): ParsedSection[] {
  const flat: ParsedSection[] = []

  const visit = (section: Section): void => {
    flat.push({ title: section.title || 'Untitled', text: section.text })
    for (const child of section.children) {
      visit(child)
    }
  }

  for (const section of sections) {
    visit(section)
  }

  if (flat.length === 0) {
    flat.push({ title: 'Document', text: '' })
  }

  return flat
}
