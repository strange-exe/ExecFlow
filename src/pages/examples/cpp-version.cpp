#include <iostream>

int main() {
    std::cout << "__cplusplus is " << __cplusplus << "\n";
    std::cout << "Compiler: clang " << __clang_version__ << "\n";
    return 0;
}
