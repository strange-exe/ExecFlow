def is_prime(n):
    if n < 2:
        return False
    for d in range(2, n):
        if n % d == 0:
            break
    else:
        return True
    return False


n = int(input("Number: "))
if n < 0:
    print("negative")
elif is_prime(n):
    print("prime")
elif n % 2 == 0:
    print("even")
else:
    print("odd")
