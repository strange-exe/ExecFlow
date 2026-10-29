#include <algorithm>
#include <iostream>
#include <vector>

int main() {
    std::vector<int> scores = {42, 17, 88, 63};
    scores.push_back(71);
    std::sort(scores.begin(), scores.end());

    for (int s : scores) {
        std::cout << s << " ";
    }
    std::cout << "\nCount: " << scores.size() << ", best: " << scores.back() << "\n";
    return 0;
}
