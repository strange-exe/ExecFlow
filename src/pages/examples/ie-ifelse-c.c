#include <stdio.h>

int main(void) {
    int age;
    printf("Your age: ");
    scanf("%d", &age);
    if (age >= 18) {
        printf("You can vote.\n");
    } else {
        printf("You can vote in %d years.\n", 18 - age);
    }
    return 0;
}
