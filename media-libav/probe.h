#ifndef BILIKARA_LIBAV_PROBE_H
#define BILIKARA_LIBAV_PROBE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

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

#if defined(_WIN32)
#define BM_EXPORT __declspec(dllexport)
#elif defined(__GNUC__)
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

/* Additive, independently sized scan schema. M1 structs/exports stay unchanged;
 * absence of these symbols means scanning is unavailable, not a CLI fallback.
 * One exact audio/video stream per call, including in a muxed input. */
#define BM_SCAN_SCHEMA 1u
#define BM_SCAN_INCOMPLETE 0u
#define BM_SCAN_EOF 1u
#define BM_SCAN_PTS 1u
#define BM_SCAN_DTS 2u
#define BM_SCAN_BASE 4u
typedef struct {
    uint32_t schema, request_size, result_size, summary_size;
} BmScanInfo;
typedef struct {
    BmRequest input;
    uint32_t stream_index, media_type; /* exactly 1 video or 2 audio */
} BmScanRequest;
typedef struct {
    uint32_t index, media_type, present;
    BmText codec;
    int32_t time_base_num, time_base_den;
    uint64_t packet_count, payload_bytes, corrupt_packets;
    int64_t pts_min, pts_max, dts_min, dts_max; /* ticks, not decode end */
} BmPacketSummary;
typedef struct {
    uint32_t status, inspection_level, terminal, selected_count; /* depth 2 */
    uint64_t demuxed_packets, incidental_corrupt_packets;
    BmPacketSummary selected; /* valid only when selected_count == 1 */
} BmScanResult;
BM_EXPORT uint32_t bm_scan_info_v1(uint32_t size, BmScanInfo *info);
BM_EXPORT uint32_t bm_scan_packets_v1(const BmScanRequest *request, BmScanResult **result);
BM_EXPORT void bm_scan_release_v1(BmScanResult *result);

/* Optional full audio decode, independent of probe/scan/remux ABI. Only a
 * single mono/stereo audible audio stream; no downmix/resample/video decoding.
 * Borrowed interleaved float PCM, at most 4096 frames per synchronous visit.
 * Nonzero visitor result cancels. No FFmpeg types or file paths cross the ABI. */
#define BM_PCM_FRAMES 4096u
typedef struct { uint32_t schema, request_size, result_size, max_frames; } BmPcmInfo;
typedef struct {
    BmRequest input;
    int32_t (*visit)(void *opaque, const float *samples, uint32_t frames,
                     uint32_t channels, uint32_t sample_rate);
    void *opaque;
} BmPcmRequest;
typedef struct {
    uint32_t status, complete, sample_rate, channels;
    uint64_t frames;
    BmText codec;
} BmPcmResult;
BM_EXPORT uint32_t bm_pcm_info_v1(uint32_t size, BmPcmInfo *info);
BM_EXPORT uint32_t bm_decode_audio_v1(const BmPcmRequest *request, BmPcmResult *result);

/* M5: independent optional schema, never an extension of an M1/M3 struct.
 * Rust owns a private, empty regular staging file in an exclusive directory.
 * Only this path may be written/reopened; the public destination is NOT passed.
 * No AV types, paths or codec bytes are returned. No publication occurs here. */
#define BM_UNSUPPORTED_LAYOUT 11u
typedef struct {
    uint32_t schema, request_size, result_size, scan_size;
} BmRemuxInfo;
typedef struct {
    BmRequest input;
    uint32_t media_type;
    const char *staging_path; /* borrowed NUL-terminated absolute local path; UTF-8 on Windows */
} BmRemuxRequest;
typedef struct {
    uint32_t status, stage, finalized, configuration_preserved;
    /* stages: 0 discovery, 1 contract, 2 header, 3 packets, 4 trailer,
     * 5 close, 6 configuration check, 7 complete (still unpublished). */
    BmScanResult input_scan;
} BmRemuxResult;
BM_EXPORT uint32_t bm_remux_info_v1(uint32_t size, BmRemuxInfo *info);
BM_EXPORT uint32_t bm_copy_remux_mp4_v1(const BmRemuxRequest *request, BmRemuxResult **result);
/* Additive profile capability: same negotiated layout/ownership, distinct
 * exports so an accepted MP4-only companion cannot select a different muxer. */
