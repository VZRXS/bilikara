/* Included by probe.c. Read-only, bounded decode using its restricted fd input.
 * The decoder applies skip_samples (gapless priming) by default. The stream's
 * presentation interval also clips encoder padding/edit-list tails. */
#include <math.h>
#include <libavutil/channel_layout.h>
#include <libavutil/samplefmt.h>

uint32_t bm_pcm_info_v1(uint32_t size, BmPcmInfo *info) {
    if (!info || size != sizeof(*info) || !compatible()) return BM_UNAVAILABLE;
    *info = (BmPcmInfo){1, sizeof(BmPcmRequest), sizeof(BmPcmResult), BM_PCM_FRAMES};
    return BM_OK;
}

static float pcm_sample(const AVFrame *f, int sample, int channel) {
    int planar = av_sample_fmt_is_planar(f->format);
    int offset = planar ? sample : sample * f->ch_layout.nb_channels + channel;
    const uint8_t *data = f->extended_data[planar ? channel : 0];
    switch (av_get_packed_sample_fmt(f->format)) {
        case AV_SAMPLE_FMT_U8: return ((const uint8_t *)data)[offset] / 128.0f - 1.0f;
        case AV_SAMPLE_FMT_S16: return ((const int16_t *)data)[offset] / 32768.0f;
        case AV_SAMPLE_FMT_S32: return (float)(((const int32_t *)data)[offset] / 2147483648.0);
        case AV_SAMPLE_FMT_FLT: return ((const float *)data)[offset];
        case AV_SAMPLE_FMT_DBL: return (float)((const double *)data)[offset];
        default: return NAN;
    }
}

static int visit_frame(const AVStream *stream, Call *call, const BmPcmRequest *q,
                       BmPcmResult *r, const AVFrame *frame) {
    if (frame->sample_rate != (int)r->sample_rate || frame->ch_layout.nb_channels != (int)r->channels ||
        frame->nb_samples <= 0 || frame->nb_samples > 1048576 || frame->decode_error_flags ||
        frame->pts == AV_NOPTS_VALUE) return BM_INVALID_MEDIA;
    AVChannelLayout expected = r->channels == 1 ? (AVChannelLayout)AV_CHANNEL_LAYOUT_MONO : (AVChannelLayout)AV_CHANNEL_LAYOUT_STEREO;
    if (av_channel_layout_compare(&frame->ch_layout, &expected)) return BM_UNSUPPORTED_LAYOUT;
    const AVRational samples = {1, (int)r->sample_rate};
    int64_t start = av_rescale_q(stream->start_time, stream->time_base, samples);
    int64_t length = av_rescale_q(stream->duration, stream->time_base, samples);
    int64_t position = av_rescale_q(frame->pts, stream->time_base, samples) - start;
    int begin = position < 0 ? (int)FFMIN((int64_t)frame->nb_samples, -position) : 0;
    int end = (int)FFMAX(0, FFMIN((int64_t)frame->nb_samples, length - position));
    if (end <= begin) return BM_OK;
    // Gaps/overlaps would need playback-specific concealment. Refuse them.
    int64_t difference = position + begin - (int64_t)r->frames;
    if (difference < -2 || difference > 2) return BM_INVALID_MEDIA;
    float buffer[BM_PCM_FRAMES * 2];
    for (int offset = begin; offset < end;) {
        if (interrupted(call)) return BM_CANCELLED;
        uint32_t count = (uint32_t)FFMIN(end - offset, (int)BM_PCM_FRAMES);
        for (uint32_t i = 0; i < count; i++) for (uint32_t c = 0; c < r->channels; c++) {
            float value = pcm_sample(frame, offset + (int)i, (int)c);
            if (!isfinite(value)) return BM_INVALID_MEDIA;
            buffer[i * r->channels + c] = value;
        }
        if (q->visit(q->opaque, buffer, count, r->channels, r->sample_rate)) return BM_CANCELLED;
        r->frames += count;
        offset += (int)count;
    }
    return BM_OK;
}

static int receive_pcm(AVCodecContext *decoder, AVFrame *frame, const AVStream *stream,
                       Call *call, const BmPcmRequest *q, BmPcmResult *r, int *terminal) {
    for (;;) {
        if (interrupted(call)) return BM_CANCELLED;
        int ret = avcodec_receive_frame(decoder, frame);
        if (ret == AVERROR(EAGAIN)) return BM_OK;
        if (ret == AVERROR_EOF) { *terminal = 1; return BM_OK; }
        if (ret < 0) return (int)error_status(ret);
        int status = visit_frame(stream, call, q, r, frame);
        av_frame_unref(frame);
        if (status != BM_OK) return status;
    }
}

