n = int(input("Enter a number: "))
if n < 0:
    print("There is no factorial of a negative number")
else:
    fact = 1
    for i in range(1, n + 1):
        fact = fact * i
    print("Factorial of", n, "is", fact)
