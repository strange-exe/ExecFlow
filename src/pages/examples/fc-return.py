def find(items, target):
    for i in range(len(items)):
        if items[i] == target:
            return i
    return -1

print(find([4, 8, 15, 16], 15))
print(find([4, 8, 15, 16], 23))
