#include <stdio.h>

int main(void) {
    int a, b;
    char op;
    printf("Calculation (like 6 + 2): ");
    scanf("%d %c %d", &a, &op, &b);
    switch (op) {
        case '+':
            printf("%d\n", a + b);
            break;
        case '-':
            printf("%d\n", a - b);
            break;
        case '*':
            printf("%d\n", a * b);
            break;
        default:
            printf("Unknown operator %c\n", op);
    }
    return 0;
}
