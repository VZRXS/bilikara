/* Private M5 implementation, included only by probe.c (and its test TU).
 * API authority: installed 9.0.1 headers, codec_par.c, packet.c, mux.c,
 * movenc.c, mux_utils.c, flacenc.c, flacdec.c. No encoder/BSF/tag-copy path. */
#include <limits.h>
#include <libavutil/intreadwrite.h>

typedef struct {
    Call *input;
    const char *path;
    int denied_open, close_error;
} RemuxOutput;

static int output_interrupted(void *opaque) {
    return interrupted(((RemuxOutput *)opaque)->input);
}

/* 9.0.1 faststart uses s->io_open(s->url, READ) for its second pass.
 * This permission belongs only to this output context, never the input. */
static int reopen_staging(AVFormatContext *s, AVIOContext **pb, const char *url,
                          int flags, AVDictionary **options) {
    (void)options;
    RemuxOutput *o = s->opaque;
    if (flags != AVIO_FLAG_READ || strcmp(url, o->path)) {
        o->denied_open = 1;
        return AVERROR(EACCES);
    }
    AVDictionary *opts = NULL;
    int ret = av_dict_set(&opts, "protocol_whitelist", "file", 0);
    if (ret >= 0) ret = avio_open2(pb, url, flags, &s->interrupt_callback, &opts);
    av_dict_free(&opts);
    return ret;
}

static int close_staging_read(AVFormatContext *s, AVIOContext *pb) {
    RemuxOutput *o = s->opaque;
    /* shift_data doesn't propagate every read error itself. Preserve AVIO's
     * error before close, even if closing the descriptor succeeds. */
    int prior = pb->error;
    int ret = avio_close(pb);
    if (prior < 0 && prior != AVERROR_EOF) ret = prior;
    if (ret < 0) o->close_error = ret;
    return ret;
}

static int same_decoder_config(const AVCodecParameters *a, const AVCodecParameters *b) {
    return a->codec_type == b->codec_type && a->codec_id == b->codec_id &&
        a->extradata_size > 0 && a->extradata_size == b->extradata_size &&
        a->extradata && b->extradata && !memcmp(a->extradata, b->extradata, a->extradata_size) &&
        a->width == b->width && a->height == b->height &&
        a->sample_rate == b->sample_rate &&
        (a->codec_id != AV_CODEC_ID_FLAC || a->bits_per_raw_sample == b->bits_per_raw_sample) &&
        av_channel_layout_compare(&a->ch_layout, &b->ch_layout) == 0;
}

/* mov_read_dfla exposes exactly the 34-byte STREAMINFO; flacenc uses it
 * unchanged. Only decoding parameters/mandatory block bounds are checked.
 * Frame sizes, total samples and MD5 may be unknown (zero); never invent them. */
static int flac_configuration(const AVCodecParameters *p) {
    if (!p->extradata || p->extradata_size != 34) return 0;
    const uint8_t *v = p->extradata;
    uint64_t packed = AV_RB64(v + 10);
    return AV_RB16(v) >= 16 && AV_RB16(v + 2) >= AV_RB16(v) &&
        p->sample_rate > 0 && (int)(packed >> 44) == p->sample_rate &&
        (int)((packed >> 41) & 7) + 1 == p->ch_layout.nb_channels &&
        p->bits_per_raw_sample >= 4 &&
        (int)((packed >> 36) & 31) + 1 == p->bits_per_raw_sample;
}

static uint32_t output_error(int code) {
    /* A write/trailer/close error describes the output, never invalid input. */
    if (code == AVERROR(EIO) || code == AVERROR(ENOSPC) ||
#ifdef EDQUOT
        code == AVERROR(EDQUOT) ||
#endif
        code == AVERROR(EFBIG) || code == AVERROR(EROFS) || code == AVERROR(EPIPE) ||
        code == AVERROR(EBADF) || code == AVERROR(ENOENT)) return BM_IO;
    uint32_t status = error_status(code);
    return status == BM_INVALID_MEDIA ? BM_BACKEND_FAILURE : status;
}

