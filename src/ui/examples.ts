// "New from example...": short original programs to read, run and change, three per language
// (.claude/design/batch3/p.md section 3). Bundled with the examples dialog's lazy chunk, so they
// work offline and cost a first visit nothing. Each runs to exit code 0 (e2e/examples.spec.ts runs
// every one, with the input it asks for). String.raw keeps the programs' own backslashes ("\n").
import type { LanguageId } from "../core/languages";
import { tryNormalizePath } from "../core/paths";

export interface Example {
  /** The file name it is added under (a free one if that is taken: freeName). */
  name: string;
  lang: LanguageId;
  /** One line under the name: what it shows. */
  about: string;
  code: string;
  /** Lines to type while it runs (tests; empty: it asks for nothing). */
  input: readonly string[];
}

export const EXAMPLES: readonly Example[] = [
  {
    name: "input_loops.py",
    lang: "python",
    about: "Read numbers you type with input() and add them up in a for loop.",
    input: ["3", "4", "5", "6"],
    code: String.raw`# Input and loops: ask for some numbers, then add them up.
count = int(input("How many numbers? "))

total = 0
for i in range(1, count + 1):
    number = float(input(f"Number {i}: "))
    total = total + number

print("Total:", total)
if count > 0:
    print("Average:", total / count)
`,
  },
  {
    name: "lists_dicts.py",
    lang: "python",
    about: "Keep words in a list and count each one with a dictionary.",
    input: [],
    code: String.raw`# Lists and dictionaries: count the words in a sentence.
sentence = "the cat sat on the mat with the hat"
words = sentence.split()
print("Words:", words)
print("How many:", len(words))

counts = {}
for word in words:
    counts[word] = counts.get(word, 0) + 1

for word, n in sorted(counts.items()):
    print(f"{word}: {n}")

longest = max(words, key=len)
print("Longest word:", longest)
`,
  },
  {
    name: "functions.py",
    lang: "python",
    about: "Give a piece of work a name with def, then call it with different values.",
    input: [],
    code: String.raw`# Functions: name a piece of work once, then use it again and again.
def area_of_rectangle(width, height):
    """Return the area of a rectangle."""
    return width * height


def describe(name, width, height):
    area = area_of_rectangle(width, height)
    print(f"{name} is {width} by {height}, so its area is {area}.")


def is_even(n):
    return n % 2 == 0


describe("A table", 2, 3)
describe("A garden", 10, 4.5)

for n in range(1, 6):
    print(n, "is even" if is_even(n) else "is odd")
`,
  },
  {
    name: "scanf_printf.c",
    lang: "c",
    about: "Read two whole numbers with scanf and print their sum and product with printf.",
    input: ["7", "3"],
    code: String.raw`/* scanf and printf: read two whole numbers, then print what they make. */
#include <stdio.h>

int main(void) {
    int a, b;

    printf("First number: ");
    if (scanf("%d", &a) != 1) {
        printf("That wasn't a whole number.\n");
        return 1;
    }
    printf("Second number: ");
    if (scanf("%d", &b) != 1) {
        printf("That wasn't a whole number.\n");
        return 1;
    }

    printf("%d + %d = %d\n", a, b, a + b);
    printf("%d * %d = %d\n", a, b, a * b);
    if (b != 0) {
        printf("%d / %d = %.2f\n", a, b, (double)a / b);
    }
    return 0;
}
`,
  },
  {
    name: "arrays.c",
    lang: "c",
    about: "Keep several marks in one array, then find their sum, average and best.",
    input: [],
    code: String.raw`/* Arrays: keep several values under one name and walk through them. */
#include <stdio.h>

int main(void) {
    int marks[] = {72, 85, 64, 90, 58};
    int n = sizeof marks / sizeof marks[0];
    int sum = 0;
    int best = marks[0];

    for (int i = 0; i < n; i++) {
        printf("marks[%d] = %d\n", i, marks[i]);
        sum += marks[i];
        if (marks[i] > best) {
            best = marks[i];
        }
    }

    printf("Sum: %d\n", sum);
    printf("Average: %.1f\n", (double)sum / n);
    printf("Best: %d\n", best);
    return 0;
}
`,
  },
  {
    name: "structs.c",
    lang: "c",
    about: "Group a student's name, age and grade into one struct.",
    input: [],
    code: String.raw`/* Structs: group the facts about one thing into one value. */
#include <stdio.h>

struct student {
    char name[32];
    int age;
    double grade;
};

void print_student(const struct student *s) {
    printf("%-6s age %d, grade %.1f\n", s->name, s->age, s->grade);
}

int main(void) {
    struct student group[3] = {
        {"Asha", 19, 8.5},
        {"Ben", 20, 7.0},
        {"Chen", 19, 9.2},
    };
    struct student top = group[0];

    for (int i = 0; i < 3; i++) {
        print_student(&group[i]);
        if (group[i].grade > top.grade) {
            top = group[i];
        }
    }
    printf("Top grade: %s\n", top.name);
    return 0;
}
`,
  },
  {
    name: "vectors.cpp",
    lang: "cpp",
    about: "Fill a std::vector with push_back and walk through it with a for loop.",
    input: [],
    code: String.raw`// Vectors: a list that grows as you add to it.
#include <iostream>
#include <vector>

int main() {
    std::vector<int> squares;
    for (int i = 1; i <= 5; i++) {
        squares.push_back(i * i);
    }

    std::cout << "Squares:";
    for (int n : squares) {
        std::cout << " " << n;
    }
    std::cout << "\n";

    int total = 0;
    for (int n : squares) {
        total += n;
    }
    std::cout << "Count: " << squares.size() << "\n";
    std::cout << "Total: " << total << "\n";
    return 0;
}
`,
  },
  {
    name: "classes.cpp",
    lang: "cpp",
    about: "A class keeps a counter's value private and changes it only through its methods.",
    input: [],
    code: String.raw`// Classes: data and the functions that work on it, kept together.
#include <iostream>
#include <string>

class Counter {
public:
    explicit Counter(std::string name) : name_(name), count_(0) {}

    void add(int amount) {
        if (amount > 0) {
            count_ += amount;
        }
    }

    void reset() { count_ = 0; }

    void print() const {
        std::cout << name_ << ": " << count_ << "\n";
    }

private:
    std::string name_;
    int count_;
};

int main() {
    Counter steps("Steps");
    steps.add(120);
    steps.add(80);
    steps.add(-5);  // ignored: add only counts up
    steps.print();
    steps.reset();
    steps.print();
    return 0;
}
`,
  },
  {
    name: "strings.cpp",
    lang: "cpp",
    about: "Read a line with getline, then count its vowels and turn it around.",
    input: ["Hello world"],
    code: String.raw`// Strings: read a line of text and look at it in different ways.
#include <cctype>
#include <iostream>
#include <string>

int main() {
    std::string line;
    std::cout << "Type a word or a sentence: ";
    std::getline(std::cin, line);

    std::cout << "Length: " << line.size() << "\n";

    std::string upper = line;
    for (char &c : upper) {
        c = std::toupper(static_cast<unsigned char>(c));
    }
    std::cout << "Upper case: " << upper << "\n";

    std::string backwards(line.rbegin(), line.rend());
    std::cout << "Backwards: " << backwards << "\n";

    int vowels = 0;
    for (char c : line) {
        if (std::string("aeiouAEIOU").find(c) != std::string::npos) {
            vowels++;
        }
    }
    std::cout << "Vowels: " << vowels << "\n";
    return 0;
}
`,
  },
];

/**
 * `name` if no entry has it (compared as storage does: `taken` holds folded keys), else "name-2.ext",
 * "name-3.ext" and so on. A name too long to store with its number gets a shorter stem, cut by whole
 * characters (as sync/merge copyName does), so the result is always a name storage accepts.
 */
export function freeName(name: string, taken: (path: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const shortened = (chars: readonly string[], suffix: string) => {
    for (let keep = chars.length; keep > 0; keep--) {
      const candidate = chars.slice(0, keep).join("") + suffix;
      if (tryNormalizePath(candidate) === candidate) return candidate;
    }
    return null;
  };
  // An extension too long to keep (a name that is almost all extension) is cut along with the rest.
  const numbered = (n: number) => shortened([...stem], `-${n}${ext}`) ?? shortened([...name], `-${n}`) ?? `${n}`;
  // A workspace holds at most 2000 files, so a free number comes long before the bound.
  for (let n = 2; n < 100_000; n++) {
    const candidate = numbered(n);
    if (!taken(candidate)) return candidate;
  }
  return numbered(Date.now());
}
