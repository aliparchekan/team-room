"""Independent evaluation for the AutoResearch demo.

Team Room runs this from a protected copy of eval/ ($EVAL_DIR/eval), with the
experiment's checkout as the working directory. It never trusts the
solver: answers are checked against a reference computed here.

Prints one JSON line: {"metric": seconds, "pass": bool, "metrics": {...}}.
Lower is better (direction: minimize).
"""
import importlib
import json
import os
import statistics
import sys
import time

sys.path.insert(0, os.getcwd())
sys.dont_write_bytecode = True

QUERIES = [0, 1, 2, 3, 10, 97, 100, 500, 1000, 1499, 1500, 2000, 2500, 3000, 3001, 2999, 1024, 777, 3000, 2048]


def reference_counts(queries):
    top = max(queries)
    sieve = bytearray([1]) * (top + 1)
    sieve[0:2] = b"\x00\x00"
    for i in range(2, int(top ** 0.5) + 1):
        if sieve[i]:
            sieve[i * i :: i] = bytearray(len(sieve[i * i :: i]))
    prefix, total = [], 0
    for flag in sieve:
        total += flag
        prefix.append(total)
    return [prefix[q] for q in queries]


def main():
    try:
        import solver
    except Exception as exc:  # the experiment broke the module
        print(json.dumps({"metric": None, "pass": False, "error": f"import failed: {exc!r}"}))
        return 1

    expected = reference_counts(QUERIES)
    try:
        got = solver.answer_queries(list(QUERIES))
    except Exception as exc:
        print(json.dumps({"metric": None, "pass": False, "error": f"answer_queries raised {exc!r}"}))
        return 1
    correct = sum(1 for a, b in zip(got, expected) if a == b) if isinstance(got, list) else 0
    if not isinstance(got, list) or len(got) != len(expected) or correct != len(expected):
        print(json.dumps({"metric": None, "pass": False, "metrics": {"correct": correct, "total": len(expected)}, "error": "wrong answers"}))
        return 1

    # Timing: reload the module before every timed call, so state cached by an
    # earlier call (including the correctness check) cannot make a call look fast.
    orders = [list(QUERIES), list(reversed(QUERIES)), sorted(QUERIES)]
    samples = []
    for order in orders:
        solver = importlib.reload(solver)
        start = time.perf_counter()
        solver.answer_queries(order)
        samples.append(time.perf_counter() - start)
    seconds = statistics.median(samples)
    print(json.dumps({"metric": round(seconds, 6), "pass": True, "metrics": {"correct": correct, "total": len(expected), "max_sample_s": round(max(samples), 6)}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
