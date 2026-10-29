#include <stdio.h>

int main(void) {
    printf("C standard: %ld\n", __STDC_VERSION__);
    printf("Compiler: clang %s\n", __clang_version__);
    printf("int is %zu bytes, a pointer is %zu bytes\n", sizeof(int), sizeof(void *));
    return 0;
}
