#include <stdio.h>

int main(void) {
    int marks;
    scanf("%d", &marks);
    if (marks >= 40) {
        printf("Pass\n");
    } else {
        printf("Fail\n");
    }
    return 0;
}