static void remux_packets(AVFormatContext *s, Call *call, const BmRemuxRequest *q, BmRemuxResult *r, int flac) {
    AVFormatContext *out = NULL;
    AVPacket *packet = NULL;
    AVCodecParameters *configuration = NULL;
    AVDictionary *options = NULL;
    RemuxOutput io = { .input = call, .path = q->staging_path };
    int ret = 0, close_ret = 0;
    r->stage = 1;
    if (s->iformat != av_find_input_format("mov")) { r->status = BM_UNSUPPORTED_FORMAT; goto done; }
    if (s->nb_streams != 1 || media_type(s->streams[0]->codecpar->codec_type) != q->media_type ||
        (flac && q->media_type != 2)) {
        r->status = BM_CONTRACT; goto done;
    }
    AVStream *in = s->streams[0];
    const AVCodecParameters *par = in->codecpar;
    if (flac ? par->codec_id != AV_CODEC_ID_FLAC :
        ((q->media_type == 1 && par->codec_id != AV_CODEC_ID_H264) ||
         (q->media_type == 2 && par->codec_id != AV_CODEC_ID_AAC))) {
        r->status = BM_UNSUPPORTED_CODEC; goto done;
    }
    if (!par->extradata || par->extradata_size <= 0) { r->status = BM_INVALID_MEDIA; goto done; }
    if (flac && !flac_configuration(par)) { r->status = BM_INVALID_MEDIA; goto done; }
    if (flac && ((in->start_time != AV_NOPTS_VALUE && in->start_time != 0) ||
        par->initial_padding || par->trailing_padding || par->seek_preroll)) {
        r->status = BM_UNSUPPORTED_LAYOUT; goto done;
    }
    if (in->time_base.num <= 0 || in->time_base.den <= 0) {
        r->status = BM_UNSUPPORTED_LAYOUT; goto done;
    }
    /* Demuxers may update in->codecpar during reads. Freeze the initial full
     * configuration so a later NEW_EXTRADATA cannot redefine what we promise
     * to preserve, or silently pass the final comparison against itself. */
    configuration = avcodec_parameters_alloc();
    if (!configuration || avcodec_parameters_copy(configuration, par) < 0) {
        r->status = BM_BACKEND_FAILURE; goto done;
    }
    par = configuration;
    if (av_packet_side_data_get(par->coded_side_data, par->nb_coded_side_data, AV_PKT_DATA_ENCRYPTION_INIT_INFO)) {
        r->status = BM_UNSUPPORTED_LAYOUT; goto done;
    }
#ifdef _WIN32
    uint32_t output_status = bm_empty_distinct_output(q->input.fd, q->staging_path);
    if (output_status) { r->status = output_status; goto done; }
#else
    struct stat input_stat, output_stat;
    if (fstat(q->input.fd, &input_stat) || stat(q->staging_path, &output_stat)) {
        r->status = BM_IO; goto done;
    }
    if (!S_ISREG(output_stat.st_mode) || output_stat.st_size != 0 ||
        (input_stat.st_dev == output_stat.st_dev && input_stat.st_ino == output_stat.st_ino)) {
        r->status = BM_INVALID_REQUEST; goto done;
    }
#endif
    BmScanResult *scan = &r->input_scan;
    scan->inspection_level = 2; scan->selected_count = 1;
    scan->selected.index = in->index; scan->selected.media_type = q->media_type;
    scan->selected.present = BM_SCAN_BASE;
    scan->selected.time_base_num = in->time_base.num;
    scan->selected.time_base_den = in->time_base.den;
    if (!COPY(scan->selected.codec, avcodec_get_name(par->codec_id))) {
        r->status = BM_BACKEND_FAILURE; goto done;
    }
    r->stage = 2;
    ret = avformat_alloc_output_context2(&out, NULL, flac ? "flac" : "mp4", q->staging_path);
    if (ret < 0 || !out) { r->status = BM_BACKEND_FAILURE; goto done; }
    out->opaque = &io;
    out->interrupt_callback = (AVIOInterruptCB){ output_interrupted, &io };
    out->io_open = reopen_staging;
    out->io_close2 = close_staging_read;
    out->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED;
    out->flags &= ~AVFMT_FLAG_AUTO_BSF;
    AVStream *dst = avformat_new_stream(out, NULL);
    if (!dst) { r->status = BM_BACKEND_FAILURE; goto done; }
    /* Deep copy ALL ASC/avcC bytes and coded side data; never reconstruct AAC.
     * Codec tags belong to the destination muxer. No input tags/IDs/start_time
     * or container duration are blindly copied into output-only fields. */
    if ((ret = avcodec_parameters_copy(dst->codecpar, par)) < 0) goto write_error;
    dst->codecpar->codec_tag = 0;
    dst->time_base = in->time_base;
    dst->avg_frame_rate = in->avg_frame_rate;
    dst->sample_aspect_ratio = in->sample_aspect_ratio;
    if ((ret = av_dict_set(&options, "protocol_whitelist", "file", 0)) < 0) goto write_error;
    ret = avio_open2(&out->pb, q->staging_path, AVIO_FLAG_WRITE, &out->interrupt_callback, &options);
    if (ret < 0) goto write_error;
    if (av_dict_count(options)) { r->status = BM_UNAVAILABLE; goto done; }
    if (flac) {
        if ((ret = av_dict_set(&options, "write_header", "1", 0)) < 0) goto write_error;
    } else {
        if ((ret = av_dict_set(&options, "movflags", "+faststart", 0)) < 0 ||
            (ret = av_dict_set(&options, "use_editlist", "1", 0)) < 0) goto write_error;
    }
    ret = avformat_write_header(out, &options);
    if (ret < 0) goto write_error;
    if (av_dict_count(options)) { r->status = BM_UNAVAILABLE; goto done; }
    if (dst->time_base.num <= 0 || dst->time_base.den <= 0) { r->status = BM_BACKEND_FAILURE; goto done; }
    r->stage = 3;
    packet = av_packet_alloc();
    if (!packet) { r->status = BM_BACKEND_FAILURE; goto done; }
    int64_t last_dts = AV_NOPTS_VALUE;
    int64_t next_sample = 0;
    for (;;) {
        if (interrupted(call)) { r->status = BM_CANCELLED; goto done; }
        ret = av_read_frame(s, packet);
        if (interrupted(call)) { r->status = BM_CANCELLED; goto done; }
        if (call->denied_open) { r->status = BM_CONTRACT; goto done; }
        if (ret < 0) {
            if (ret == AVERROR_EOF && s->pb->error < 0 && s->pb->error != AVERROR_EOF) ret = s->pb->error;
            if (ret != AVERROR_EOF) { r->status = error_status(ret); goto done; }
            scan->terminal = BM_SCAN_EOF;
            if (!scan->selected.packet_count) { r->status = BM_INVALID_MEDIA; goto done; }
            if (flac) {
                uint64_t total = AV_RB64(par->extradata + 10) & ((1ULL << 36) - 1);
                /* Available demux metadata, not a general edit-list parser.
                 * Reject visible shortened/repeated presentation sequences. */
                if ((total && total != (uint64_t)next_sample) ||
                    (in->nb_frames > 0 && (uint64_t)in->nb_frames != scan->selected.packet_count) ||
                    (in->duration != AV_NOPTS_VALUE &&
                     av_compare_ts(in->duration, in->time_base, next_sample, (AVRational){1, par->sample_rate}))) {
                    r->status = BM_UNSUPPORTED_LAYOUT; goto done;
                }
            }
            break;
        }
        if (packet->stream_index != in->index) { r->status = BM_CONTRACT; goto done; }
        r->status = accumulate(scan, packet);
        if (r->status) goto done;
        if (packet->flags & AV_PKT_FLAG_CORRUPT) { r->status = BM_INVALID_MEDIA; goto done; }
        for (int i = 0; i < packet->side_data_elems; i++) {
            const AVPacketSideData *sd = &packet->side_data[i];
            if (flac && sd->type == AV_PKT_DATA_SKIP_SAMPLES &&
                (sd->size < 10 || AV_RL32(sd->data) || AV_RL32(sd->data + 4))) {
                r->status = BM_UNSUPPORTED_LAYOUT; goto done;
            }
            if (sd->type == AV_PKT_DATA_ENCRYPTION_INFO || sd->type == AV_PKT_DATA_PARAM_CHANGE ||
                (sd->type == AV_PKT_DATA_NEW_EXTRADATA &&
                 (sd->size != (size_t)par->extradata_size || memcmp(sd->data, par->extradata, sd->size)))) {
                r->status = BM_UNSUPPORTED_LAYOUT; goto done;
            }
        }
        /* MP4 needs known PTS/DTS and positive durations in this slice.
         * Keep negatives; do not turn NOPTS or unknown duration into zero.
         * Reject timing that movenc would otherwise repair or guess. */
        if (packet->pts == AV_NOPTS_VALUE || packet->dts == AV_NOPTS_VALUE || packet->duration <= 0) {
            r->status = BM_UNSUPPORTED_LAYOUT; goto done;
        }
        if (flac) {
            AVRational samples = {1, par->sample_rate};
            int64_t duration = av_rescale_q(packet->duration, in->time_base, samples);
            if (packet->pts != packet->dts || duration <= 0 || duration > INT64_MAX - next_sample ||
                av_compare_ts(packet->pts, in->time_base, next_sample, samples) ||
                av_compare_ts(packet->duration, in->time_base, duration, samples)) {
                r->status = BM_UNSUPPORTED_LAYOUT; goto done;
            }
            next_sample += duration;
        }
        av_packet_rescale_ts(packet, in->time_base, dst->time_base);
        if (packet->dts == AV_NOPTS_VALUE || packet->pts < packet->dts ||
            packet->duration <= 0 || packet->duration > INT_MAX ||
            (uint64_t)packet->pts - (uint64_t)packet->dts > INT_MAX ||
            (last_dts != AV_NOPTS_VALUE && (packet->dts <= last_dts ||
             (uint64_t)packet->dts - (uint64_t)last_dts > INT_MAX))) {
            r->status = BM_UNSUPPORTED_LAYOUT; goto done;
        }
        last_dts = packet->dts;
        packet->stream_index = dst->index;
        packet->pos = -1;
        /* No packet recreation: relevant side data reaches the muxer intact.
         * 9.0.1 consumes/blanks the packet even on error. */
        ret = av_interleaved_write_frame(out, packet);
        if (ret < 0) goto write_error;
        if (out->pb->error < 0) { ret = out->pb->error; goto write_error; }
        if (interrupted(call)) { r->status = BM_CANCELLED; goto done; }
    }
    r->stage = 4;
    if (interrupted(call)) { r->status = BM_CANCELLED; goto done; }
    ret = av_interleaved_write_frame(out, NULL);
    if (ret >= 0) ret = av_write_trailer(out);
    if (ret < 0) goto write_error;
    avio_flush(out->pb);
    if (out->pb->error < 0) { ret = out->pb->error; goto write_error; }
    if (io.close_error < 0) { ret = io.close_error; goto write_error; }
    r->stage = 5;
    ret = avio_closep(&out->pb);
    if (ret < 0) goto write_error;
    if (interrupted(call)) { r->status = BM_CANCELLED; goto done; }
    r->stage = 6;
    /* Reuse M1's fd-only discovery and subordinate-open denial to verify the
     * complete decoder config after muxer finalization, with input still live. */
#ifdef _WIN32
    int fd = bm_open_read(q->staging_path);
#else
    int fd = open(q->staging_path, O_RDONLY | O_NONBLOCK);
#endif
    if (fd < 0) { r->status = BM_IO; goto done; }
    BmRequest check = {fd, q->input.cancelled, q->input.opaque};
    BmResult *metadata = NULL;
    r->status = inspect(&check, &metadata, NULL, NULL, NULL, NULL, par, 0);
    if (!r->status) r->status = metadata ? metadata->status : BM_BACKEND_FAILURE;
    bm_release(metadata);
    if (close(fd) < 0 && !r->status) r->status = BM_IO;
    if (!r->status) { r->configuration_preserved = 1; r->finalized = 1; r->stage = 7; }
    goto done;
write_error:
    r->status = interrupted(call) ? BM_CANCELLED : io.denied_open ? BM_CONTRACT : output_error(ret);
done:
    av_packet_free(&packet);
    av_dict_free(&options);
    if (out && out->pb) close_ret = avio_closep(&out->pb);
    avformat_free_context(out);
    avcodec_parameters_free(&configuration);
    if (!r->status && close_ret < 0) r->status = output_error(close_ret);
    if (r->status) { r->finalized = 0; r->input_scan.status = r->status; }
}

