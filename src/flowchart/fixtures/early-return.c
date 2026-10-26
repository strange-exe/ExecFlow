int find(int a[], int n, int x) {
    for (int i = 0; i < n; i++) {
        if (a[i] == x) {
            return i;
        }
    }
    return -1;
}

int main(void) {
    int a[3] = {1, 2, 3};
    int at = find(a, 3, 2);
    return at;
    at = 0;
}
