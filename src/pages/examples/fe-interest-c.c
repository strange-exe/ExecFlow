#include <stdio.h>

int main(void) {
    float p, r, t, si;
    printf("Principal: ");
    scanf("%f", &p);
    printf("Rate per year (%%): ");
    scanf("%f", &r);
    printf("Time in years: ");
    scanf("%f", &t);
    si = p * r * t / 100;
    printf("Simple interest: %.2f\n", si);
    return 0;
}
