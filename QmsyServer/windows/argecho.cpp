#include <stdio.h>

int main(int argc, char *argv[]) {
    for (int i = 1; i < argc; i++) {
        printf("%s", argv[i]);
        // 在每个参数后添加空格，最后一个参数除外
        if (i < argc - 1) {
            printf(" ");
        }
    }
    printf("\n");
    return 124;
}