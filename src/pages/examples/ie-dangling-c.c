#include <stdio.h>

int main(void) {
    int age, ticket;
    printf("Age: ");
    scanf("%d", &age);
    printf("Ticket (1 yes, 0 no): ");
    scanf("%d", &ticket);
    if (age >= 18)
        if (ticket == 1)
            printf("Come in.\n");
    else
        printf("Sorry, you must be 18.\n");
    return 0;
}