static void decode_audio(AVFormatContext *s, Call *call, const BmPcmRequest *q, BmPcmResult *r) {
    AVCodecContext *decoder = NULL;
    AVPacket *packet = NULL;
    AVFrame *frame = NULL;
    int terminal = 0, ret;
    r->status = BM_UNSUPPORTED_LAYOUT;
    if (s->nb_streams != 1) goto done;
    AVStream *stream = s->streams[0];
    AVCodecParameters *p = stream->codecpar;
    if (p->codec_type != AVMEDIA_TYPE_AUDIO || p->sample_rate < 8000 || p->sample_rate > 192000 ||
        p->ch_layout.nb_channels < 1 || p->ch_layout.nb_channels > 2 ||
        stream->duration <= 0 || stream->duration == AV_NOPTS_VALUE || stream->start_time == AV_NOPTS_VALUE ||
        stream->time_base.num <= 0 || stream->time_base.den <= 0 ||
        av_q2d(stream->time_base) * (double)stream->duration > 6 * 60 * 60) goto done;
    r->sample_rate = (uint32_t)p->sample_rate; r->channels = (uint32_t)p->ch_layout.nb_channels;
    if (!COPY(r->codec, avcodec_get_name(p->codec_id))) { r->status = BM_BACKEND_FAILURE; goto done; }
    const AVCodec *codec = avcodec_find_decoder(p->codec_id);
    if (!codec) { r->status = BM_UNSUPPORTED_CODEC; goto done; }
    decoder = avcodec_alloc_context3(codec);
    if (!decoder) { r->status = BM_BACKEND_FAILURE; goto done; }
    decoder->thread_count = 1;
    decoder->pkt_timebase = stream->time_base;
    decoder->err_recognition = AV_EF_CRCCHECK | AV_EF_BITSTREAM | AV_EF_BUFFER | AV_EF_EXPLODE;
    if ((ret = avcodec_parameters_to_context(decoder, p)) < 0 || (ret = avcodec_open2(decoder, codec, NULL)) < 0) {
        r->status = error_status(ret); goto done;
    }
    packet = av_packet_alloc(); frame = av_frame_alloc();
    if (!packet || !frame) { r->status = BM_BACKEND_FAILURE; goto done; }
    uint64_t packets = 0;
    for (;;) {
        if (interrupted(call)) { r->status = BM_CANCELLED; goto done; }
        ret = av_read_frame(s, packet);
        if (ret == AVERROR_EOF) break;
        if (ret < 0) { r->status = error_status(ret); goto done; }
        if (++packets > 10000000 || packet->stream_index != 0 || packet->flags & AV_PKT_FLAG_CORRUPT) {
            r->status = BM_INVALID_MEDIA; goto done;
        }
        ret = avcodec_send_packet(decoder, packet);
        av_packet_unref(packet);
        if (ret < 0) { r->status = error_status(ret); goto done; }
        r->status = (uint32_t)receive_pcm(decoder, frame, stream, call, q, r, &terminal);
        if (r->status != BM_OK || terminal) goto done;
    }
    if (s->pb && s->pb->error < 0 && s->pb->error != AVERROR_EOF) { r->status = BM_IO; goto done; }
    ret = avcodec_send_packet(decoder, NULL);
    if (ret < 0) { r->status = error_status(ret); goto done; }
    r->status = (uint32_t)receive_pcm(decoder, frame, stream, call, q, r, &terminal);
    int64_t expected = av_rescale_q(stream->duration, stream->time_base, (AVRational){1, (int)r->sample_rate});
    // A demux EOF alone does not certify a complete artifact: also drain the
    // decoder and check its full presentation sample count (2-frame rounding).
    if (r->status == BM_OK && terminal && r->frames > 0 &&
        expected - (int64_t)r->frames >= -2 && expected - (int64_t)r->frames <= 2 && !call->denied_open && !interrupted(call)) r->complete = 1;
    else if (r->status == BM_OK) r->status = BM_INVALID_MEDIA;
done:
    av_packet_free(&packet); av_frame_free(&frame); avcodec_free_context(&decoder);
}

uint32_t bm_decode_audio_v1(const BmPcmRequest *q, BmPcmResult *r) {
    if (!q || !r || !q->visit) return BM_INVALID_REQUEST;
    memset(r, 0, sizeof(*r));
    BmResult *metadata = NULL;
    uint32_t status = inspect(&q->input, &metadata, NULL, NULL, NULL, NULL, NULL, 0, q, r);
    bm_release(metadata);
    if (status != BM_OK) r->status = status;
    return BM_OK;
}