BM_EXPORT uint32_t bm_flac_info_v1(uint32_t size, BmRemuxInfo *info);
BM_EXPORT uint32_t bm_copy_flac_v1(const BmRemuxRequest *request, BmRemuxResult **result);
BM_EXPORT void bm_remux_release_v1(BmRemuxResult *result);
/* P1: optional, independently negotiated live H.264/AAC MPEG-TS copy muxer.
 * Descriptors/callback contexts remain borrowed until the synchronous call ends.
 * visit receives bounded TS bytes in decode order; key marks the first bytes
 * of a video random-access unit including fresh PAT/PMT. Nonzero cancels.
 * No paths, network, process, encoder or application state in this interface. */
typedef struct { uint32_t schema, request_size, result_size; } BmLiveInfo;
typedef struct {
    BmRequest video, audio;
    int64_t start_us;
    int32_t (*visit)(void *opaque, const uint8_t *bytes, uint32_t size,
                     int64_t time_us, uint32_t key);
    void *opaque;
} BmLiveRequest;
typedef struct { uint32_t status, complete; uint64_t packets, bytes; } BmLiveResult;
BM_EXPORT uint32_t bm_live_info_v1(uint32_t size, BmLiveInfo *info);
BM_EXPORT uint32_t bm_live_ts_v1(const BmLiveRequest *request, BmLiveResult *result);
typedef struct {
    uint32_t status, complete;
    uint64_t packets[2];
    int64_t first_dts[2], last_dts[2], min_pts[2], max_pts[2]; /* microseconds */
} BmLiveCheck;
BM_EXPORT uint32_t bm_live_check_v1(const BmRequest *request, uint32_t size, BmLiveCheck *result);
/* Independently negotiated L1 ABI. Audio callbacks are synchronous, with
 * bounded interleaved f32 stereo at 48 kHz. Source positions use sample units. */
typedef int32_t (*BmAudioRead)(void *, uint32_t track, int64_t start, uint32_t frames, float *out);
typedef int32_t (*BmAudioRender)(void *, BmAudioRead, void *decoder,
                               int64_t source_us, int64_t frame, uint32_t frames, float *out);
typedef struct {
    BmLiveRequest live;
    BmRequest audio[2];
    uint32_t tracks;
    BmAudioRender render;
    void *opaque;
} BmL1Request;
BM_EXPORT uint32_t bm_l1_info_v1(uint32_t size, BmLiveInfo *info);
BM_EXPORT uint32_t bm_live_l1_v1(const BmL1Request *request, BmLiveResult *result);
/* L2, the composited cast: L1 audio plus a re-encoded video stream, negotiated
 * independently of L1. EXTERNAL takes caller-encoded H.264 access units (a
 * platform hardware pipeline); H264/MPEG2 transcode l1.live.video here:
 * decode, blend the caller's overlay, encode on a constant frame grid whose
 * times are source microseconds. Overlay images are premultiplied RGBA at the
 * output size; read() leaves *generation unchanged when nothing changed. */
#define BM_L2_EXTERNAL 1u
#define BM_L2_H264 2u
#define BM_L2_MPEG2 4u
#define BM_L2_ENCODER_EXTERNAL 0u
#define BM_L2_ENCODER_MPEG2 1u
#define BM_L2_ENCODER_MF_HARDWARE 2u
#define BM_L2_ENCODER_MF_SOFTWARE 3u
#define BM_L2_ENCODER_VIDEOTOOLBOX 4u
typedef struct { uint32_t schema, request_size, result_size, kinds; } BmL2Info;
typedef struct {
    const uint8_t *data; /* Annex B; SPS/PPS precede every key unit */
    uint32_t size, key;  /* size 0: end of stream */
    int64_t pts_us, dts_us;
} BmVideoUnit;
typedef int32_t (*BmVideoNext)(void *opaque, BmVideoUnit *unit);
typedef int32_t (*BmOverlayRead)(void *opaque, uint64_t *generation, uint8_t *rgba,
                                 uint32_t width, uint32_t height);
