# Product Notes

The product stores markdown files and builds a searchable internal tree.
Each document has a root node. Section nodes and chunk nodes are nested under it.

## Ingest Pipeline

Ingest parses headings (#, ##, ###), builds section hierarchy, then chunks long text.
Chunk size is limited to 800 characters with 100-character overlap.

## Token Indexing

Only chunk nodes are indexed in the keyword map.
This keeps index entries focused on retrievable context blocks.
