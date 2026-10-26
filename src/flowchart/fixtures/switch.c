#include <stdio.h>
int main(void) {
    int day = 2;
    switch (day) {
    case 1:
    case 7:
        printf("weekend");
        break;
    case 2:
        printf("monday");
    case 3:
        printf("work");
        break;
    default:
        printf("other");
    }
    return 0;
}
