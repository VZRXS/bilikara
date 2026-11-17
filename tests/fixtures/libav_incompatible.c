/* Negative loader fixture: valid library, deliberately incompatible project ABI. */
#include <stdint.h>
#ifdef _WIN32
__declspec(dllexport)
#else
__attribute__((visibility("default")))
#endif
uint32_t bm_abi_version(void) { return 0; }
#ifdef _WIN32
/* Loader checks these symbols before project ABI; never called in this test. */
__declspec(dllexport) int32_t bm_fd_from_handle_v1(void *handle) {
    (void)handle;
    return -1;
}
__declspec(dllexport) void bm_fd_close_v1(int32_t fd) { (void)fd; }
#endif
