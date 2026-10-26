int main(void) {
    int count = 0;
    for (int i = 0; i < 5; i++) {
        if (i == 1) continue;
        for (int j = 0; j < 5; j++) {
            if (j > i) break;
            count++;
        }
    }
    return count;
}
