#include <stdio.h>

int main(void) {
    int choice;
    printf("1 Tea, 2 Coffee, 3 Juice. Your choice: ");
    scanf("%d", &choice);
    switch (choice) {
        case 1:
            printf("Tea\n");
        case 2:
            printf("Coffee\n");
        case 3:
            printf("Juice\n");
        default:
            printf("No such drink\n");
    }
    return 0;
}
