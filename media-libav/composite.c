/* L2: the composited cast. L1 audio with a video stream that was decoded,
 * overlaid and re-encoded. The video either arrives from the caller as encoded
 * H.264 access units (a platform hardware pipeline, e.g. Android MediaCodec)
 * or is transcoded here: source decode -> contain-fit to the output size ->
 * overlay blend -> encoder. The output runs on a constant frame grid in source
 * time, so the L1 audio, pacing and T4 timestamps stay unchanged. HOLD repeats
 * one source frame and BLANK one black frame (pause and full-frame cards of a
 * continuous cast). Rust owns the overlay image and all policy. */
#include <libavutil/imgutils.h>
#include <libavutil/time.h>

#define L2_MAX_WIDTH 1920
#define L2_MAX_HEIGHT 1088
#define L2_MAX_SOURCE_WIDTH 4096
#define L2_MAX_SOURCE_HEIGHT 2304
#define L2_MAX_UNIT (8 * 1024 * 1024)

typedef struct {
    const BmL2Request *request;
    BmL2Result *result;
    /* transcode */
    LiveInput source;
    AVCodecContext *decoder, *encoder;
    AVFrame *current, *next, *out;
    AVFrame *scaled;     /* output-size picture for fitted or full-range sources */
    int has_current, has_next, decoder_eof, flushed, pending;
    int width, height;   /* output size */
    int fit[4];          /* x, y, width, height of the picture in the output */
    int fitted[3];       /* source width, height and full range the fit is for */
    int32_t *columns;    /* luma then chroma: source x << 8 | weight per output column */
    uint8_t range[2][256]; /* luma and chroma levels into limited range */
    AVRational rate;     /* output frames per second */
    int64_t origin_us;   /* source time of output frame 0 */
    int64_t slot;        /* next output frame index */
    int64_t frame_us;    /* nominal source frame duration */
    int h264;
    uint8_t *config;     /* last in-band SPS/PPS, prepended to keys lacking it */
    int config_size;
    /* overlay, converted once per generation */
    uint64_t generation;
    uint8_t *rgba, *y, *a, *u, *v, *ac;
    int box[4];          /* even-aligned x0, y0, x1, y1; empty when x1 <= x0 */
} L2Video;

static void l2_release(LiveInput *in) {
    L2Video *s = in->state;
    if (!s) return;
    av_frame_free(&s->current); av_frame_free(&s->next); av_frame_free(&s->out); av_frame_free(&s->scaled);
    av_freep(&s->columns);
    avcodec_free_context(&s->decoder); avcodec_free_context(&s->encoder);
    live_close(&s->source);
    av_freep(&s->config);
    av_freep(&s->rgba); av_freep(&s->y); av_freep(&s->a); av_freep(&s->u); av_freep(&s->v); av_freep(&s->ac);
    av_free(s); in->state = NULL;
}

static int l2_has_nal(const uint8_t *p, int size, int type) {
    for (int i = 0; i + 3 < size; ++i)
        if (!p[i] && !p[i + 1] && p[i + 2] == 1 && (p[i + 3] & 0x1f) == type) return 1;
    return 0;
}
/* Every IDR must be decodable by a receiver joining at it. Encoders that emit
 * SPS/PPS only once get the last seen parameter sets prepended. */
static int l2_parameter_sets(L2Video *s, AVPacket *p) {
    if (!s->h264 || !(p->flags & AV_PKT_FLAG_KEY)) return 0;
    if (l2_has_nal(p->data, p->size, 7)) {
        int end = 0;
        for (int i = 0; i + 3 < p->size; ++i)
            if (!p->data[i] && !p->data[i + 1] && p->data[i + 2] == 1) {
                int type = p->data[i + 3] & 0x1f;
                if (type != 7 && type != 8 && type != 9) { end = i && !p->data[i - 1] ? i - 1 : i; break; }
            }
        if (end > 0) {
            uint8_t *copy = av_memdup(p->data, end);
            if (!copy) return AVERROR(ENOMEM);
            av_free(s->config); s->config = copy; s->config_size = end;
        }
        return 0;
    }
    const uint8_t *config = s->config;
    int size = s->config_size;
    if (!config && s->encoder && s->encoder->extradata_size > 4 &&
        (AV_RB32(s->encoder->extradata) == 1 || AV_RB24(s->encoder->extradata) == 1)) {
        config = s->encoder->extradata; size = s->encoder->extradata_size;
    }
    if (!config) return AVERROR_INVALIDDATA;
    AVPacket *joined = av_packet_alloc();
    if (!joined) return AVERROR(ENOMEM);
    int ret = av_new_packet(joined, size + p->size);
    if (ret >= 0) ret = av_packet_copy_props(joined, p);
    if (ret < 0) { av_packet_free(&joined); return ret; }
    memcpy(joined->data, config, size);
    memcpy(joined->data + size, p->data, p->size);
    av_packet_unref(p); av_packet_move_ref(p, joined); av_packet_free(&joined);
    return 0;
}

