#ifndef BILIKARA_LIBAV_PROBE_H
#define BILIKARA_LIBAV_PROBE_H
#include <stdint.h>

/* Project ABI v1. No FFmpeg types/enums cross this boundary.
 * All arrays have explicit byte lengths (UTF-8, no required trailing NUL).
 * The companion owns one aggregate result; only bm_release may free it.
 * Request/callback/descriptor are borrowed until bm_probe_metadata returns.
 * The caller keeps the library loaded until all calls/releases have finished. */
#define BM_ABI 1u
#define BM_STREAMS 32u
#define BM_TEXT 128u
#define BM_CONFIG 2048u
#define BM_OK 0u
#define BM_UNAVAILABLE 1u
#define BM_INVALID_REQUEST 2u
#define BM_SOURCE_MISSING 3u
#define BM_UNSUPPORTED_FORMAT 4u
#define BM_UNSUPPORTED_CODEC 5u
#define BM_CONTRACT 6u
#define BM_INVALID_MEDIA 7u
#define BM_IO 8u
#define BM_CANCELLED 9u
#define BM_BACKEND_FAILURE 10u

/* Optional-field bits. Absent values are unspecified, never sentinels. */
#define BM_DURATION 1u
#define BM_START 2u
#define BM_TIME_BASE 4u
#define BM_WIDTH 8u
#define BM_HEIGHT 16u
#define BM_RATE 32u
#define BM_CHANNELS 64u
#define BM_BIT_RATE 128u
#define BM_RAW_BITS 256u

typedef struct { uint32_t len; uint8_t bytes[BM_TEXT]; } BmText;
typedef struct { uint32_t len; uint8_t bytes[BM_CONFIG]; } BmConfig;
typedef struct {
    uint32_t abi, request_size, result_size, stream_size;
    uint32_t build_versions[3], runtime_versions[3]; /* format, codec, util */
    BmText backend, build_version, runtime_version;
    BmConfig build_config, runtime_configs[3];
} BmInfo;
typedef struct {
    int32_t fd; /* Read-only, seekable, regular file, positioned at start. */
    int32_t (*cancelled)(void *opaque); /* Must not unwind. */
    void *opaque;
} BmRequest;
typedef struct {
    uint32_t index, media_type, present;
    /* Project media types: 0 unknown, 1 video, 2 audio, 3 subtitle,
     * 4 data, 5 attachment. Codec is a name, never an AVCodecID. */
    BmText codec;
    int64_t duration_ticks, start_ticks;
    int32_t time_base_num, time_base_den;
    uint32_t width_px, height_px, sample_rate_hz, channels;
    int64_t bit_rate_bps;
    uint32_t raw_bit_depth;
} BmStream;
typedef struct {
    uint32_t status, inspection_level; /* 1 = stream_metadata */
    BmText message, container;
    uint32_t present, stream_count;
    int64_t duration_us, start_time_us, bit_rate_bps;
    BmStream streams[BM_STREAMS];
} BmResult;

#if defined(__GNUC__)
#define BM_EXPORT __attribute__((visibility("default")))
#else
#define BM_EXPORT
#endif
BM_EXPORT uint32_t bm_abi_version(void);
BM_EXPORT uint32_t bm_get_info(uint32_t size, BmInfo *info);
/* Non-OK function status means no result (e.g. allocation failure).
 * Otherwise inspect result->status and release even error/cancelled results. */
BM_EXPORT uint32_t bm_probe_metadata(const BmRequest *request, BmResult **result);
BM_EXPORT void bm_release(BmResult *result);
#endif
