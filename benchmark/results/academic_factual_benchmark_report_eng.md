# CHME Factual Accuracy Benchmark Report (Academic)

## Abstract
This report evaluates the factual retrieval quality of the Compact Hierarchical Memory Engine (CHME) on a controlled FinTech SaaS corpus. The benchmark measures routing quality, evidence retrieval relevance, snapshot consistency, and optional answer-level factual grounding. Results show strong deterministic routing and retrieval behavior, but insufficient answer-level factuality under the configured local 7B model.

## Experimental Configuration
- Run ID: `2026-02-25T23-06-19-372Z`
- Dataset: 15 Markdown files, 3 collections (`compliance`, `payments`, `risk`)
- Iterations: 2
- Retrieval: `topK=5`, `topCollections=3`, `topKPerCollection=3`
- Provider/Model: local, `qwen2.5:7b`
- Snapshot mode: enabled (`save` + `load` roundtrip)

Collection-level structure was balanced:
- Each collection: 5 documents, 30 sections, 50 chunks, 85 nodes.

## Metric Definitions
Let \(Q\) be the set of benchmark questions, \(q \in Q\), and \(K\) be retrieval cutoff.

1. Route Top-1 Accuracy
\[
\text{Acc}_{\text{route@1}}=\frac{1}{|Q|}\sum_{q \in Q}\mathbf{1}\{\hat{c}_1(q)\in C_q^{*}\}
\]
where \(\hat{c}_1(q)\) is top routed collection, \(C_q^{*}\) accepted gold collections.

2. Route Recall@N
\[
\text{Recall}_{\text{route@N}}=\frac{1}{|Q|}\sum_{q \in Q}\mathbf{1}\{\hat{C}_N(q)\cap C_q^{*}\neq\emptyset\}
\]

3. Hit@K
\[
\text{Hit@K}=\frac{1}{|Q|}\sum_{q \in Q}\mathbf{1}\{\exists r \le K: d_r(q)\in D_q^{*}\}
\]
where \(D_q^{*}\) is gold evidence set.

4. MRR@K
\[
\text{MRR@K}=\frac{1}{|Q|}\sum_{q \in Q}
\begin{cases}
\frac{1}{\text{rank}_q}, & \text{if relevant found within }K \\
0, & \text{otherwise}
\end{cases}
\]

5. Evidence Precision@K
\[
\text{Prec@K}=\frac{1}{|Q|}\sum_{q \in Q}\frac{|R_q^K \cap D_q^{*}|}{K}
\]

6. Evidence Recall
\[
\text{Recall}_{\text{evidence}}=\frac{1}{|Q|}\sum_{q \in Q}\frac{|R_q^K \cap D_q^{*}|}{|D_q^{*}|}
\]

7. Answer-level Factual Score (optional live grading)
\[
\text{FactualScore}=0.5\cdot \text{KeywordCoverage}+0.5\cdot \text{GroundingRatio}
\]
\[
\text{KeywordCoverage}=\frac{|K_{\text{ans}}\cap K_{\text{expected}}|}{|K_{\text{expected}}|},\quad
\text{GroundingRatio}=\frac{|T_{\text{ans}}\cap T_{\text{ctx}}|}{|T_{\text{ans}}|}
\]

## Results
### System-Level Outcomes
- Snapshot roundtrip: **pass** (state restored without mismatch)
- Overall benchmark pass: **false** (factuality threshold not met)

### Relevance and Routing Metrics
- Route Top-1 Accuracy: **1.0000**
- Route Recall@N: **1.0000**
- Hit@K: **0.9167**
- MRR@K: **0.7986**
- Evidence Precision@K: **0.4000**
- Evidence Recall: **0.8194**

Interpretation: CHME routing and retrieval are robust and near-threshold-optimal for this corpus. Retrieval ordering remains deterministic and generally evidence-seeking, with moderate precision due to cross-domain lexical overlap.

### Factuality Metrics (Live LLM Grading Enabled)
- Mean Factual Score: **0.5456** (threshold: 0.6000, fail)
- Mean Keyword Coverage: **0.7500**
- Mean Grounding Ratio: **0.3411**
- Empty answers: **0**

Interpretation: The model usually includes expected topic terms, but token-level grounding to retrieved context is weak. This produces acceptable relevance but insufficient source-faithful answer composition.

## Error Analysis
Primary failure case:
- Query: `risk_limit_exposure`
- Hit@K: 0, MRR@K: 0, Evidence Recall: 0
- First retrieved nodes missed target evidence documents (`risk__04-limit-management`, `risk__05-incident-response`).

Observed pattern:
- Cross-domain shared terms (`transaction`, `alert`, `limit`, `chargeback`) increase lexical collisions.
- Routing succeeds, but chunk ranking can over-prioritize neighboring lexical contexts.
- Answer generation amplifies this by producing long responses with low context grounding ratio.

## Latency Profile
- Ingest: 14.88 ms
- Snapshot save: 10.70 ms
- Snapshot load: 7.26 ms
- Route mean: 0.05 ms
- Retrieve mean: 0.35 ms
- Ask mean (live model): 6177.73 ms (p95: 10121.29 ms)

Interpretation: Core CHME operations are low-latency and stable; runtime cost is dominated by model inference, not memory indexing or retrieval.

## Validity and Limitations
- Corpus size is controlled and moderate (15 files), so external validity is limited.
- Evidence relevance is doc-prefix based; chunk-level semantic relevance is not fully captured.
- Factual scoring is heuristic and may under/overestimate true factual correctness.
- Live model behavior can vary by runtime parameters, quantization, and system load.

## Conclusion
CHME demonstrates strong deterministic routing, stable snapshot persistence, and high retrieval relevance on benchmark data. However, answer-level factuality currently underperforms the configured acceptance criterion (\(0.5456 < 0.6000\)). The system is reliable as a memory/retrieval layer; answer faithfulness is the current bottleneck and should be improved via stricter context-grounded generation constraints and stronger reranking or evidence filtering.
