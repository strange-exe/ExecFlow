def is_prime(n):
    if n < 2:
        return False
    for d in range(2, int(n ** 0.5) + 1):
        if n % d == 0:
            return False
    return True

primes = [n for n in range(30) if is_prime(n)]
print(primes)
