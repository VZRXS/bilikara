/* Windows-only OS/CRT adaptation; no media rules. FFmpeg and this TU use /MD. */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <io.h>
#include <wchar.h>
#define close _close
#define open _open
#define lseek _lseeki64

static int bm_regular_fd(int fd) {
    HANDLE h = (HANDLE)_get_osfhandle(fd);
    BY_HANDLE_FILE_INFORMATION info;
    return h != INVALID_HANDLE_VALUE && GetFileType(h) == FILE_TYPE_DISK &&
        GetFileInformationByHandle(h, &info) && !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY);
}
int32_t bm_fd_from_handle_v1(void *handle) {
    HANDLE duplicate = NULL;
    if (GetFileType(handle) != FILE_TYPE_DISK ||
        !DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &duplicate,
                         GENERIC_READ, FALSE, 0)) return -1;
    int fd = _open_osfhandle((intptr_t)duplicate, _O_RDONLY | _O_BINARY);
    if (fd < 0) CloseHandle(duplicate);
    else if (!bm_regular_fd(fd)) { _close(fd); return -1; }
    return fd;
}
void bm_fd_close_v1(int32_t fd) { _close(fd); }

static int bm_absolute_path(const char *p) {
    return strlen(p) >= 3 && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z')) &&
        p[1] == ':' && (p[2] == '\\' || p[2] == '/') && !strchr(p + 2, ':');
}
static wchar_t *bm_wide(const char *p) {
    if (!bm_absolute_path(p)) return NULL;
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, p, -1, NULL, 0);
    if (!n) return NULL;
    wchar_t *w = malloc((size_t)n * sizeof(*w));
    if (w && !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, p, -1, w, n)) { free(w); return NULL; }
    return w;
}
static int bm_open_read(const char *p) {
    wchar_t *w = bm_wide(p);
    if (!w) return -1;
    int fd = _wopen(w, _O_RDONLY | _O_BINARY);
    free(w);
    return fd;
}
static uint32_t bm_empty_distinct_output(int input, const char *p) {
    wchar_t *w = bm_wide(p);
    if (!w) return BM_INVALID_REQUEST;
    HANDLE out = CreateFileW(w, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    free(w);
    if (out == INVALID_HANDLE_VALUE) return BM_IO;
    BY_HANDLE_FILE_INFORMATION a, b;
    int ok = GetFileInformationByHandle((HANDLE)_get_osfhandle(input), &a) &&
        GetFileInformationByHandle(out, &b);
    DWORD ty = GetFileType(out);
    CloseHandle(out);
    if (!ok) return BM_IO;
    if (ty != FILE_TYPE_DISK || (b.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
        b.nFileSizeHigh || b.nFileSizeLow ||
        (a.dwVolumeSerialNumber == b.dwVolumeSerialNumber &&
         a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow)) return BM_INVALID_REQUEST;
    return BM_OK;
}
