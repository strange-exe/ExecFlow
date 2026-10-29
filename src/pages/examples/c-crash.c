#include <stdio.h>

int main(void) {
    int marks[5] = {0};
    int i;
    printf("Which student (0 to 4)? ");
    scanf("%d", &i);
    marks[i] = 100;
    printf("First student: %d\n", marks[0]);
    return 0;
}
