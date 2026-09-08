#include "probe.h"
#include "build_config.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/ffversion.h>
#include <libavutil/opt.h>

/* Pin the signed 9.0.1 source headers, including their actual micro versions. */
_Static_assert(LIBAVFORMAT_VERSION_INT == AV_VERSION_INT(63, 1, 101), "unreviewed avformat headers");
_Static_assert(LIBAVCODEC_VERSION_INT == AV_VERSION_INT(63, 1, 101), "unreviewed avcodec headers");
_Static_assert(LIBAVUTIL_VERSION_INT == AV_VERSION_INT(61, 1, 101), "unreviewed avutil headers");

static int text_copy(void *out, uint32_t *len, size_t capacity, const char *s) {
    size_t n = strlen(s);
    if (n > capacity) return 0;
    memcpy(out, s, n);
    *len = (uint32_t)n;
    return 1;
}
#define COPY(out, value) text_copy((out).bytes, &(out).len, sizeof((out).bytes), value)

/* Only version/configuration functions are called before this check. No AV
 * struct access is permissible on an incompatible loaded build. Exact versions
 * and configurations intentionally narrow the trusted Linux preview envelope. */
static int compatible(void) {
    return avformat_version() == LIBAVFORMAT_VERSION_INT &&
        avcodec_version() == LIBAVCODEC_VERSION_INT &&
        avutil_version() == LIBAVUTIL_VERSION_INT &&
        !strcmp(av_version_info(), FFMPEG_VERSION) &&
        !strcmp(avformat_configuration(), BM_BUILD_CONFIG) &&
        !strcmp(avcodec_configuration(), BM_BUILD_CONFIG) &&
        !strcmp(avutil_configuration(), BM_BUILD_CONFIG);
}

uint32_t bm_abi_version(void) { return BM_ABI; }

uint32_t bm_get_info(uint32_t size, BmInfo *i) {
    if (!i || size != sizeof(*i)) return BM_UNAVAILABLE;
    memset(i, 0, sizeof(*i));
    i->abi = BM_ABI;
    i->request_size = sizeof(BmRequest);
    i->result_size = sizeof(BmResult);
    i->stream_size = sizeof(BmStream);
    const uint32_t build[] = { LIBAVFORMAT_VERSION_INT, LIBAVCODEC_VERSION_INT, LIBAVUTIL_VERSION_INT };
    const uint32_t runtime[] = { avformat_version(), avcodec_version(), avutil_version() };
    memcpy(i->build_versions, build, sizeof(build));
    memcpy(i->runtime_versions, runtime, sizeof(runtime));
    if (!COPY(i->backend, "bilikara_media_libav") ||
        !COPY(i->build_version, FFMPEG_VERSION) ||
        !COPY(i->runtime_version, av_version_info()) ||
        !COPY(i->build_config, BM_BUILD_CONFIG) ||
        !COPY(i->runtime_configs[0], avformat_configuration()) ||
        !COPY(i->runtime_configs[1], avcodec_configuration()) ||
        !COPY(i->runtime_configs[2], avutil_configuration())) return BM_UNAVAILABLE;
    if (!compatible()) return BM_UNAVAILABLE;
    if (!av_find_input_format("mov") || !av_find_input_format("flac")) return BM_UNAVAILABLE;
    return BM_OK;
}

typedef struct {
    const BmRequest *request;
    int denied_open;
} Call;

static int interrupted(void *opaque) {
    const Call *call = opaque;
    return call->request->cancelled(call->request->opaque) != 0;
}

/* The primary input is already an AVIOContext on a duplicated regular-file fd.
 * Block *every* subordinate open, including another local file. */
static int deny_open(AVFormatContext *s, AVIOContext **pb, const char *url,
                     int flags, AVDictionary **options) {
    (void)pb; (void)url; (void)flags; (void)options;
    Call *call = s->opaque;
    call->denied_open = 1;
    return AVERROR(EACCES);
}

