/* Test-only inclusion exercises pinned AVERROR mappings and the deny callback;
 * these helpers are not extra companion exports. Real success uses Rust tests. */
#include <libavformat/avformat.h>
/* Private compile-time seam: inject only after successful real reads. This is
 * lifecycle/error handling evidence, not proof of real-media rejection. */
static unsigned reads, inject_after;
static int inject_error, inject_corrupt, stop_after;
static int *stop_flag;
static int test_read_frame(AVFormatContext *s, AVPacket *p) {
    if (inject_after && reads == inject_after && inject_error) return inject_error;
    int ret = av_read_frame(s, p);
    if (ret >= 0) {
        reads++;
        if (inject_after && reads == inject_after && inject_corrupt) p->flags |= AV_PKT_FLAG_CORRUPT;
        if (stop_after && reads == (unsigned)stop_after) *stop_flag = 1;
    }
    return ret;
}
#define av_read_frame test_read_frame
#include "probe.c"
#undef av_read_frame
#include <assert.h>
#include <stdio.h>

static int cancelled(void *opaque) { return *(int *)opaque; }

static void scan_tests(void) {
    BmScanInfo info;
    assert(bm_scan_info_v1(sizeof(info), &info) == BM_OK);
    assert(bm_scan_info_v1(sizeof(info)-1, &info) == BM_UNAVAILABLE);
    assert(info.schema == 1 && info.result_size == sizeof(BmScanResult));
    BmScanResult r = { .selected_count = 1 };
    r.selected.present = BM_SCAN_BASE;
    AVPacket *p = av_packet_alloc();
    assert(p && av_new_packet(p, 7) == 0);
    p->pts = -5; p->dts = AV_NOPTS_VALUE;
    p->flags = AV_PKT_FLAG_KEY | AV_PKT_FLAG_DISCARD;
    assert(accumulate(&r, p) == BM_OK);
    p->pts = -10; p->dts = -12; p->flags = AV_PKT_FLAG_CORRUPT;
    assert(accumulate(&r, p) == BM_OK);
    assert(r.selected.packet_count == 2 && r.selected.payload_bytes == 14);
    assert(r.selected.corrupt_packets == 1 && r.selected.pts_min == -10 && r.selected.pts_max == -5);
    assert(r.selected.dts_min == -12 && r.selected.dts_max == -12);
    p->stream_index = 1;
    assert(accumulate(&r, p) == BM_OK && r.incidental_corrupt_packets == 1);
    p->stream_index = 0;
    r.selected.payload_bytes = UINT64_MAX - 6;
    assert(accumulate(&r, p) == BM_BACKEND_FAILURE && r.selected.packet_count == 2);
    r.selected.payload_bytes = 14;
    r.selected.packet_count = UINT64_MAX;
    assert(accumulate(&r, p) == BM_BACKEND_FAILURE);
    r.selected.packet_count = 2; r.demuxed_packets = UINT64_MAX;
    assert(accumulate(&r, p) == BM_BACKEND_FAILURE);
    av_packet_free(&p);

    const char *fixture = getenv("BILIKARA_M3_SHIM_INPUT");
    if (!fixture) return; /* build --test runs arithmetic; live suite requires fixture */
    int fd = open(fixture, O_RDONLY);
    assert(fd >= 0);
    int flag = 0;
    stop_flag = &flag;
    BmScanRequest q = { .input = { fd, cancelled, &flag }, .media_type = 2 };
    const int failures[] = {AVERROR_INVALIDDATA, AVERROR(EIO), AVERROR_EXIT, -12345678};
    for (unsigned i = 0; i < sizeof(failures)/sizeof(failures[0]); i++) {
        assert(lseek(fd, 0, SEEK_SET) == 0);
        reads = 0; inject_after = 3; inject_error = failures[i];
        BmScanResult *result = NULL;
        assert(bm_scan_packets_v1(&q, &result) == BM_OK && result);
        assert(reads == 3 && result->selected.packet_count == 3);
        assert(result->status == error_status(failures[i]) && result->terminal == BM_SCAN_INCOMPLETE);
        bm_scan_release_v1(result);
    }
    inject_error = 0; inject_corrupt = 1;
    assert(lseek(fd, 0, SEEK_SET) == 0); reads = 0;
    BmScanResult *result = NULL;
    assert(bm_scan_packets_v1(&q, &result) == BM_OK);
    assert(result->terminal == BM_SCAN_EOF && result->status == BM_INVALID_MEDIA);
    assert(result->selected.corrupt_packets == 1 && result->selected.packet_count > 3);
    bm_scan_release_v1(result);
    inject_corrupt = 0; stop_after = 4;
    assert(lseek(fd, 0, SEEK_SET) == 0); reads = 0;
    assert(bm_scan_packets_v1(&q, &result) == BM_OK);
    assert(reads == 4 && result->status == BM_CANCELLED && result->terminal == BM_SCAN_INCOMPLETE);
    assert(result->selected.packet_count == 3);
    bm_scan_release_v1(result);
    close(fd);
    puts("scan shim: real reads + injected non-EOF errors/corrupt flag/cancellation passed (lifecycle evidence)");
}

int main(void) {
    scan_tests();
    assert(error_status(AVERROR_INVALIDDATA) == BM_INVALID_MEDIA);
    assert(error_status(AVERROR_EOF) == BM_INVALID_MEDIA);
    assert(error_status(AVERROR_DECODER_NOT_FOUND) == BM_UNSUPPORTED_CODEC);
    assert(error_status(AVERROR(EIO)) == BM_IO);
    assert(error_status(AVERROR(EACCES)) == BM_IO);
    assert(error_status(AVERROR(ENOMEM)) == BM_BACKEND_FAILURE);
    assert(error_status(AVERROR(EINVAL)) == BM_BACKEND_FAILURE);
    assert(error_status(AVERROR_EXIT) == BM_BACKEND_FAILURE);
    assert(error_status(AVERROR_PATCHWELCOME) == BM_BACKEND_FAILURE);
    assert(error_status(-12345678) == BM_BACKEND_FAILURE);
    BmInfo info;
    assert(bm_get_info(sizeof(info), &info) == BM_OK);
    assert(bm_get_info(sizeof(info) - 1, &info) == BM_UNAVAILABLE);
    int flag = 1;
    BmRequest request = { .fd = -1, .cancelled = cancelled, .opaque = &flag };
    BmResult *result = NULL;
    assert(bm_probe_metadata(&request, &result) == BM_OK);
    assert(result && result->status == BM_CANCELLED);
    bm_release(result);
    flag = 0;
    assert(bm_probe_metadata(&request, &result) == BM_OK);
    assert(result && result->status == BM_IO);
    bm_release(result);
    Call call = { .request = &request };
    AVFormatContext *context = avformat_alloc_context();
    assert(context);
    context->opaque = &call;
    assert(deny_open(context, NULL, "/another/local/file", AVIO_FLAG_READ, NULL) == AVERROR(EACCES));
    assert(call.denied_open);
    avformat_free_context(context);
    puts("shim: 4 groups passed (error mapping, negotiation, cancellation/cleanup, subordinate-open denial)");
    return 0;
}
