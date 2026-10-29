#include <iostream>
#include <vector>

int main() {
    std::vector<int> marks;
    marks.push_back(91);
    marks.push_back("85");
    std::cout << marks.size() << " marks\n";
    return 0;
}