/* Premultiplied RGBA -> premultiplied Y'CbCr contributions and alpha. With
 * a = alpha/255: Y = Y_src * (1 - a) + y_p, likewise for chroma. */
static void l2_convert_overlay(L2Video *s, int width, int height) {
    const int bt709 = height >= 600;
    const double kr = bt709 ? 0.2126 : 0.299, kb = bt709 ? 0.0722 : 0.114, kg = 1 - kr - kb;
    int x0 = width, y0 = height, x1 = 0, y1 = 0;
    for (int j = 0; j < height; ++j)
        for (int i = 0; i < width; ++i) {
            const uint8_t *p = s->rgba + ((size_t)j * width + i) * 4;
            int alpha = FFMIN(p[3], 255), r = FFMIN(p[0], alpha), g = FFMIN(p[1], alpha), b = FFMIN(p[2], alpha);
            double luma = kr * r + kg * g + kb * b;
            s->y[(size_t)j * width + i] = (uint8_t)lrint(16.0 * alpha / 255 + 219.0 / 255 * luma);
            s->a[(size_t)j * width + i] = (uint8_t)alpha;
            if (alpha) { x0 = FFMIN(x0, i); y0 = FFMIN(y0, j); x1 = FFMAX(x1, i + 1); y1 = FFMAX(y1, j + 1); }
        }
    const int cw = width / 2, ch = height / 2;
    for (int j = 0; j < ch; ++j)
        for (int i = 0; i < cw; ++i) {
            double r = 0, g = 0, b = 0, alpha = 0;
            for (int n = 0; n < 4; ++n) {
                const uint8_t *p = s->rgba + ((size_t)(j * 2 + n / 2) * width + i * 2 + n % 2) * 4;
                int a = FFMIN(p[3], 255);
                alpha += a; r += FFMIN(p[0], a); g += FFMIN(p[1], a); b += FFMIN(p[2], a);
            }
            alpha /= 4; r /= 4; g /= 4; b /= 4;
            double luma = kr * r + kg * g + kb * b;
            double cb = 128.0 * alpha / 255 + 112.0 / 255 * (b - luma) / (1 - kb);
            double cr = 128.0 * alpha / 255 + 112.0 / 255 * (r - luma) / (1 - kr);
            s->u[(size_t)j * cw + i] = (uint8_t)av_clip(lrint(cb), 0, 255);
            s->v[(size_t)j * cw + i] = (uint8_t)av_clip(lrint(cr), 0, 255);
            s->ac[(size_t)j * cw + i] = (uint8_t)lrint(alpha);
        }
    if (x1 <= x0) { s->box[0] = s->box[1] = s->box[2] = s->box[3] = 0; return; }
    s->box[0] = x0 & ~1; s->box[1] = y0 & ~1;
    s->box[2] = FFMIN(width, (x1 + 1) & ~1); s->box[3] = FFMIN(height, (y1 + 1) & ~1);
}
static int l2_overlay_update(L2Video *s, int width, int height) {
    const BmL2Request *q = s->request;
    if (!q->overlay) return 0;
    uint64_t generation = s->generation;
    int32_t status = q->overlay(q->overlay_opaque, &generation, s->rgba, (uint32_t)width, (uint32_t)height);
    if (status) return status == BM_CANCELLED ? AVERROR_EXIT : AVERROR_INVALIDDATA;
    if (generation == s->generation) return 0;
    s->generation = generation;
    l2_convert_overlay(s, width, height);
    if (s->result) ++s->result->overlays;
    return 0;
}
static inline uint8_t l2_mix(uint8_t base, uint8_t alpha, uint8_t add) {
    return (uint8_t)FFMIN(255, (base * (255 - alpha) + 127) / 255 + add);
}
static void l2_blend(L2Video *s, AVFrame *f) {
    const int width = f->width;
    for (int j = s->box[1]; j < s->box[3]; ++j) {
        uint8_t *row = f->data[0] + (ptrdiff_t)j * f->linesize[0];
        const uint8_t *y = s->y + (size_t)j * width, *a = s->a + (size_t)j * width;
        for (int i = s->box[0]; i < s->box[2]; ++i) if (a[i]) row[i] = l2_mix(row[i], a[i], y[i]);
    }
    const int cw = width / 2;
    for (int j = s->box[1] / 2; j < s->box[3] / 2; ++j) {
        uint8_t *u = f->data[1] + (ptrdiff_t)j * f->linesize[1], *v = f->data[2] + (ptrdiff_t)j * f->linesize[2];
        const uint8_t *pu = s->u + (size_t)j * cw, *pv = s->v + (size_t)j * cw, *a = s->ac + (size_t)j * cw;
        for (int i = s->box[0] / 2; i < s->box[2] / 2; ++i)
            if (a[i]) { u[i] = l2_mix(u[i], a[i], pu[i]); v[i] = l2_mix(v[i], a[i], pv[i]); }
    }
}

