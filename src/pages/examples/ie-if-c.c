#include <stdio.h>

int main(void) {
    int n;
    printf("Enter a number: ");
    scanf("%d", &n);
    if (n < 0) {
        n = -n;
    }
    printf("Distance from zero: %d\n", n);
    return 0;
}
