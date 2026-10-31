#include <stdio.h>

int main(void) {
    int n;
    printf("Table of: ");
    scanf("%d", &n);
    for (int i = 1; i <= 10; i++) {
        printf("%d x %d = %d\n", n, i, n * i);
    }
    return 0;
}