static uint32_t error_status(int code) {
    if (code == AVERROR_INVALIDDATA || code == AVERROR_EOF) return BM_INVALID_MEDIA;
    if (code == AVERROR_DECODER_NOT_FOUND) return BM_UNSUPPORTED_CODEC;
    if (code == AVERROR(EIO) || code == AVERROR(EACCES) || code == AVERROR(EPERM) ||
        code == AVERROR(EINTR) || code == AVERROR(EAGAIN) || code == AVERROR(ETIMEDOUT)) return BM_IO;
    /* EXIT without an observed user flag, EINVAL, ENOMEM, PATCHWELCOME and
     * unknown negatives are backend failures, never unsupported by default. */
    return BM_BACKEND_FAILURE;
}

static void fail(BmResult *r, uint32_t status, const char *message) {
    r->status = status;
    COPY(r->message, message);
}

static uint32_t media_type(enum AVMediaType t) {
    switch (t) {
        case AVMEDIA_TYPE_VIDEO: return 1;
        case AVMEDIA_TYPE_AUDIO: return 2;
        case AVMEDIA_TYPE_SUBTITLE: return 3;
        case AVMEDIA_TYPE_DATA: return 4;
        case AVMEDIA_TYPE_ATTACHMENT: return 5;
        default: return 0;
    }
}

static void scan_packets(AVFormatContext *s, Call *call, const BmScanRequest *q, BmScanResult *r);
static void remux_packets(AVFormatContext *s, Call *call, const BmRemuxRequest *q, BmRemuxResult *r);
static int same_decoder_config(const AVCodecParameters *a, const AVCodecParameters *b);

