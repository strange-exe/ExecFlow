#include <stdio.h>

int main(void) {
    int n, i, is_prime = 1;
    printf("Enter a number: ");
    scanf("%d", &n);
    if (n < 2) {
        is_prime = 0;
    }
    for (i = 2; i * i <= n; i++) {
        if (n % i == 0) {
            is_prime = 0;
            break;
        }
    }
    if (is_prime) {
        printf("%d is prime\n", n);
    } else {
        printf("%d is not prime\n", n);
    }
    return 0;
}
