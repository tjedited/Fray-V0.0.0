/* main.cpp */
#include "main.hpp"

int main (int argc, char* argv[]) {
    
    std::printf("Hello World!\n");

    for (int i = 0; i < argc; i++) {
        std::printf("%s\n", argv[i]);
    }

    return 0;
}