static uint32_t inspect(const BmRequest *q, BmResult **out,
                        const BmScanRequest *scan_request, BmScanResult *scan_result,
                        const BmRemuxRequest *remux_request, BmRemuxResult *remux_result,
                        const AVCodecParameters *expected_config) {
    if (!out) return BM_INVALID_REQUEST;
    *out = NULL;
    if (!q || !q->cancelled) return BM_INVALID_REQUEST;
    if (!compatible()) return BM_UNAVAILABLE;
    BmResult *r = calloc(1, sizeof(*r));
    if (!r) return BM_BACKEND_FAILURE;
    *out = r;
    r->inspection_level = 1;
    Call call = { .request = q };
    AVFormatContext *s = NULL;
    AVIOContext *pb = NULL;
    AVDictionary *options = NULL;
    int ret = 0;
    if (interrupted(&call)) { fail(r, BM_CANCELLED, "cancelled before discovery"); goto done; }
    struct stat st;
    if (fstat(q->fd, &st) < 0) { fail(r, BM_IO, "cannot inspect input descriptor"); goto done; }
    int flags = fcntl(q->fd, F_GETFL);
    if (!S_ISREG(st.st_mode) || flags < 0 || (flags & O_ACCMODE) != O_RDONLY) {
        fail(r, BM_INVALID_REQUEST, "input must be a read-only regular file"); goto done;
    }
    s = avformat_alloc_context();
    if (!s) { fail(r, BM_BACKEND_FAILURE, "cannot allocate format context"); goto done; }
    s->opaque = &call;
    s->interrupt_callback = (AVIOInterruptCB){ interrupted, &call };
    s->io_open = deny_open;
    s->probesize = 1024 * 1024;
    s->format_probesize = 64 * 1024;
    s->max_analyze_duration = 1000000; /* microseconds of media, not wall clock */
    s->max_probe_packets = 256;
    s->max_streams = BM_STREAMS;
    s->skip_estimate_duration_from_pts = 1;
    if ((ret = av_opt_set(s, "protocol_whitelist", "fd", 0)) < 0 ||
        (ret = av_opt_set(s, "format_whitelist", "mov,flac", 0)) < 0 ||
        (ret = av_dict_set_int(&options, "fd", q->fd, 0)) < 0 ||
        (ret = av_dict_set(&options, "protocol_whitelist", "fd", 0)) < 0) goto av_error;
    ret = avio_open2(&pb, "fd:", AVIO_FLAG_READ, &s->interrupt_callback, &options);
    if (ret < 0) goto av_error;
    if (av_dict_count(options)) { fail(r, BM_UNAVAILABLE, "required fd options not consumed"); goto done; }
    av_dict_free(&options);
    s->pb = pb;
    /* Mark ownership now, including errors before open_input is reached. */
    s->flags |= AVFMT_FLAG_CUSTOM_IO;
    const AVInputFormat *format = NULL;
    ret = av_probe_input_buffer2(pb, &format, "", NULL, 0, 64 * 1024);
    if (ret < 0) goto av_error;
    if (format != av_find_input_format("mov") && format != av_find_input_format("flac")) {
        /* Detection is only capability evidence, not validation of this file. */
        fail(r, BM_UNSUPPORTED_FORMAT, "detected format is outside the MOV/FLAC preview"); goto done;
    }
    if (format == av_find_input_format("mov")) {
        if ((ret = av_dict_set(&options, "enable_drefs", "0", 0)) < 0 ||
            (ret = av_dict_set(&options, "use_absolute_path", "0", 0)) < 0) goto av_error;
    }
    ret = avformat_open_input(&s, "", format, &options);
    if (ret < 0) goto av_error;
    if (av_dict_count(options)) { fail(r, BM_UNAVAILABLE, "required demuxer options not consumed"); goto done; }
    /* Deterministic observation point after open, using the same AVIO callback.
     * Tests may flip their flag here; this is not a hard timeout guarantee. */
    if (s->interrupt_callback.callback(s->interrupt_callback.opaque)) {
        fail(r, BM_CANCELLED, "cancelled after open_input"); goto done;
    }
    ret = avformat_find_stream_info(s, NULL);
    if (ret < 0) goto av_error;
    if (call.denied_open) { fail(r, BM_CONTRACT, "subordinate inputs are outside local-file scope"); goto done; }
    if (interrupted(&call)) { fail(r, BM_CANCELLED, "cancelled during discovery"); goto done; }
    if (!s->nb_streams) { fail(r, BM_INVALID_MEDIA, "no streams discovered"); goto done; }
    if (s->nb_streams > BM_STREAMS) { fail(r, BM_CONTRACT, "preview stream limit exceeded"); goto done; }
    if (!COPY(r->container, format == av_find_input_format("mov") ? "mov,mp4,m4a,3gp,3g2,mj2" : "flac")) {
        fail(r, BM_BACKEND_FAILURE, "container name exceeds bound"); goto done;
    }
    if (s->duration != AV_NOPTS_VALUE && s->duration >= 0) { r->present |= BM_DURATION; r->duration_us = s->duration; }
    if (s->start_time != AV_NOPTS_VALUE) { r->present |= BM_START; r->start_time_us = s->start_time; }
    if (s->bit_rate > 0) { r->present |= BM_BIT_RATE; r->bit_rate_bps = s->bit_rate; }
    r->stream_count = s->nb_streams;
    for (uint32_t j = 0; j < r->stream_count; j++) {
        const AVStream *stream = s->streams[j];
        const AVCodecParameters *p = stream->codecpar;
        BmStream *v = &r->streams[j];
        v->index = stream->index;
        v->media_type = media_type(p->codec_type);
        if (p->codec_id != AV_CODEC_ID_NONE && !COPY(v->codec, avcodec_get_name(p->codec_id))) {
            fail(r, BM_BACKEND_FAILURE, "codec name exceeds bound"); goto done;
        }
        if (stream->time_base.num > 0 && stream->time_base.den > 0) {
            v->present |= BM_TIME_BASE;
            v->time_base_num = stream->time_base.num; v->time_base_den = stream->time_base.den;
            if (stream->duration != AV_NOPTS_VALUE && stream->duration >= 0) {
                v->present |= BM_DURATION; v->duration_ticks = stream->duration;
            }
            if (stream->start_time != AV_NOPTS_VALUE) { v->present |= BM_START; v->start_ticks = stream->start_time; }
        }
        if (p->codec_type == AVMEDIA_TYPE_VIDEO) {
            if (p->width > 0) { v->present |= BM_WIDTH; v->width_px = p->width; }
            if (p->height > 0) { v->present |= BM_HEIGHT; v->height_px = p->height; }
        }
        if (p->codec_type == AVMEDIA_TYPE_AUDIO) {
            if (p->sample_rate > 0) { v->present |= BM_RATE; v->sample_rate_hz = p->sample_rate; }
            if (p->ch_layout.nb_channels > 0) { v->present |= BM_CHANNELS; v->channels = p->ch_layout.nb_channels; }
        }
        if (p->bit_rate > 0) { v->present |= BM_BIT_RATE; v->bit_rate_bps = p->bit_rate; }
        if (p->bits_per_raw_sample > 0) { v->present |= BM_RAW_BITS; v->raw_bit_depth = p->bits_per_raw_sample; }
    }
    if (expected_config && (s->nb_streams != 1 ||
        !same_decoder_config(expected_config, s->streams[0]->codecpar))) {
        fail(r, BM_INVALID_MEDIA, "finalized decoder configuration differs"); goto done;
    }
    if (scan_request) scan_packets(s, &call, scan_request, scan_result);
    if (remux_request) remux_packets(s, &call, remux_request, remux_result);
    goto done;
av_error:
    if (interrupted(&call)) fail(r, BM_CANCELLED, "cancelled during discovery");
    else if (call.denied_open) fail(r, BM_CONTRACT, "subordinate inputs are outside local-file scope");
    else {
        char message[AV_ERROR_MAX_STRING_SIZE];
        av_strerror(ret, message, sizeof(message));
        fail(r, error_status(ret), message);
    }
done:
    if (scan_result && r->status != BM_OK) scan_result->status = r->status;
    if (remux_result && r->status != BM_OK) remux_result->status = r->status;
    av_dict_free(&options);
    avformat_close_input(&s);
    avio_closep(&pb); /* fd protocol owns its dup, never the caller's fd. */
    return BM_OK;
}

