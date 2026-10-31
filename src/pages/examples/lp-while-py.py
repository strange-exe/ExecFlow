n = int(input("Enter a number: "))
total = 0
while n > 0:
    total = total + n % 10
    n = n // 10
print("Sum of digits =", total)
