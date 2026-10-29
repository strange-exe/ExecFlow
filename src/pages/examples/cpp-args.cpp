#include <iostream>
#include <string>

std::string greet(std::string name, int age) {
    return "Hello, " + name + ", age " + std::to_string(age);
}

int main() {
    std::cout << greet("Ada") << "\n";
    return 0;
}