uint32_t bm_probe_metadata(const BmRequest *q, BmResult **out) {
    return inspect(q, out, NULL, NULL, NULL, NULL, NULL);
}

void bm_release(BmResult *result) { free(result); }

uint32_t bm_scan_info_v1(uint32_t size, BmScanInfo *info) {
    if (!info || size != sizeof(*info) || !compatible()) return BM_UNAVAILABLE;
    *info = (BmScanInfo){BM_SCAN_SCHEMA, sizeof(BmScanRequest), sizeof(BmScanResult), sizeof(BmPacketSummary)};
    return BM_OK;
}

static void bound_timestamp(uint32_t *present, uint32_t bit, int64_t value,
                            int64_t *min, int64_t *max) {
    if (value == AV_NOPTS_VALUE) return;
    if (!(*present & bit)) { *min = *max = value; *present |= bit; }
    else { if (value < *min) *min = value; if (value > *max) *max = value; }
}

/* Transactional checked accumulation: never wrap, never retain packet storage.
 * Key/discard flags and presentation reordering are not corruption evidence. */
static uint32_t accumulate(BmScanResult *r, const AVPacket *packet) {
    BmPacketSummary *v = &r->selected;
    int selected = packet->stream_index >= 0 && (uint32_t)packet->stream_index == v->index;
    int corrupt = !!(packet->flags & AV_PKT_FLAG_CORRUPT);
    if (packet->size < 0 || r->demuxed_packets == UINT64_MAX ||
        (!selected && corrupt && r->incidental_corrupt_packets == UINT64_MAX) ||
        (selected && (v->packet_count == UINT64_MAX ||
                      v->payload_bytes > UINT64_MAX - (uint64_t)packet->size ||
                      (corrupt && v->corrupt_packets == UINT64_MAX)))) return BM_BACKEND_FAILURE;
    r->demuxed_packets++;
    if (!selected) { r->incidental_corrupt_packets += corrupt; return BM_OK; }
    v->packet_count++;
    v->payload_bytes += (uint64_t)packet->size;
    v->corrupt_packets += corrupt;
    if (v->present & BM_SCAN_BASE) {
        bound_timestamp(&v->present, BM_SCAN_PTS, packet->pts, &v->pts_min, &v->pts_max);
        bound_timestamp(&v->present, BM_SCAN_DTS, packet->dts, &v->dts_min, &v->dts_max);
    }
    return BM_OK;
}

