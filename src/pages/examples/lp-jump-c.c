#include <stdio.h>

int main(void) {
    int n, total = 0;
    while (1) {
        printf("Number (0 to stop): ");
        scanf("%d", &n);
        if (n == 0) {
            break;
        }
        if (n < 0) {
            continue;
        }
        total = total + n;
    }
    printf("Total of the positive numbers = %d\n", total);
    return 0;
}
