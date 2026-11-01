#include <stdio.h>

int main(void) {
    int n, original, digit, reverse = 0;
    printf("Enter a number: ");
    scanf("%d", &n);
    original = n;
    while (n > 0) {
        digit = n % 10;
        reverse = reverse * 10 + digit;
        n = n / 10;
    }
    printf("Reverse of %d is %d\n", original, reverse);
    return 0;
}
