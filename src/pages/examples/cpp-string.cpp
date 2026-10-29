#include <iostream>
#include <string>

int main() {
    std::string word = "programming";
    std::string reversed(word.rbegin(), word.rend());
    int vowels = 0;
    for (char c : word) {
        if (std::string("aeiou").find(c) != std::string::npos) {
            vowels++;
        }
    }
    std::cout << word << " has " << word.length() << " letters\n";
    std::cout << "Reversed: " << reversed << "\n";
    std::cout << "Vowels: " << vowels << "\n";
    return 0;
}
