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

Custom paths:

```bash
npm run benchmark -- --snapshot-dir ./tmp/bench-snap --output ./tmp/bench.json
```

Live LLM mode:

```bash
npm run benchmark:live
```

## Output

JSON report is written to:

1. default: `benchmark/results/latest.json`
2. custom path via `--output`
