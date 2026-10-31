#include <stdio.h>

int main(void) {
    int n, i;
    long long fact = 1;
    printf("Enter a number: ");
    scanf("%d", &n);
    if (n < 0) {
        printf("There is no factorial of a negative number\n");
    } else {
        for (i = 1; i <= n; i++) {
            fact = fact * i;
        }
        printf("Factorial of %d is %lld\n", n, fact);
    }
    return 0;
}
