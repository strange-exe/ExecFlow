n = int(input("Enter a number: "))
is_prime = True
if n < 2:
    is_prime = False
for i in range(2, n + 1):
    if n % i == 0:
        is_prime = False
        break
if is_prime:
    print(n, "is prime")
else:
    print(n, "is not prime")