/* Contain-fit (black bars) of a source picture in the output, even-aligned. */
static int l2_refit(L2Video *s, int sw, int sh, int full) {
    const double scale = FFMIN((double)s->width / sw, (double)s->height / sh);
    const int w = av_clip((int)lrint(sw * scale / 2) * 2, 2, s->width);
    const int h = av_clip((int)lrint(sh * scale / 2) * 2, 2, s->height);
    s->fit[0] = ((s->width - w) / 2) & ~1; s->fit[1] = ((s->height - h) / 2) & ~1;
    s->fit[2] = w; s->fit[3] = h;
    av_freep(&s->columns);
    s->columns = av_malloc_array((size_t)w + w / 2, sizeof(*s->columns));
    if (!s->columns) return AVERROR(ENOMEM);
    const int widths[2][2] = {{sw, w}, {(sw + 1) / 2, w / 2}};
    for (int plane = 0, offset = 0; plane < 2; offset += widths[plane][1], ++plane)
        for (int i = 0; i < widths[plane][1]; ++i) {
            int64_t f = (int64_t)(2 * i + 1) * widths[plane][0] * 256 / (2 * widths[plane][1]) - 128;
            s->columns[offset + i] = (int32_t)av_clip64(f, 0, (int64_t)(widths[plane][0] - 1) << 8);
        }
    for (int v = 0; v < 256; ++v) {
        s->range[0][v] = full ? (uint8_t)(16 + (v * 219 + 127) / 255) : (uint8_t)v;
        s->range[1][v] = full ? (uint8_t)av_clip(128 + (int)lrint((v - 128) * 224.0 / 255), 0, 255) : (uint8_t)v;
    }
    s->fitted[0] = sw; s->fitted[1] = sh; s->fitted[2] = full;
    return 0;
}
/* Bilinear, 8-bit weights; output rows/columns sample at their centres. */
static void l2_scale_plane(const uint8_t *src, ptrdiff_t stride, int sw, int sh, uint8_t *dst,
                           ptrdiff_t out_stride, int dw, int dh, const int32_t *columns, const uint8_t *levels) {
    for (int j = 0; j < dh; ++j) {
        const int64_t f = av_clip64((int64_t)(2 * j + 1) * sh * 256 / (2 * dh) - 128, 0, (int64_t)(sh - 1) << 8);
        const int y0 = (int)(f >> 8), wy = (int)(f & 255);
        const uint8_t *r0 = src + y0 * stride, *r1 = src + FFMIN(y0 + 1, sh - 1) * stride;
        uint8_t *out = dst + j * out_stride;
        for (int i = 0; i < dw; ++i) {
            const int x0 = columns[i] >> 8, wx = columns[i] & 255, x1 = FFMIN(x0 + 1, sw - 1);
            const int top = r0[x0] * (256 - wx) + r0[x1] * wx, bottom = r1[x0] * (256 - wx) + r1[x1] * wx;
            out[i] = levels[(top * (256 - wy) + bottom * wy + 32768) >> 16];
        }
    }
}
/* s->out: the source picture at the output size, limited range, writable
 * when an overlay will be blended into it. */
