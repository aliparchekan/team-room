# AutoResearch demo: prime-counting queries

`solver.answer_queries(queries)` returns, for each `n`, the number of primes `<= n`.
The baseline is deliberately slow (trial division over every smaller number, per query).

- **Objective:** make `answer_queries` faster without changing its answers.
- **Evaluation:** `python3 "$EVAL_DIR/eval/evaluate.py"` — checks every answer against an independent
  reference, then prints `{"metric": seconds, "pass": true|false}`. Minimize `metric`.
- **Allowed scope:** `solver.py` (and new helper modules next to it).
- **Protected:** `eval/` — experiments that touch it are rejected.

Plausible directions: trial division only up to √n, skipping even numbers, one sieve shared by all
queries with prefix counts, memoizing counts between queries.
