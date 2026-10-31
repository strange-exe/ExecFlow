a = int(input("First number: "))
op = input("Operator (+, - or *): ")
b = int(input("Second number: "))
match op:
    case "+":
        print(a + b)
    case "-":
        print(a - b)
    case "*":
        print(a * b)
    case _:
        print("Unknown operator", op)
