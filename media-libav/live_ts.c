/* Synchronous, descriptor-only P1 copy pipeline. FFmpeg 9.0.1 public APIs.
 * Rust owns cancellation, pacing, bounded queues, reader leases and HTTP. */
#include <libavcodec/bsf.h>

typedef struct LiveInput {
    Call call;
    AVFormatContext *format;
    AVIOContext *io;
    AVPacket *packet;
    AVCodecParameters *config;
    int eof;
    int (*next)(struct LiveInput *);
    void (*release)(struct LiveInput *);
    void *state;
} LiveInput;
typedef struct {
    const BmLiveRequest *request;
    BmLiveResult *result;
    int64_t time_us;
    uint32_t key;
} LiveWriter;

uint32_t bm_live_info_v1(uint32_t size, BmLiveInfo *info) {
    if (!info || size != sizeof(*info) || !compatible() ||
        !av_guess_format("mpegts", NULL, NULL) ||
        !av_bsf_get_by_name("h264_mp4toannexb")) return BM_UNAVAILABLE;
    *info = (BmLiveInfo){1, sizeof(BmLiveRequest), sizeof(BmLiveResult)};
    return BM_OK;
}

static void live_close(LiveInput *in) {
    if(in->release) in->release(in);
    av_packet_free(&in->packet);
    avcodec_parameters_free(&in->config);
    avformat_close_input(&in->format);
    if (in->io) avio_close(in->io);
}
static uint32_t live_open(LiveInput *in, const BmRequest *request,
                          enum AVMediaType type, enum AVCodecID codec, const char *format) {
    in->call.request = request;
    if (interrupted(&in->call)) return BM_CANCELLED;
#ifdef _WIN32
    if (request->fd < 0 || !bm_regular_fd(request->fd)) return BM_INVALID_REQUEST;
#else
    struct stat st;
    int flags = fcntl(request->fd, F_GETFL);
    if (fstat(request->fd, &st) || !S_ISREG(st.st_mode) || flags < 0 ||
        (flags & O_ACCMODE) != O_RDONLY) return BM_INVALID_REQUEST;
#endif
    in->format = avformat_alloc_context();
    in->packet = av_packet_alloc();
    if (!in->format || !in->packet) return BM_BACKEND_FAILURE;
    AVFormatContext *s = in->format;
    s->opaque = &in->call;
    s->io_open = deny_open;
    s->interrupt_callback = (AVIOInterruptCB){interrupted, &in->call};
    s->flags |= AVFMT_FLAG_CUSTOM_IO;
    s->probesize = 1024 * 1024;
    s->max_analyze_duration = 1000000;
    s->max_streams = strcmp(format,"mpegts") ? 1 : 2;
    AVDictionary *options = NULL;
    int ret = av_dict_set_int(&options, "fd", request->fd, 0);
    if (ret >= 0) ret = av_dict_set(&options, "protocol_whitelist", "fd", 0);
    if (ret >= 0) ret = avio_open2(&in->io, "fd:", AVIO_FLAG_READ, &s->interrupt_callback, &options);
    int unused = av_dict_count(options);
    av_dict_free(&options);
    if (ret < 0) return error_status(ret);
    if (unused) return BM_UNAVAILABLE;
    s->pb = in->io;
    if (!strcmp(format,"mov")) {
        av_dict_set(&options, "enable_drefs", "0", 0);
        av_dict_set(&options, "use_absolute_path", "0", 0);
    }
    ret = avformat_open_input(&in->format, "", av_find_input_format(format), &options);
    unused = av_dict_count(options);
    av_dict_free(&options);
    if (ret < 0) return error_status(ret);
    if (unused) return BM_UNAVAILABLE;
    s = in->format;
    ret = avformat_find_stream_info(s, NULL);
    if (ret < 0) return error_status(ret);
    if (in->call.denied_open) return BM_CONTRACT;
    if (!strcmp(format,"mpegts")) return BM_OK;
    if (s->nb_streams != 1 || s->streams[0]->codecpar->codec_type != type) return BM_CONTRACT;
    const AVCodecParameters *par = s->streams[0]->codecpar;
    if (codec != AV_CODEC_ID_NONE && par->codec_id != codec) return BM_UNSUPPORTED_CODEC;
    if (par->extradata_size <= 0 || !par->extradata) return BM_INVALID_MEDIA;
    if (codec == AV_CODEC_ID_AAC && (par->profile != AV_PROFILE_AAC_LOW ||
        par->ch_layout.nb_channels < 1 || par->ch_layout.nb_channels > 2 || par->sample_rate <= 0)) return BM_UNSUPPORTED_CODEC;
    if (s->streams[0]->time_base.num <= 0 || s->streams[0]->time_base.den <= 0) return BM_INVALID_MEDIA;
    in->config = avcodec_parameters_alloc();
    if (!in->config || avcodec_parameters_copy(in->config,par)<0) return BM_BACKEND_FAILURE;
    return BM_OK;
}
static int live_read(LiveInput *in) {
    av_packet_unref(in->packet);
    if (in->eof) return 0;
    if (in->next) return in->next(in);
    int ret = av_read_frame(in->format, in->packet);
    if (in->call.denied_open) return AVERROR_INVALIDDATA;
    if (ret == AVERROR_EOF) {
        if (in->io->error < 0 && in->io->error != AVERROR_EOF) return in->io->error;
        in->eof = 1; return 0;
    }
    if (ret < 0) return ret;
    AVPacket *p = in->packet;
    if (p->stream_index != 0 || p->dts == AV_NOPTS_VALUE || p->pts == AV_NOPTS_VALUE ||
        p->pts < p->dts || p->size <= 0 || p->size > 8 * 1024 * 1024 ||
        (p->flags & AV_PKT_FLAG_CORRUPT) ||
        av_packet_get_side_data(p, AV_PKT_DATA_NEW_EXTRADATA, NULL) ||
        av_packet_get_side_data(p, AV_PKT_DATA_ENCRYPTION_INFO, NULL) ||
        !same_decoder_config(in->config,in->format->streams[0]->codecpar)) return AVERROR_INVALIDDATA;
    /* Bound source times before origin subtraction and muxer arithmetic. Reject
     * rescale overflow (INT64_MIN) and malformed durations instead of wrapping. */
    AVRational base=in->format->streams[0]->time_base;
    int64_t dts=av_rescale_q(p->dts,base,AV_TIME_BASE_Q);
    int64_t pts=av_rescale_q(p->pts,base,AV_TIME_BASE_Q);
    int64_t duration=av_rescale_q(p->duration,base,AV_TIME_BASE_Q);
    if (dts < -INT64_C(604800000000) || dts > INT64_C(604800000000) ||
        pts < -INT64_C(604800000000) || pts > INT64_C(604800000000) ||
        duration < 0 || duration > 4000000) return AVERROR_INVALIDDATA;
    return 1;
}
static int64_t live_time(const LiveInput *in, int64_t ticks) {
    return av_rescale_q(ticks, in->format->streams[0]->time_base, AV_TIME_BASE_Q);
}
static int live_write(void *opaque, const uint8_t *bytes, int size) {
    LiveWriter *writer = opaque;
    if (size <= 0 || size > 32768) return AVERROR(EINVAL);
    if (writer->request->visit(writer->request->opaque, bytes, (uint32_t)size,
                               writer->time_us, writer->key)) return AVERROR_EXIT;
    writer->key = 0;
    writer->result->bytes += (uint32_t)size;
    return size;
}

