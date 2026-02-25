# CHME Benchmark

This folder contains a deterministic benchmark package for CHME.

## Dataset

`benchmark/data` includes 15 markdown fixtures across 3 collections:

1. `compliance`
2. `payments`
3. `risk`

## Run

```bash
npm run benchmark
```

Factual accuracy benchmark (fast default mode):

```bash
npm run benchmark:factual
```

Custom paths:

```bash
npm run benchmark -- --snapshot-dir ./tmp/bench-snap --output ./tmp/bench.json
```

Custom factual benchmark output/snapshot:

```bash
npm run benchmark:factual -- --snapshot-dir ./tmp/factual-snap --output ./tmp/factual.json
```

Live LLM mode:

```bash
npm run benchmark:live
```

Live factual grading mode:

```bash
npm run benchmark:factual:live
```

## Output

JSON report is written to:

1. default: `benchmark/results/latest.json`
2. default factual: `benchmark/results/factual_latest.json`
3. custom path via `--output`
