#include <stdio.h>

int main(void) {
    int n, i;
    long long a = 0, b = 1, next;
    printf("How many terms? ");
    scanf("%d", &n);
    for (i = 1; i <= n; i++) {
        printf("%lld ", a);
        next = a + b;
        a = b;
        b = next;
    }
    printf("\n");
    return 0;
}
