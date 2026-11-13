"""Answer prime-counting queries.

answer_queries(queries) returns, for each n, how many primes are <= n.
This baseline is deliberately slow: it tests every candidate by trial
division over all smaller numbers, separately for every query.
"""


def is_prime(n):
    if n < 2:
        return False
    for d in range(2, n):
        if n % d == 0:
            return False
    return True


def count_primes_upto(n):
    return sum(1 for k in range(n + 1) if is_prime(k))


def answer_queries(queries):
    return [count_primes_upto(n) for n in queries]
