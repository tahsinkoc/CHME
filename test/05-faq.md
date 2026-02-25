# FAQ

## What does MemoryEngine do?

It orchestrates collection management, ingestion, retrieval, prompt construction, and LLM calls.

## How is context built?

Top chunks are selected from query ranking and grouped by section context.
Context is bounded by a configurable character limit.

## Is this deterministic?

Retrieval and prompt building are deterministic.
Final generation is deterministic when temperature is set to zero.