static uint32_t l1_audio_open(LiveInput *,const BmL1Request *,int64_t,int64_t);
static uint32_t live_mux(const BmLiveRequest *q, const BmL1Request *l1, BmLiveResult *r) {
    if (!r) return BM_INVALID_REQUEST;
    memset(r, 0, sizeof(*r));
    if (!q || !q->visit || !q->video.cancelled || !q->audio.cancelled ||
        q->start_us < 0 || q->start_us > INT64_C(21600000000)) return BM_INVALID_REQUEST;
    BmLiveInfo info;
    if (bm_live_info_v1(sizeof(info), &info)) return BM_UNAVAILABLE;
    LiveInput inputs[2] = {0};
    AVFormatContext *out = NULL;
    AVIOContext *io = NULL;
    AVBSFContext *filter = NULL;
    AVPacket *filtered = av_packet_alloc();
    AVDictionary *options = NULL;
    LiveWriter writer = {.request=q, .result=r};
    uint32_t status = BM_OK;
    int ret = 0;
    if (!filtered) { status = BM_BACKEND_FAILURE; goto done; }
    status = live_open(&inputs[0], &q->video, AVMEDIA_TYPE_VIDEO, AV_CODEC_ID_H264,"mov");
    if (status) goto done;
    if (q->start_us > 0) {
        int64_t target = av_rescale_q(q->start_us, AV_TIME_BASE_Q, inputs[0].format->streams[0]->time_base);
        ret = av_seek_frame(inputs[0].format, 0, target, AVSEEK_FLAG_BACKWARD);
        if (ret < 0) goto failed;
    }
    do { ret = live_read(&inputs[0]); } while (ret > 0 && !(inputs[0].packet->flags & AV_PKT_FLAG_KEY));
    if (ret <= 0) { status = BM_INVALID_MEDIA; goto done; }
    int64_t source_start = live_time(&inputs[0], inputs[0].packet->pts);
    if(l1) {
        AVStream *v=inputs[0].format->streams[0];
        if(v->duration<=0 || v->duration==AV_NOPTS_VALUE) {status=BM_UNSUPPORTED_LAYOUT;goto done;}
        int64_t duration=av_rescale_q(v->duration,v->time_base,AV_TIME_BASE_Q);
        if(duration<=0||duration>INT64_C(21600000000)) {status=BM_UNSUPPORTED_LAYOUT;goto done;}
        int64_t begin=av_rescale_q(FFMAX(0,v->start_time),v->time_base,AV_TIME_BASE_Q);
        if(begin<0||begin>INT64_C(604800000000)) {status=BM_INVALID_MEDIA;goto done;}
        status=l1_audio_open(&inputs[1],l1,source_start,begin+duration);
        if(status) goto done;
    } else {
        status = live_open(&inputs[1], &q->audio, AVMEDIA_TYPE_AUDIO, AV_CODEC_ID_AAC,"mov");
        if (status) goto done;
    }
    if (!l1 && source_start > 0) {
        ret = av_seek_frame(inputs[1].format, 0,
            av_rescale_q(source_start, AV_TIME_BASE_Q, inputs[1].format->streams[0]->time_base), AVSEEK_FLAG_BACKWARD);
        if (ret < 0) goto failed;
    }
    do { ret = live_read(&inputs[1]); }
    while (!l1 && ret > 0 && live_time(&inputs[1], inputs[1].packet->pts) < source_start);
    if (ret <= 0) { status = BM_INVALID_MEDIA; goto done; }
    int64_t origin = live_time(&inputs[0], inputs[0].packet->dts);
    if(l1) origin=FFMIN(origin,live_time(&inputs[1],inputs[1].packet->dts));
    int64_t last_dts[2] = {INT64_MIN, INT64_MIN};
    int64_t last_key = 0;
    ret = av_bsf_alloc(av_bsf_get_by_name("h264_mp4toannexb"), &filter);
    if (ret < 0) goto failed;
    ret = avcodec_parameters_copy(filter->par_in, inputs[0].format->streams[0]->codecpar);
    if (ret < 0) goto failed;
    filter->time_base_in = inputs[0].format->streams[0]->time_base;
    ret = av_bsf_init(filter);
    if (ret < 0) goto failed;
    ret = avformat_alloc_output_context2(&out, NULL, "mpegts", NULL);
    if (ret < 0 || !out) goto failed;
    out->max_delay = 500000; /* decode lead for CBR PCR, not a source A/V shift */
    out->flags |= AVFMT_FLAG_CUSTOM_IO | AVFMT_FLAG_FLUSH_PACKETS;
    out->flags &= ~AVFMT_FLAG_AUTO_BSF;
    out->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED;
    for (int i = 0; i < 2; ++i) {
        AVStream *stream = avformat_new_stream(out, NULL);
        if (!stream) { status = BM_BACKEND_FAILURE; goto done; }
        ret = avcodec_parameters_copy(stream->codecpar, i ? inputs[1].format->streams[0]->codecpar : filter->par_out);
        if (ret < 0) goto failed;
        stream->codecpar->codec_tag = 0;
        stream->time_base = (AVRational){1, 90000};
    }
    uint8_t *buffer = av_malloc(188 * 128);
    if (!buffer) { status = BM_BACKEND_FAILURE; goto done; }
    io = avio_alloc_context(buffer, 188 * 128, 1, &writer, NULL, live_write, NULL);
    if (!io) { av_free(buffer); status = BM_BACKEND_FAILURE; goto done; }
    out->pb = io;
    av_dict_set(&options, "mpegts_flags", "resend_headers+pat_pmt_at_frames", 0);
    av_dict_set(&options, "pat_period", "0.05", 0);
    av_dict_set(&options, "pcr_period", "20", 0);
    /* VBR can emit PCR only on video frames (41.7 ms at 24 fps). CBR lets
     * the muxer insert adaptation-only PCR/null packets between such frames. */
    if (inputs[0].format->bit_rate>256000000 || inputs[1].format->bit_rate>256000000) {
        status=BM_UNSUPPORTED_LAYOUT;goto done;
    }
    int64_t rate=inputs[0].format->bit_rate>0 ? inputs[0].format->bit_rate : 0;
    if (inputs[1].format->bit_rate>0) rate+=inputs[1].format->bit_rate;
    if (rate>256000000) {status=BM_UNSUPPORTED_LAYOUT;goto done;}
    rate=rate*2+1000000;
    av_dict_set_int(&options,"muxrate",rate,0);
    ret = avformat_write_header(out, &options);
    if (ret < 0 || av_dict_count(options)) { status = BM_UNAVAILABLE; goto done; }
    while (!inputs[0].eof || !inputs[1].eof) {
        if (interrupted(&inputs[0].call) || interrupted(&inputs[1].call)) { status = BM_CANCELLED; goto done; }
        int index = inputs[0].eof ? 1 : inputs[1].eof ? 0 :
            (live_time(&inputs[0], inputs[0].packet->dts) <= live_time(&inputs[1], inputs[1].packet->dts) ? 0 : 1);
        LiveInput *in = &inputs[index];
        AVPacket *p = in->packet;
        int64_t dts = live_time(in, p->dts) - origin;
        if (dts < 0 || dts <= last_dts[index]) { status = BM_UNSUPPORTED_LAYOUT; goto done; }
        last_dts[index] = dts;
        writer.time_us = dts;
        writer.key = !index && (p->flags & AV_PKT_FLAG_KEY) ? 1 : 0;
        if (writer.key) last_key = dts;
        if (!index && dts - last_key > 4000000) { status = BM_UNSUPPORTED_LAYOUT; goto done; }
        if (!index) {
            ret = av_bsf_send_packet(filter, p);
            if (ret < 0) goto failed;
            ret = av_bsf_receive_packet(filter, filtered);
            if (ret < 0) goto failed;
            p = filtered;
        }
        p->pts = av_rescale_q(live_time(in, p->pts) - origin, AV_TIME_BASE_Q, out->streams[index]->time_base);
        p->dts = av_rescale_q(dts, AV_TIME_BASE_Q, out->streams[index]->time_base);
        p->duration = av_rescale_q(p->duration, in->format->streams[0]->time_base, out->streams[index]->time_base);
        p->stream_index = index;
        p->pos = -1;
        ret = av_write_frame(out, p);
        av_packet_unref(filtered);
        avio_flush(io);
        if (ret < 0 || io->error < 0) { if (ret >= 0) ret = io->error; goto failed; }
        ++r->packets;
        ret = live_read(in);
        if (ret < 0) goto failed;
    }
    ret = av_write_trailer(out);
    avio_flush(io);
    if (ret < 0 || io->error < 0) { if (ret >= 0) ret = io->error; goto failed; }
    r->complete = 1;
    goto done;
failed:
    status = (inputs[0].call.request && interrupted(&inputs[0].call)) || (inputs[1].call.request && interrupted(&inputs[1].call))
        ? BM_CANCELLED : error_status(ret);
done:
    av_dict_free(&options);
    av_packet_free(&filtered);
    av_bsf_free(&filter);
    if (out) { out->pb = NULL; avformat_free_context(out); }
    if (io) { av_freep(&io->buffer); avio_context_free(&io); }
    live_close(&inputs[1]);
    live_close(&inputs[0]);
    r->status = status;
    return BM_OK;
}
uint32_t bm_live_ts_v1(const BmLiveRequest *q,BmLiveResult *r) { return live_mux(q,NULL,r); }

