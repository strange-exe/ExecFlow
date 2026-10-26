#include <iostream>
template <typename T>
T twice(T x) {
    return x * 2;
}
int main() {
    auto sq = [](int v) { return v * v; };
    try {
        throw 1;
    } catch (int e) {
        std::cout << e;
    }
    std::cout << twice(3) << sq(2);
    return 0;
}