static int l2_output(L2Video *s, const AVFrame *src) {
    const int full = src->format == AV_PIX_FMT_YUVJ420P || src->color_range == AVCOL_RANGE_JPEG;
    av_frame_unref(s->out);
    int ret;
    if (src->width == s->width && src->height == s->height && !full) {
        ret = av_frame_ref(s->out, src);
        if (ret < 0) return ret;
        s->out->format = AV_PIX_FMT_YUV420P;
        return s->box[2] > s->box[0] ? av_frame_make_writable(s->out) : 0;
    }
    if (src->width != s->fitted[0] || src->height != s->fitted[1] || full != s->fitted[2]) {
        ret = l2_refit(s, src->width, src->height, full);
        if (ret < 0) return ret;
    }
    ret = av_frame_make_writable(s->scaled);
    if (ret < 0) return ret;
    AVFrame *f = s->scaled;
    for (int j = 0; j < s->height; ++j) memset(f->data[0] + j * f->linesize[0], 16, s->width);
    for (int plane = 1; plane < 3; ++plane)
        for (int j = 0; j < s->height / 2; ++j) memset(f->data[plane] + j * f->linesize[plane], 128, s->width / 2);
    const int x = s->fit[0], y = s->fit[1], w = s->fit[2], h = s->fit[3];
    l2_scale_plane(src->data[0], src->linesize[0], src->width, src->height,
                   f->data[0] + y * f->linesize[0] + x, f->linesize[0], w, h, s->columns, s->range[0]);
    for (int plane = 1; plane < 3; ++plane)
        l2_scale_plane(src->data[plane], src->linesize[plane], (src->width + 1) / 2, (src->height + 1) / 2,
                       f->data[plane] + y / 2 * f->linesize[plane] + x / 2, f->linesize[plane], w / 2, h / 2,
                       s->columns + w, s->range[1]);
    return av_frame_ref(s->out, f);
}

/* One decoded frame into s->next; 0 at the end of the source. */
static int l2_decode(L2Video *s) {
    for (;;) {
        if (interrupted(&s->source.call)) return AVERROR_EXIT;
        int ret = avcodec_receive_frame(s->decoder, s->next);
        if (ret >= 0) {
            AVFrame *f = s->next;
            if (f->pts == AV_NOPTS_VALUE) f->pts = f->best_effort_timestamp;
            if (f->pts == AV_NOPTS_VALUE || f->width != s->decoder->width || f->height != s->decoder->height ||
                (f->format != AV_PIX_FMT_YUV420P && f->format != AV_PIX_FMT_YUVJ420P) || f->decode_error_flags) {
                av_frame_unref(f); return AVERROR_INVALIDDATA;
            }
            f->pts = live_time(&s->source, f->pts);
            return 1;
        }
        if (ret == AVERROR_EOF) return 0;
        if (ret != AVERROR(EAGAIN)) return ret;
        ret = live_read(&s->source);
        if (ret < 0) return ret;
        ret = avcodec_send_packet(s->decoder, ret ? s->source.packet : NULL);
        if (ret < 0 && ret != AVERROR_EOF) return ret;
    }
}
/* Advance so s->current is the source frame shown at time t: the latest one
 * whose pts <= t. Returns 0 once t is past the last frame's display time. */