uint32_t bm_live_check_v1(const BmRequest *q, uint32_t size, BmLiveCheck *r) {
    if (!q || !q->cancelled || !r || size!=sizeof(*r)) return BM_INVALID_REQUEST;
    memset(r,0,sizeof(*r));
    LiveInput in={0};
    r->status=live_open(&in,q,AVMEDIA_TYPE_UNKNOWN,AV_CODEC_ID_NONE,"mpegts");
    if (r->status) goto done;
    if (in.format->nb_streams!=2 || in.format->streams[0]->codecpar->codec_id!=AV_CODEC_ID_H264 ||
        in.format->streams[1]->codecpar->codec_id!=AV_CODEC_ID_AAC) {r->status=BM_CONTRACT;goto done;}
    for (;;) {
        if (interrupted(&in.call)) {r->status=BM_CANCELLED;goto done;}
        int ret=av_read_frame(in.format,in.packet);
        if (ret==AVERROR_EOF) break;
        if (ret<0) {r->status=error_status(ret);goto done;}
        int i=in.packet->stream_index;
        if (i<0 || i>1 || in.packet->dts==AV_NOPTS_VALUE || in.packet->pts==AV_NOPTS_VALUE || (in.packet->flags&AV_PKT_FLAG_CORRUPT)) {r->status=BM_INVALID_MEDIA;goto done;}
        AVRational base=in.format->streams[i]->time_base;
        int64_t dts=av_rescale_q(in.packet->dts,base,AV_TIME_BASE_Q);
        int64_t pts=av_rescale_q(in.packet->pts,base,AV_TIME_BASE_Q);
        if (r->packets[i]) {
            if (dts<=r->last_dts[i]) {r->status=BM_INVALID_MEDIA;goto done;}
            if (pts<r->min_pts[i]) r->min_pts[i]=pts;
            if (pts>r->max_pts[i]) r->max_pts[i]=pts;
        } else {r->first_dts[i]=dts;r->min_pts[i]=pts;r->max_pts[i]=pts;}
        r->last_dts[i]=dts;++r->packets[i];av_packet_unref(in.packet);
    }
    r->complete=r->packets[0]>0 && r->packets[1]>0;
done:
    live_close(&in);return BM_OK;
}
