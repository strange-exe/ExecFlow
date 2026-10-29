marks = [78, 92, 65, 88, 71]

for i, m in enumerate(marks, start=1):
    print(f"Student {i}: {m}")

print("Highest:", max(marks))
print("Average:", sum(marks) / len(marks))
