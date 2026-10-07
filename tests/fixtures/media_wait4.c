/* Linux live packet-scan measurement, the same wait4 high-water observation.
 * Node owns this process group and deadline; no media logic or interpreter. */
#define _DEFAULT_SOURCE
#include <errno.h>
#include <stdio.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
    if (argc < 3) return 2;
    pid_t pid = fork();
    if (pid < 0) return 2;
    if (!pid) { execv(argv[2], argv + 2); _exit(127); }
    int status;
    struct rusage usage;
    while (wait4(pid, &status, 0, &usage) < 0) if (errno != EINTR) return 2;
    FILE *output = fopen(argv[1], "wb");
    if (!output) return 2;
    int written = fprintf(output, "%ld\n", usage.ru_maxrss);
    if (fclose(output) || written < 0) return 2;
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