static int l2_frame_at(L2Video *s, int64_t t) {
    for (;;) {
        if (!s->has_next && !s->decoder_eof) {
            int ret = l2_decode(s);
            if (ret < 0) return ret;
            if (!ret) s->decoder_eof = 1; else s->has_next = 1;
        }
        if (s->has_next && (!s->has_current || s->next->pts <= t)) {
            if (s->has_current && s->next->pts <= s->current->pts) return AVERROR_INVALIDDATA;
            av_frame_unref(s->current); av_frame_move_ref(s->current, s->next);
            s->has_current = 1; s->has_next = 0;
            continue;
        }
        if (!s->has_current) return 0;
        int64_t shown = s->current->duration > 0 ? av_rescale_q(s->current->duration, s->source.format->streams[0]->time_base, AV_TIME_BASE_Q) : s->frame_us;
        return s->has_next || t < s->current->pts + FFMAX(shown, 1) ? 1 : 0;
    }
}
static int64_t l2_slot_time(const L2Video *s, int64_t slot) {
    return s->origin_us + av_rescale_q(slot, av_inv_q(s->rate), AV_TIME_BASE_Q);
}
static int l2_transcode_next(LiveInput *in) {
    L2Video *s = in->state;
    for (;;) {
        if (interrupted(&in->call)) return AVERROR_EXIT;
        int ret = avcodec_receive_packet(s->encoder, in->packet);
        if (ret >= 0) {
            AVPacket *p = in->packet;
            if (p->pts == AV_NOPTS_VALUE || p->dts == AV_NOPTS_VALUE) return AVERROR_INVALIDDATA;
            p->pts = l2_slot_time(s, av_rescale_q(p->pts, s->encoder->time_base, av_inv_q(s->rate)));
            p->dts = l2_slot_time(s, av_rescale_q(p->dts, s->encoder->time_base, av_inv_q(s->rate)));
            p->duration = av_rescale_q(1, av_inv_q(s->rate), AV_TIME_BASE_Q);
            ret = l2_parameter_sets(s, p);
            if (ret < 0) return ret;
            if (s->result) ++s->result->video_packets;
            return 1;
        }
        if (ret == AVERROR_EOF) { in->eof = 1; return 0; }
        if (ret != AVERROR(EAGAIN) || s->flushed) return ret < 0 ? ret : AVERROR_BUG;
        /* An encoder may refuse input until it has emitted output (async
         * Media Foundation transforms); keep the frame and retry. */
        if (s->pending) {
            ret = avcodec_send_frame(s->encoder, s->out);
            if (ret == AVERROR(EAGAIN)) { av_usleep(1000); continue; }
            if (ret < 0) return ret;
            s->pending = 0;
            if (s->result) ++s->result->frames;
            continue;
        }
        /* HOLD and BLANK repeat their one picture until the end. */
        ret = s->request->source == BM_L2_SOURCE_PLAY ? l2_frame_at(s, l2_slot_time(s, s->slot)) : s->has_current;
        if (ret < 0) return ret;
        if (!ret || l2_slot_time(s, s->slot) >= s->request->end_us) {
            s->flushed = 1; ret = avcodec_send_frame(s->encoder, NULL);
            if (ret < 0) return ret;
            continue;
        }
        ret = l2_overlay_update(s, s->width, s->height);
        if (ret < 0) return ret;
        ret = l2_output(s, s->current);
        if (ret < 0) return ret;
        s->out->pict_type = AV_PICTURE_TYPE_NONE;
        if (s->box[2] > s->box[0]) l2_blend(s, s->out);
        s->out->pts = s->slot++;
        s->out->duration = 1;
        s->out->time_base = av_inv_q(s->rate);
        ret = avcodec_send_frame(s->encoder, s->out);
        if (ret == AVERROR(EAGAIN)) { s->pending = 1; continue; }
        if (ret < 0) return ret;
        if (s->result) ++s->result->frames;
    }
}

