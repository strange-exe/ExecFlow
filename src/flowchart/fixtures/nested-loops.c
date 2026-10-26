int main(void) {
    int total = 0;
    for (int i = 0; i < 3; i++) {
        int j = 0;
        while (j < i) {
            total += j;
            j++;
        }
    }
    return total;
}
