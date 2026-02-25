export type Node = {
  id: string
  text: string
  parent?: string
  children: string[]
  depth: number
  docId: string
  tokens: string[]
  embedding?: number[]
}

export class Collection {
  private id: string
  private documents: Map<string, { id: string; path: string }>
  private nodes: Map<string, Node>
  private keywordIndex: Map<string, Set<string>>

  constructor(id: string) {
    this.id = id
    this.documents = new Map()
    this.nodes = new Map()
    this.keywordIndex = new Map()
  }

  getId(): string {
    return this.id
  }

  addDocument(docId: string, path: string): void {
    this.documents.set(docId, { id: docId, path })
  }

  getDocument(docId: string) {
    return this.documents.get(docId)
  }

  addNode(node: Node): void {
    if (node.parent) {
      const parent = this.nodes.get(node.parent)
      if (!parent) {
        throw new Error(`Parent node not found: ${node.parent}`)
      }
      if (!parent.children.includes(node.id)) {
        parent.children.push(node.id)
      }
    }

    this.nodes.set(node.id, node)
  }

  getNode(nodeId: string): Node | undefined {
    return this.nodes.get(nodeId)
  }

  getAllNodes(): Map<string, Node> {
    return this.nodes
  }

  addToKeywordIndex(token: string, nodeId: string): void {
    let nodeSet = this.keywordIndex.get(token)
    if (!nodeSet) {
      nodeSet = new Set<string>()
      this.keywordIndex.set(token, nodeSet)
    }
    nodeSet.add(nodeId)
  }

  getKeywordIndex(): Map<string, Set<string>> {
    return this.keywordIndex
  }
}