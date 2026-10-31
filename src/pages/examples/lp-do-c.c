#include <stdio.h>

int main(void) {
    int n;
    do {
        printf("Enter a number from 1 to 10: ");
        scanf("%d", &n);
    } while (n < 1 || n > 10);
    printf("You chose %d\n", n);
    return 0;
}