/* Output rate: the source rate, halved until it is at most the requested cap. */
static AVRational l2_rate(AVRational source, AVRational cap) {
    if (source.num <= 0 || source.den <= 0 || av_q2d(source) > 240) source = (AVRational){30, 1};
    while (av_cmp_q(source, cap) > 0) source = av_mul_q(source, (AVRational){1, 2});
    return source;
}
/* color: the source's tags, or NULL for a generated picture. */
static uint32_t l2_encoder(L2Video *s, const AVCodecParameters *color) {
    const BmL2Request *q = s->request;
    static const struct { const char *name; const char *options; uint32_t id; } h264[] = {
        {"h264_mf", "hw_encoding=1:scenario=live_streaming:rate_control=cbr", BM_L2_ENCODER_MF_HARDWARE},
        {"h264_mf", "scenario=live_streaming:rate_control=cbr", BM_L2_ENCODER_MF_SOFTWARE},
        {"h264_videotoolbox", "realtime=1", BM_L2_ENCODER_VIDEOTOOLBOX},
    };
    static const struct { const char *name; const char *options; uint32_t id; } mpeg2[] = {
        {"mpeg2video", "", BM_L2_ENCODER_MPEG2},
    };
    const int count = q->kind == BM_L2_H264 ? FF_ARRAY_ELEMS(h264) : FF_ARRAY_ELEMS(mpeg2);
    const int hd = s->height >= 600;
    int ret = AVERROR_ENCODER_NOT_FOUND;
    for (int n = 0; n < count; ++n) {
        const char *name = q->kind == BM_L2_H264 ? h264[n].name : mpeg2[n].name;
        const char *options = q->kind == BM_L2_H264 ? h264[n].options : mpeg2[n].options;
        const AVCodec *codec = avcodec_find_encoder_by_name(name);
        if (!codec) continue;
        AVCodecContext *e = avcodec_alloc_context3(codec);
        if (!e) return BM_BACKEND_FAILURE;
        e->width = s->width; e->height = s->height;
        e->pix_fmt = AV_PIX_FMT_YUV420P;
        /* Output pictures are always limited range (l2_output converts). */
        e->color_range = AVCOL_RANGE_MPEG;
        if (color && color->color_space != AVCOL_SPC_UNSPECIFIED) {
            e->color_primaries = color->color_primaries; e->color_trc = color->color_trc; e->colorspace = color->color_space;
        } else {
            e->color_primaries = hd ? AVCOL_PRI_BT709 : AVCOL_PRI_SMPTE170M;
            e->color_trc = hd ? AVCOL_TRC_BT709 : AVCOL_TRC_SMPTE170M;
            e->colorspace = hd ? AVCOL_SPC_BT709 : AVCOL_SPC_SMPTE170M;
        }
        e->sample_aspect_ratio = (AVRational){1, 1};
        e->framerate = s->rate; e->time_base = av_inv_q(s->rate);
        e->gop_size = FFMAX(1, (int)lrint(av_q2d(s->rate)));
        e->max_b_frames = 0;
        e->bit_rate = q->bit_rate;
        /* Bounded VBR for MPEG-2 (its CBR needs min == max and stuffing);
         * Media Foundation applies its own CBR from the options below. */
        if (q->kind == BM_L2_MPEG2) { e->rc_max_rate = q->bit_rate / 2 * 3; e->rc_buffer_size = q->bit_rate; }
        if (q->kind == BM_L2_H264) e->profile = AV_PROFILE_H264_HIGH;
        e->thread_count = 1;
        AVDictionary *dict = NULL;
        ret = av_dict_parse_string(&dict, options, "=", ":", 0);
        if (ret >= 0) ret = avcodec_open2(e, codec, &dict);
        av_dict_free(&dict);
        if (ret >= 0) { s->encoder = e; s->h264 = q->kind == BM_L2_H264; if (s->result) s->result->encoder = q->kind == BM_L2_H264 ? h264[n].id : mpeg2[n].id; return BM_OK; }
        avcodec_free_context(&e);
    }
    return ret == AVERROR_ENCODER_NOT_FOUND ? BM_UNAVAILABLE : error_status(ret);
}
static uint32_t l2_frame_buffer(AVFrame *f, int width, int height) {
    f->format = AV_PIX_FMT_YUV420P; f->width = width; f->height = height;
    f->color_range = AVCOL_RANGE_MPEG;
    return av_frame_get_buffer(f, 0) < 0 ? BM_BACKEND_FAILURE : BM_OK;
}
/* The output picture before any overlay: decoded source frames, or one black
 * frame for BLANK. Pictures of any size are contain-fitted to the output. */
