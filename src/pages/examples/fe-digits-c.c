#include <stdio.h>

int main(void) {
    int n, total = 0;
    printf("Enter a number: ");
    scanf("%d", &n);
    if (n < 0) {
        n = -n;
    }
    while (n > 0) {
        total = total + n % 10;
        n = n / 10;
    }
    printf("Sum of digits: %d\n", total);
    return 0;
}
