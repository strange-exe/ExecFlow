"""Count down, then search (a docstring is not a step)."""
n = 3
while n > 0:
    n -= 1
    if n == 1:
        continue
    print(n)
else:
    print("done")
while True:
    n += 1
    if n > 5:
        break
