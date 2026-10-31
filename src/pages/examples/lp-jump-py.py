total = 0
while True:
    n = int(input("Number (0 to stop): "))
    if n == 0:
        break
    if n < 0:
        continue
    total = total + n
print("Total of the positive numbers =", total)
