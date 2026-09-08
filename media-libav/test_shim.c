/* Test-only inclusion exercises pinned AVERROR mappings and the deny callback;
 * these helpers are not extra companion exports. Real success uses Rust tests. */
#include "probe.c"
#include <assert.h>
#include <stdio.h>

static int cancelled(void *opaque) { return *(int *)opaque; }

int main(void) {
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
