# Eval predictions

Pre-register what a live eval should show before it runs, so a single result is not read for a difference after the fact.

An entry is written, dated, and committed before its run launches. Entries are append-only once their run starts. A wrong prediction is reported as wrong next to its result.

`node evals/run.mjs` warns on stderr for any condition it is asked to run that no dated entry names. The warning does not stop the run.

## Entry format

One entry per planned run: a level-2 heading with the date and every condition the run compares, control included, then these bullets in this order. The metric is one of: hidden-set pass rate, defect-judge count, cost, wall time. Outcomes say what changes: keep, redesign, or drop the feature.

```
## <YYYY-MM-DD> <arm>, <arm>: <title>

- **Hypothesis:**
- **Metric:**
- **Confirms:**
- **Falsifies:**
- **Runs:**
- **Outcomes:**
- **Result:**
```

## Entries

None yet.