static uint32_t l2_transcode_open(LiveInput *in, L2Video *s, const BmL2Request *q) {
    if (q->width < 16 || q->height < 16 || q->width > L2_MAX_WIDTH || q->height > L2_MAX_HEIGHT ||
        (q->width & 1) || (q->height & 1)) return BM_UNSUPPORTED_LAYOUT;
    s->width = (int)q->width; s->height = (int)q->height;
    s->current = av_frame_alloc(); s->next = av_frame_alloc(); s->out = av_frame_alloc(); s->scaled = av_frame_alloc();
    if (!s->current || !s->next || !s->out || !s->scaled || l2_frame_buffer(s->scaled, s->width, s->height))
        return BM_BACKEND_FAILURE;
    const AVCodecParameters *color = NULL;
    int64_t start_time = 0;
    if (q->source == BM_L2_SOURCE_BLANK) {
        s->rate = l2_rate((AVRational){(int)q->fps_num, (int)q->fps_den}, (AVRational){(int)q->fps_num, (int)q->fps_den});
        if (l2_frame_buffer(s->current, s->width, s->height)) return BM_BACKEND_FAILURE;
        for (int j = 0; j < s->height; ++j) memset(s->current->data[0] + j * s->current->linesize[0], 16, s->width);
        for (int plane = 1; plane < 3; ++plane)
            for (int j = 0; j < s->height / 2; ++j) memset(s->current->data[plane] + j * s->current->linesize[plane], 128, s->width / 2);
        s->has_current = 1; s->decoder_eof = 1;
        s->origin_us = q->l1.live.start_us;
    } else {
        uint32_t status = live_open(&s->source, &q->l1.live.video, AVMEDIA_TYPE_VIDEO, AV_CODEC_ID_NONE, "mov");
        if (status) return status;
        AVStream *source = s->source.format->streams[0];
        const AVCodecParameters *par = source->codecpar;
        if (par->width <= 0 || par->height <= 0 || par->width > L2_MAX_SOURCE_WIDTH || par->height > L2_MAX_SOURCE_HEIGHT)
            return BM_UNSUPPORTED_LAYOUT;
        color = par;
        if (q->l1.live.start_us > 0) {
            int ret = av_seek_frame(s->source.format, 0, av_rescale_q(q->l1.live.start_us, AV_TIME_BASE_Q, source->time_base), AVSEEK_FLAG_BACKWARD);
            if (ret < 0) return error_status(ret);
        }
        const AVCodec *codec = avcodec_find_decoder(par->codec_id);
        if (!codec) return BM_UNSUPPORTED_CODEC;
        s->decoder = avcodec_alloc_context3(codec);
        if (!s->decoder) return BM_BACKEND_FAILURE;
        int ret = avcodec_parameters_to_context(s->decoder, par);
        if (ret < 0) return error_status(ret);
        s->decoder->pkt_timebase = source->time_base;
        s->decoder->thread_count = 4;
        s->decoder->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
        ret = avcodec_open2(s->decoder, codec, NULL);
        if (ret < 0) return error_status(ret);
        AVRational source_rate = source->avg_frame_rate.num > 0 ? source->avg_frame_rate : source->r_frame_rate;
        s->rate = l2_rate(source_rate, (AVRational){(int)q->fps_num, (int)q->fps_den});
        s->frame_us = source_rate.num > 0 ? av_rescale_q(1, av_inv_q(source_rate), AV_TIME_BASE_Q) : 33333;
        /* Drop frames before the requested start; frame 0 is the first one at or after it. */
        for (;;) {
            ret = l2_decode(s);
            if (ret < 0) return interrupted(&s->source.call) ? BM_CANCELLED : error_status(ret);
            if (!ret) return BM_INVALID_MEDIA;
            if (s->next->pts >= q->l1.live.start_us) break;
            av_frame_unref(s->next);
        }
        s->has_next = 1;
        s->origin_us = s->next->pts;
        if (q->source == BM_L2_SOURCE_HOLD) {
            av_frame_move_ref(s->current, s->next);
            s->has_current = 1; s->has_next = 0; s->decoder_eof = 1;
        }
        start_time = source->start_time == AV_NOPTS_VALUE ? 0 : av_rescale_q(source->start_time, source->time_base, AV_TIME_BASE_Q);
    }
    uint32_t status = l2_encoder(s, color);
    if (status) return status;
    const size_t pixels = (size_t)s->width * s->height;
    s->rgba = av_mallocz(pixels * 4);
    s->y = av_mallocz(pixels); s->a = av_mallocz(pixels);
    s->u = av_mallocz(pixels / 4); s->v = av_mallocz(pixels / 4); s->ac = av_mallocz(pixels / 4);
    if (!s->rgba || !s->y || !s->a || !s->u || !s->v || !s->ac) return BM_BACKEND_FAILURE;
    in->next = l2_transcode_next;
    AVStream *stream = avformat_new_stream(in->format, NULL);
    if (!stream) return BM_BACKEND_FAILURE;
    int ret = avcodec_parameters_from_context(stream->codecpar, s->encoder);
    if (ret < 0) return error_status(ret);
    stream->time_base = AV_TIME_BASE_Q;
    stream->start_time = start_time;
    stream->duration = q->end_us - FFMAX(0, start_time);
    in->format->bit_rate = q->bit_rate;
    return BM_OK;
}