uint32_t bm_remux_info_v1(uint32_t size, BmRemuxInfo *info) {
    if (!info || size != sizeof(*info) || !compatible() || !av_guess_format("mp4", NULL, NULL))
        return BM_UNAVAILABLE;
    *info = (BmRemuxInfo){1, sizeof(BmRemuxRequest), sizeof(BmRemuxResult), sizeof(BmScanResult)};
    return BM_OK;
}
uint32_t bm_flac_info_v1(uint32_t size, BmRemuxInfo *info) {
    if (!av_guess_format("flac", NULL, NULL)) return BM_UNAVAILABLE;
    return bm_remux_info_v1(size, info);
}
static uint32_t copy_profile(const BmRemuxRequest *q, BmRemuxResult **out, int flac) {
    if (!out) return BM_INVALID_REQUEST;
    *out = NULL;
    if (!q || !q->input.cancelled || !q->staging_path ||
#ifdef _WIN32
        !bm_absolute_path(q->staging_path) ||
#else
        q->staging_path[0] != '/' ||
#endif
        (q->media_type != 1 && q->media_type != 2)) return BM_INVALID_REQUEST;
    if (!compatible()) return BM_UNAVAILABLE;
    BmRemuxResult *r = calloc(1, sizeof(*r));
    if (!r) return BM_BACKEND_FAILURE;
    *out = r;
    BmResult *metadata = NULL;
    uint32_t status = inspect(&q->input, &metadata, NULL, NULL, q, r, NULL, flac);
    bm_release(metadata);
    if (status) r->status = status;
    return BM_OK;
}
uint32_t bm_copy_remux_mp4_v1(const BmRemuxRequest *q, BmRemuxResult **out) {
    return copy_profile(q, out, 0);
}
uint32_t bm_copy_flac_v1(const BmRemuxRequest *q, BmRemuxResult **out) {
    if (!av_guess_format("flac", NULL, NULL)) return BM_UNAVAILABLE;
    return copy_profile(q, out, 1);
}
void bm_remux_release_v1(BmRemuxResult *r) { free(r); }
