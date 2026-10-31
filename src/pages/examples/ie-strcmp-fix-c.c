#include <stdio.h>
#include <string.h>

int main(void) {
    char answer[10];
    printf("Type yes or no: ");
    scanf("%9s", answer);
    if (strcmp(answer, "yes") == 0) {
        printf("You said yes.\n");
    } else {
        printf("That was not yes.\n");
    }
    return 0;
}
