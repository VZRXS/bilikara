/* Independent test probe: load the supplied native libraries/companion, never
 * metadata or the application Runtime. Keep handles alive through all calls. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#define ENTRY wmain
#define ARG wchar_t
#define HANDLE_TYPE HMODULE
#define LOAD(path) LoadLibraryExW(path, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)
#define SYMBOL GetProcAddress
#define CLOSE FreeLibrary
#else
#include <dlfcn.h>
#define ENTRY main
#define ARG char
#define HANDLE_TYPE void *
#define LOAD(path) dlopen(path, RTLD_NOW | RTLD_LOCAL)
#define SYMBOL dlsym
#define CLOSE dlclose
#endif

typedef uint32_t (*version_fn)(void);
typedef const char *(*text_fn)(void);

int ENTRY(int argc, ARG **argv) {
    HANDLE_TYPE libraries[5] = {0};
    const char *names[] = {"avutil_version", "avcodec_version", "avformat_version"};
    const unsigned indices[] = {0, 2, 3};
    int status = 1;
    if (argc != 6) return 2;
    for (unsigned i = 0; i < 5; ++i) {
        libraries[i] = LOAD(argv[i + 1]);
        if (!libraries[i]) { fprintf(stderr, "Cannot load selected native input %u\n", i); goto done; }
    }
    version_fn abi = (version_fn)SYMBOL(libraries[4], "bm_abi_version");
    if (!abi || abi() != 1) { fputs("Supplied companion has no accepted ABI 1\n", stderr); goto done; }
    for (unsigned i = 0; i < 3; ++i) {
        version_fn version = (version_fn)SYMBOL(libraries[indices[i]], names[i]);
        if (!version) goto done;
        printf("%u\n", version());
    }
    text_fn version = (text_fn)SYMBOL(libraries[0], "av_version_info");
    text_fn configuration = (text_fn)SYMBOL(libraries[3], "avformat_configuration");
    if (!version || !configuration) goto done;
    const char *v = version(), *c = configuration();
    if (!v || !c) goto done;
    size_t vn = 0, cn = 0;
    while (vn <= 128 && v[vn]) ++vn;
    while (cn <= 2048 && c[cn]) ++cn;
    if (vn > 128 || cn > 2048) goto done;
    printf("%s\n", v);
    if (fwrite(c, 1, cn, stdout) != cn) goto done;
    status = 0;
done:
    for (int i = 4; i >= 0; --i) if (libraries[i]) CLOSE(libraries[i]);
    if (status) fputs("Independent native libav probe failed\n", stderr);
    return status;
}
