#include <iostream>
#include <string>

int main() {
    std::string name;
    int year;
    std::cout << "Your name: ";
    std::getline(std::cin, name);
    std::cout << "Year you were born: ";
    std::cin >> year;
    std::cout << name << ", in 2030 you will turn " << 2030 - year << ".\n";
    return 0;
}
