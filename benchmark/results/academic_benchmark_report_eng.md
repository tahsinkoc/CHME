# CHME Benchmark Evaluation Report (Academic Style)

## Abstract
This report analyzes the benchmark output of the Compact Hierarchical Memory Engine (CHME) using a deterministic-core protocol over a FinTech SaaS corpus.  
The experiment evaluates five properties: data ingestion integrity, collection routing stability, retrieval stability, prompt construction stability, and snapshot roundtrip consistency.  
Results show strong system-level consistency (`overallPass = true`) with deterministic signatures across routing, retrieval, and prompt generation. A single cross-domain query lowered primary-route strict accuracy without affecting deterministic behavior.

## 1. Experimental Configuration
- **Run ID:** `2026-02-25T22-29-27-176Z`
- **Time window:** 2026-02-25 22:29:27 UTC to 22:41:30 UTC
- **Provider / model:** local / `qwen2.5:7b`
- **Dataset size:** 15 markdown files
- **Collections discovered:** `compliance`, `payments`, `risk`
- **Queries:** 12
- **Iterations:** 10
- **Total query executions:** \(12 \times 10 = 120\)
- **Live LLM:** enabled

## 2. Mathematical Metrics
Let \(q\) be a query, \(i\) an iteration, and \(s_{q,i}^{(c)}\) the signature of component \(c\in\{\text{route},\text{retrieve},\text{prompt}\}\).

### 2.1 Determinism Score
\[
D_c = \frac{1}{|Q|(N-1)} \sum_{q\in Q}\sum_{i=2}^{N}\mathbf{1}\!\left[s_{q,i}^{(c)} = s_{q,1}^{(c)}\right]
\]
where \(N\) is iteration count and \(\mathbf{1}[\cdot]\) is the indicator function.

### 2.2 Primary Route Accuracy
\[
A_{\text{primary}} = \frac{\#\{\text{queries with first routed collection = expected collection}\}}{|Q|}
\]

### 2.3 Snapshot Roundtrip Consistency
\[
R = \mathbf{1}\!\left[\text{stats}_{\text{loaded}} = \text{stats}_{\text{source}}\right]
\]

### 2.4 Latency Statistics
For latency samples \(t_1,\dots,t_n\):
\[
\mu = \frac{1}{n}\sum_{k=1}^{n} t_k,\quad
P50 = \text{median}(t),\quad
P95 = \text{95th percentile}(t)
\]

## 3. Data Integrity and Index Construction
Per-collection structural statistics:

| Collection | Documents | Sections | Chunks | Nodes | Keyword Terms |
|---|---:|---:|---:|---:|---:|
| compliance | 5 | 30 | 50 | 85 | 206 |
| payments | 5 | 30 | 50 | 85 | 215 |
| risk | 5 | 30 | 50 | 85 | 201 |

Interpretation: each collection has non-empty document/chunk/index state, indicating healthy ingest + chunk + keyword-index pipelines.

## 4. Determinism and Snapshot Results
- **Route determinism:** `true` \(\Rightarrow D_{\text{route}} = 1.00\)
- **Retrieve determinism:** `true` \(\Rightarrow D_{\text{retrieve}} = 1.00\)
- **Prompt determinism:** `true` \(\Rightarrow D_{\text{prompt}} = 1.00\)
- **Snapshot roundtrip:** `pass = true`, mismatches = 0 \(\Rightarrow R = 1\)

Primary route strict accuracy:
- Matches: 11 / 12
- \[
  A_{\text{primary}} = \frac{11}{12} = 0.9167 \approx 91.67\%
  \]

Single mismatch:
- Query ID: `payments_chargeback_limit_signals`
- Expected primary: `payments`
- Observed primary: `compliance`
- This query is explicitly cross-domain (`crossCollection = true`), so overlap-driven keyword routing can favor compliance terms.

## 5. Latency Analysis
Global latency over 120 executions:

| Stage | Mean (ms) | P50 (ms) | P95 (ms) | Min (ms) | Max (ms) |
|---|---:|---:|---:|---:|---:|
| route | 0.05 | 0.04 | 0.08 | 0.03 | 0.21 |
| retrieve | 0.09 | 0.09 | 0.15 | 0.03 | 0.40 |
| prompt | 0.07 | 0.06 | 0.15 | 0.02 | 0.28 |
| ask (LLM) | 6024.56 | 5674.27 | 10511.43 | 1467.93 | 14315.63 |

Interpretation:
- Memory pipeline stages are sub-millisecond to low-millisecond.
- End-to-end latency is dominated by external model inference (`ask`), not memory operations.

## 6. Does the Memory Tool Work?
### 6.1 What is empirically validated
1. Deterministic behavior for route/retrieve/prompt across repeated runs.
2. Correct snapshot persistence and load consistency.
3. Stable multi-collection ingest and index construction.
4. Fast in-memory retrieval pipeline relative to LLM inference time.

### 6.2 What is **not** directly validated by this benchmark
1. Semantic/factual correctness of final natural-language answers.
2. Ground-truth relevance quality (e.g., nDCG, Recall@K) against manually labeled evidence.

Therefore, the benchmark confirms that CHME is operationally stable and deterministic as a memory tool.  
For strict correctness claims, a labeled relevance/factuality evaluation layer should be added.

## 7. Conclusion
The observed benchmark supports CHME as a reliable memory substrate for RAG-style systems:
- deterministic retrieval mechanics,
- robust snapshot persistence,
- high-speed memory-side operations,
- and predictable behavior under repeated trials.

The current system is production-promising for infrastructure consistency; the next research step is explicit factuality/relevance evaluation with gold labels.
