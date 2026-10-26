// Program to print a grade for each score (the kind of code an AI assistant writes)
#include <iostream>
#include <vector>
using namespace std;

// Returns the grade letter for a score.
char grade(int score) {
    if (score >= 90) return 'A';
    else if (score >= 75) return 'B';
    return 'C';
}

int main() {
    int n;
    cout << "How many? ";
    cin >> n;
    vector<int> scores(n);
    // Read every score.
    for (int &s : scores) {
        cin >> s;
    }
    for (int s : scores) {
        std::cout << grade(s) << endl;
    }
    return 0;
}
