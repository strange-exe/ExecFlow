class Counter:
    def add(self, k):
        self.total += k

sq = lambda v: v * v
try:
    x = int("4")
except ValueError:
    x = 0
with open("data.txt") as f:
    data = f.read()
print(sq(x))