static int l2_external_next(LiveInput *in) {
    L2Video *s = in->state;
    const BmL2Request *q = s->request;
    BmVideoUnit unit = {0};
    int32_t status = q->next(q->video, &unit);
    if (status) return status == BM_CANCELLED ? AVERROR_EXIT : AVERROR_INVALIDDATA;
    if (!unit.size) { in->eof = 1; return 0; }
    if (!unit.data || unit.size > L2_MAX_UNIT || unit.key > 1 || unit.pts_us < unit.dts_us ||
        unit.dts_us < -INT64_C(604800000000) || unit.pts_us > INT64_C(604800000000) ||
        (AV_RB32(unit.data) != 1 && AV_RB24(unit.data) != 1)) return AVERROR_INVALIDDATA;
    int ret = av_new_packet(in->packet, (int)unit.size);
    if (ret < 0) return ret;
    memcpy(in->packet->data, unit.data, unit.size);
    in->packet->pts = unit.pts_us; in->packet->dts = unit.dts_us;
    in->packet->flags = unit.key ? AV_PKT_FLAG_KEY : 0;
    in->packet->stream_index = 0;
    if (unit.key && !l2_has_nal(unit.data, (int)unit.size, 7)) return AVERROR_INVALIDDATA;
    if (s->result) ++s->result->video_packets;
    return 1;
}
static uint32_t l2_external_open(LiveInput *in, const BmL2Request *q) {
    if (!q->next || !q->width || !q->height || q->width > 4096 || q->height > 4096) return BM_INVALID_REQUEST;
    in->next = l2_external_next;
    AVStream *stream = avformat_new_stream(in->format, NULL);
    if (!stream) return BM_BACKEND_FAILURE;
    stream->codecpar->codec_type = AVMEDIA_TYPE_VIDEO;
    stream->codecpar->codec_id = AV_CODEC_ID_H264;
    stream->codecpar->width = (int)q->width; stream->codecpar->height = (int)q->height;
    stream->time_base = AV_TIME_BASE_Q;
    stream->start_time = 0;
    stream->duration = q->end_us;
    in->format->bit_rate = q->bit_rate;
    return BM_OK;
}

static uint32_t l2_video_open(LiveInput *in, const BmL2Request *q, BmL2Result *result) {
    in->call.request = &q->l1.live.video;
    if (interrupted(&in->call)) return BM_CANCELLED;
    L2Video *s = av_mallocz(sizeof(*s));
    if (!s) return BM_BACKEND_FAILURE;
    in->state = s; in->release = l2_release;
    s->request = q; s->result = result;
    s->source.call.request = &q->l1.live.video;
    in->packet = av_packet_alloc();
    in->format = avformat_alloc_context();
    if (!in->packet || !in->format) return BM_BACKEND_FAILURE;
    return q->kind == BM_L2_EXTERNAL ? l2_external_open(in, q) : l2_transcode_open(in, s, q);
}

uint32_t bm_l2_info_v1(uint32_t size, BmL2Info *info) {
    BmLiveInfo base;
    if (!info || size != sizeof(*info) || bm_l1_info_v1(sizeof(base), &base)) return BM_UNAVAILABLE;
    uint32_t kinds = BM_L2_EXTERNAL;
    if (avcodec_find_encoder_by_name("h264_mf") || avcodec_find_encoder_by_name("h264_videotoolbox")) kinds |= BM_L2_H264;
    if (avcodec_find_encoder_by_name("mpeg2video")) kinds |= BM_L2_MPEG2;
    *info = (BmL2Info){1, sizeof(BmL2Request), sizeof(BmL2Result), kinds};
    return BM_OK;
}
uint32_t bm_live_l2_v1(const BmL2Request *q, BmL2Result *r) {
    BmL2Info info;
    if (!r) return BM_INVALID_REQUEST;
    memset(r, 0, sizeof(*r));
    if (!q || !q->l1.render || q->l1.tracks > 2 || (!q->l1.tracks && q->source == BM_L2_SOURCE_PLAY) ||
        q->source > BM_L2_SOURCE_BLANK || q->reserved || q->end_us <= 0 || q->end_us > INT64_C(21600000000) ||
        !q->bit_rate || q->bit_rate > 100000000 || !q->fps_num || !q->fps_den || q->fps_num > 240 * q->fps_den ||
        (q->kind != BM_L2_EXTERNAL && q->kind != BM_L2_H264 && q->kind != BM_L2_MPEG2)) return BM_INVALID_REQUEST;
    if (bm_l2_info_v1(sizeof(info), &info)) return BM_UNAVAILABLE;
    if (!(info.kinds & q->kind)) { r->live.status = BM_UNAVAILABLE; return BM_OK; }
    return live_mux(&q->l1.live, &q->l1, q, r, &r->live);
}
