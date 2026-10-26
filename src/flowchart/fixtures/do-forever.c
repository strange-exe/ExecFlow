#include <stdio.h>
int main(void) {
    int n = 5;
    do {
        n--;
    } while (n > 0);
    for (;;) {
        n++;
        if (n == 3) break;
    }
    return 0;
}
