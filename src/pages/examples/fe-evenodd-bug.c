#include <stdio.h>

int main(void) {
    int n;
    printf("Enter a whole number: ");
    scanf("%d", &n);
    if (n % 2 == 1) {
        printf("%d is odd\n", n);
    } else {
        printf("%d is even\n", n);
    }
    return 0;
}
