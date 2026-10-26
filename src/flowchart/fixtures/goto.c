#include <stdio.h>
int main(void) {
    int i = 0;
again:
    i++;
    if (i < 3) goto again;
    printf("%d", i);
    return 0;
}