static void scan_packets(AVFormatContext *s, Call *call, const BmScanRequest *q, BmScanResult *r) {
    AVStream *stream = NULL;
    for (unsigned i = 0; i < s->nb_streams; i++) {
        if (s->streams[i]->index >= 0 && (uint32_t)s->streams[i]->index == q->stream_index)
            stream = s->streams[i];
    }
    if (!stream || media_type(stream->codecpar->codec_type) != q->media_type) {
        r->status = BM_INVALID_REQUEST; return;
    }
    BmPacketSummary *v = &r->selected;
    v->index = q->stream_index;
    v->media_type = q->media_type;
    r->selected_count = 1;
    if (stream->codecpar->codec_id != AV_CODEC_ID_NONE &&
        !COPY(v->codec, avcodec_get_name(stream->codecpar->codec_id))) {
        r->status = BM_BACKEND_FAILURE; return;
    }
    if (stream->time_base.num > 0 && stream->time_base.den > 0) {
        v->present = BM_SCAN_BASE;
        v->time_base_num = stream->time_base.num;
        v->time_base_den = stream->time_base.den;
    }
    AVPacket *packet = av_packet_alloc();
    if (!packet) { r->status = BM_BACKEND_FAILURE; return; }
    /* find_stream_info keeps its discovery packets buffered (no NOBUFFER flag).
     * Continue on this fresh per-call context without seeking/flushing/reopening:
     * av_read_frame first drains that prefix exactly once, then reads to EOF. */
    for (;;) {
        if (interrupted(call)) { r->status = BM_CANCELLED; break; }
        int ret = av_read_frame(s, packet);
        if (interrupted(call)) { r->status = BM_CANCELLED; break; }
        if (call->denied_open) { r->status = BM_CONTRACT; break; }
        if (ret < 0) {
            /* A demuxer may return EOF while AVIO retains an I/O error. */
            if (ret == AVERROR_EOF && s->pb && s->pb->error < 0 && s->pb->error != AVERROR_EOF)
                ret = s->pb->error;
            if (ret == AVERROR_EOF) {
                r->terminal = BM_SCAN_EOF;
                r->status = (!v->packet_count || v->corrupt_packets || r->incidental_corrupt_packets)
                    ? BM_INVALID_MEDIA : BM_OK;
            } else r->status = error_status(ret);
            break;
        }
        if (packet->stream_index < 0 || (unsigned)packet->stream_index >= s->nb_streams) {
            r->status = BM_BACKEND_FAILURE; break;
        }
        r->status = accumulate(r, packet);
        av_packet_unref(packet);
        if (r->status != BM_OK) break;
    }
    av_packet_free(&packet); /* also unrefs packets on every interrupted/error exit */
}

uint32_t bm_scan_packets_v1(const BmScanRequest *q, BmScanResult **out) {
    if (!out) return BM_INVALID_REQUEST;
    *out = NULL;
    if (!q || !q->input.cancelled || (q->media_type != 1 && q->media_type != 2)) return BM_INVALID_REQUEST;
    if (!compatible()) return BM_UNAVAILABLE;
    BmScanResult *r = calloc(1, sizeof(*r));
    if (!r) return BM_BACKEND_FAILURE;
    *out = r;
    r->inspection_level = 2;
    BmResult *metadata = NULL;
    uint32_t status = inspect(&q->input, &metadata, q, r, NULL, NULL, NULL);
    bm_release(metadata);
    if (status != BM_OK) r->status = status;
    return BM_OK;
}

void bm_scan_release_v1(BmScanResult *result) { free(result); }

/* Uses the same discovery context, buffered packets, accounting and cleanup. */
#include "remux.c"