typedef struct {
    BmL1Request l1;
    uint32_t kind;                /* exactly one BM_L2_* */
    uint32_t width, height;       /* output; transcode: the source size */
    uint32_t fps_num, fps_den;    /* frame rate cap; source rate is halved to fit */
    uint32_t bit_rate;            /* video bps */
    int64_t end_us;               /* source program end, bounds L1 audio */
    BmVideoNext next; void *video;                /* EXTERNAL */
    BmOverlayRead overlay; void *overlay_opaque;  /* transcode, optional */
} BmL2Request;
typedef struct {
    BmLiveResult live;
    uint32_t encoder, reserved;
    uint64_t frames, video_packets, overlays;
} BmL2Result;
BM_EXPORT uint32_t bm_l2_info_v1(uint32_t size, BmL2Info *info);
BM_EXPORT uint32_t bm_live_l2_v1(const BmL2Request *request, BmL2Result *result);
/* Native Signalsmith voice, never Web Audio/WASM. All calls on owning thread. */
BM_EXPORT void *bm_stretch_new_v1(void);
BM_EXPORT void bm_stretch_free_v1(void *);
BM_EXPORT uint32_t bm_stretch_latency_v1(void *);
BM_EXPORT int32_t bm_stretch_prime_v1(void *, const float *input, uint32_t frames, float semitones);
BM_EXPORT int32_t bm_stretch_process_v1(void *, const float *input, uint32_t input_frames,
                                     float *output, uint32_t output_frames, float semitones);
#if defined(_WIN32)
/* Additive Windows adapter. Duplicate a borrowed read-only disk HANDLE into
 * the companion/FFmpeg shared /MD CRT; close only that owned descriptor. */
BM_EXPORT int32_t bm_fd_from_handle_v1(void *handle);
BM_EXPORT void bm_fd_close_v1(int32_t fd);
#endif
/* T3: independently negotiated cast generator. All calls are synchronous.
 * output_kind: 0 callback TS, 1 private faststart MP4 staging file.
 * TS callbacks start at packet boundaries; key marks the first chunk of an
 * IDR group (PAT/PMT precede the video PES). Never retain borrowed bytes. */
typedef struct { uint32_t schema, request_size, result_size, start_size; } BmCastInfo;
typedef struct {
    int64_t source_start_us, timestamp_origin_us;
    int32_t profile, level;
    uint32_t width, height, has_b_frames, audio_transcoded;
} BmCastStart;
typedef struct {
    BmRequest video, audio;
    int64_t start_us;
    int32_t (*visit)(void *, const uint8_t *, uint32_t, int64_t, uint32_t);
    void *opaque;
    uint32_t output_kind;
    const char *staging_path;
    uint64_t max_bytes;
    uint32_t ts_cbr; /* 0 file VBR, 1 live CBR; independent of Rust pacing */
    int32_t (*on_start)(void *, const BmCastStart *); /* exactly once before bytes */
} BmCastRequest;
typedef struct {
    uint32_t status, complete;
    uint64_t packets, bytes;
    int32_t profile, level; /* H.264 profile_idc/level_idc, -1 if unavailable */
    uint32_t width, height, has_b_frames, audio_transcoded;
    int64_t source_start_us, duration_us, gop_us;
} BmCastResult;
BM_EXPORT uint32_t bm_cast_info_v1(uint32_t size, BmCastInfo *info);
BM_EXPORT uint32_t bm_cast_preflight_v1(const BmRequest *, BmCastResult *);
BM_EXPORT uint32_t bm_cast_mux_v1(const BmCastRequest *, BmCastResult *);

#ifdef __cplusplus
}
#endif
#endif
