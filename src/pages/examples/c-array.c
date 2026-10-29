#include <stdio.h>

int main(void) {
    int temps[7] = {31, 34, 29, 35, 33, 30, 32};
    int hottest = 0;
    int total = 0;

    for (int day = 0; day < 7; day++) {
        total += temps[day];
        if (temps[day] > temps[hottest]) {
            hottest = day;
        }
    }
    printf("Hottest: day %d, %d C\n", hottest + 1, temps[hottest]);
    printf("Average: %.1f C\n", total / 7.0);
    return 0;
}
