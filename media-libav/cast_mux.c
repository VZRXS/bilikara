/* Adapted from bilikara-next media-libav/live_ts.c (MIT).
 * Copyright (c) 2026 bilikara contributors; see ../LICENSE.
 * Synchronous descriptor-only cast pipeline. FFmpeg 9.0.1 public APIs.
 * Rust owns cancellation, pacing, bounded queues, reader leases and HTTP. */
#include <libavcodec/bsf.h>
#include <libswresample/swresample.h>

typedef struct CastInput {
    Call call;
    AVFormatContext *format;
    AVIOContext *io;
    AVPacket *packet;
    AVCodecParameters *config;
    int eof;
    int (*next)(struct CastInput *);
    void (*release)(struct CastInput *);
    void *state;
} CastInput;
typedef struct {
    const BmCastRequest *request;
    BmCastResult *result;
    int64_t time_us;
    uint32_t key;
    AVIOContext *file;
    uint64_t extent;
} CastWriter;

uint32_t bm_cast_info_v1(uint32_t size, BmCastInfo *info) {
    if (!info || size != sizeof(*info) || !compatible() ||
        !av_guess_format("mpegts", NULL, NULL) ||
        !av_bsf_get_by_name("h264_mp4toannexb") ||
        !av_guess_format("mp4", NULL, NULL) || !avcodec_find_encoder(AV_CODEC_ID_AAC) ||
        swresample_version() != LIBSWRESAMPLE_VERSION_INT ||
        strcmp(swresample_configuration(), BM_BUILD_CONFIG)) return BM_UNAVAILABLE;
    *info = (BmCastInfo){2, sizeof(BmCastRequest), sizeof(BmCastResult), sizeof(BmCastStart)};
    return BM_OK;
}

static void cast_close(CastInput *in) {
    if(in->release) in->release(in);
    av_packet_free(&in->packet);
    avcodec_parameters_free(&in->config);
    avformat_close_input(&in->format);
    if (in->io) avio_close(in->io);
}
static uint32_t cast_open(CastInput *in, const BmRequest *request,
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
    s->max_streams = 2; /* inspect a second stream and classify the contract */
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
    if (codec == AV_CODEC_ID_H264 && (par->extradata_size <= 0 || !par->extradata)) return BM_INVALID_MEDIA;
    if (s->streams[0]->time_base.num <= 0 || s->streams[0]->time_base.den <= 0) return BM_INVALID_MEDIA;
    in->config = avcodec_parameters_alloc();
    if (!in->config || avcodec_parameters_copy(in->config,par)<0) return BM_BACKEND_FAILURE;
    return BM_OK;
}
static int cast_read(CastInput *in) {
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
        (in->config->extradata_size > 0 && !same_decoder_config(in->config,in->format->streams[0]->codecpar))) return AVERROR_INVALIDDATA;
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
static int64_t cast_time(const CastInput *in, int64_t ticks) {
    return av_rescale_q(ticks, in->format->streams[0]->time_base, AV_TIME_BASE_Q);
}
static int cast_write(void *opaque, const uint8_t *bytes, int size) {
    CastWriter *writer = opaque;
    if (size <= 0 || size > 32768) return AVERROR(EINVAL);
    if (interrupted(&(Call){.request=&writer->request->video})) return AVERROR_EXIT;
    if (writer->file) {
        int64_t pos = avio_tell(writer->file);
        if (pos < 0 || (uint64_t)pos > writer->request->max_bytes ||
            (uint64_t)size > writer->request->max_bytes - (uint64_t)pos) return AVERROR(ENOSPC);
        avio_write(writer->file, bytes, size);
        avio_flush(writer->file);
        if (writer->file->error < 0) return writer->file->error;
        writer->extent = FFMAX(writer->extent, (uint64_t)pos + (uint32_t)size);
        writer->result->bytes = writer->extent;
        return size;
    }
    if ((uint64_t)size > writer->request->max_bytes - writer->result->bytes) return AVERROR(ENOSPC);
    if (writer->request->visit(writer->request->opaque, bytes, (uint32_t)size,
                               writer->time_us, writer->key)) return AVERROR_EXIT;
    writer->key = 0;
    writer->result->bytes += (uint32_t)size;
    return size;
}

static int64_t cast_seek(void *opaque, int64_t offset, int whence) {
    CastWriter *w = opaque;
    if (whence == AVSEEK_SIZE) return (int64_t)w->extent;
    if (whence != SEEK_SET || offset < 0 || (uint64_t)offset > w->request->max_bytes) return AVERROR(EINVAL);
    return avio_seek(w->file, offset, SEEK_SET);
}
#include "cast_audio.c"
static uint32_t cast_mux(const BmCastRequest *q, BmCastResult *r) {
    if (!r) return BM_INVALID_REQUEST;
    memset(r, 0, sizeof(*r));
    if (!q || !q->on_start || q->ts_cbr > 1 || (q->output_kind == 0 && !q->visit) || q->output_kind > 1 ||
        (q->output_kind == 1 && !q->staging_path) || !q->max_bytes || q->max_bytes > INT64_MAX ||
        !q->video.cancelled || !q->audio.cancelled ||
        q->start_us < 0 || q->start_us > INT64_C(21600000000)) return BM_INVALID_REQUEST;
    BmCastInfo info;
    if (bm_cast_info_v1(sizeof(info), &info)) return BM_UNAVAILABLE;
    CastInput inputs[2] = {0};
    AVFormatContext *out = NULL;
    AVIOContext *io = NULL;
    AVBSFContext *filter = NULL;
    AVPacket *filtered = av_packet_alloc();
    AVDictionary *options = NULL;
    CastWriter writer = {.request=q, .result=r};
    RemuxOutput file_output = {.input=&inputs[0].call, .path=q->staging_path};
    uint32_t status = BM_OK;
    int ret = 0;
    if (!filtered) { status = BM_BACKEND_FAILURE; goto done; }
    status = cast_open(&inputs[0], &q->video, AVMEDIA_TYPE_VIDEO, AV_CODEC_ID_H264,"mov");
    if (status) goto done;
    if (q->start_us > 0) {
        int64_t target = av_rescale_q(q->start_us, AV_TIME_BASE_Q, inputs[0].format->streams[0]->time_base);
        ret = av_seek_frame(inputs[0].format, 0, target, AVSEEK_FLAG_BACKWARD);
        if (ret < 0) goto failed;
    }
    do { ret = cast_read(&inputs[0]); } while (ret > 0 && !(inputs[0].packet->flags & AV_PKT_FLAG_KEY));
    if (ret < 0) goto failed;
    if (!ret) { status = BM_INVALID_MEDIA; goto done; }
    int64_t source_start = cast_time(&inputs[0], inputs[0].packet->pts);
    r->source_start_us = source_start;
    const AVCodecParameters *vp = inputs[0].config;
    r->profile=vp->extradata_size>=4 && vp->extradata[0]==1 ? vp->extradata[1] : -1;
    r->level=vp->extradata_size>=4 && vp->extradata[0]==1 ? vp->extradata[3] : -1; r->width=vp->width; r->height=vp->height;
    r->has_b_frames=vp->video_delay>0;
    status = cast_audio_open(&inputs[1], &q->audio, source_start, &r->audio_transcoded);
    if (status) goto done;
    do { ret = cast_read(&inputs[1]); }
    while (ret > 0 && !r->audio_transcoded && cast_time(&inputs[1], inputs[1].packet->pts) < source_start);
    if (ret < 0) goto failed;
    if (!ret) { status = BM_INVALID_MEDIA; goto done; }
    int64_t origin = FFMIN(cast_time(&inputs[0], inputs[0].packet->dts), cast_time(&inputs[1], inputs[1].packet->dts));
    int64_t last_dts[2] = {INT64_MIN, INT64_MIN};
    int64_t last_key = -1;
    ret = av_bsf_alloc(av_bsf_get_by_name("h264_mp4toannexb"), &filter);
    if (ret < 0) goto failed;
    ret = avcodec_parameters_copy(filter->par_in, inputs[0].format->streams[0]->codecpar);
    if (ret < 0) goto failed;
    filter->time_base_in = inputs[0].format->streams[0]->time_base;
    ret = av_bsf_init(filter);
    if (ret < 0) goto failed;
    ret = avformat_alloc_output_context2(&out, NULL, q->output_kind ? "mp4" : "mpegts", q->staging_path);
    if (ret < 0 || !out) goto failed;
    out->max_delay = 500000; /* decode lead for CBR PCR, not a source A/V shift */
    out->flags |= AVFMT_FLAG_CUSTOM_IO | AVFMT_FLAG_FLUSH_PACKETS;
    out->flags &= ~AVFMT_FLAG_AUTO_BSF;
    out->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED;
    for (int i = 0; i < 2; ++i) {
        AVStream *stream = avformat_new_stream(out, NULL);
        if (!stream) { status = BM_BACKEND_FAILURE; goto done; }
        ret = avcodec_parameters_copy(stream->codecpar, i ? inputs[1].format->streams[0]->codecpar : q->output_kind ? inputs[0].config : filter->par_out);
        if (ret < 0) goto failed;
        stream->codecpar->codec_tag = 0;
        stream->time_base = inputs[i].format->streams[0]->time_base;
        stream->avg_frame_rate = inputs[i].format->streams[0]->avg_frame_rate;
    }
    if (q->output_kind) {
#ifdef _WIN32
        status=bm_empty_distinct_output(q->video.fd,q->staging_path);
        if (!status) status=bm_empty_distinct_output(q->audio.fd,q->staging_path);
#else
        struct stat a,b,c;
        if (fstat(q->video.fd,&a)||fstat(q->audio.fd,&b)||stat(q->staging_path,&c)) status=BM_IO;
        else if (!S_ISREG(c.st_mode)||c.st_size || (a.st_dev==c.st_dev&&a.st_ino==c.st_ino) ||
            (b.st_dev==c.st_dev&&b.st_ino==c.st_ino)) status=BM_INVALID_REQUEST;
#endif
        if(status) goto done;
        out->opaque=&file_output;
        out->io_open=reopen_staging; out->io_close2=close_staging_read;
        out->interrupt_callback=(AVIOInterruptCB){output_interrupted,&file_output};
        av_dict_set(&options,"protocol_whitelist","file",0);
        ret=avio_open2(&writer.file,q->staging_path,AVIO_FLAG_WRITE,&out->interrupt_callback,&options);
        av_dict_free(&options);
        if(ret<0) goto failed;
    }
    uint8_t *buffer = av_malloc(188 * 128);
    if (!buffer) { status = BM_BACKEND_FAILURE; goto done; }
    io = avio_alloc_context(buffer, 188 * 128, 1, &writer, NULL, cast_write, q->output_kind ? cast_seek : NULL);
    if (!io) { av_free(buffer); status = BM_BACKEND_FAILURE; goto done; }
    out->pb = io;
    if (!q->output_kind) {
        av_dict_set(&options, "mpegts_flags", "resend_headers+pat_pmt_at_frames", 0);
        av_dict_set(&options, "pat_period", "0.05", 0);
        av_dict_set(&options, "pes_payload_size", "0", 0);
        av_dict_set(&options, "pcr_period", "20", 0);
        /* VBR can emit PCR only on video frames (41.7 ms at 24 fps). CBR lets
         * the muxer insert adaptation-only PCR/null packets between such frames. */
        if (q->ts_cbr) {
            if (inputs[0].format->bit_rate>256000000 || inputs[1].format->bit_rate>256000000) {
                status=BM_UNSUPPORTED_LAYOUT;goto done;
            }
            int64_t rate=inputs[0].format->bit_rate>0 ? inputs[0].format->bit_rate : 0;
            if (inputs[1].format->bit_rate>0) rate+=inputs[1].format->bit_rate;
            if (rate>256000000) {status=BM_UNSUPPORTED_LAYOUT;goto done;}
            rate=rate*2+1000000;
            av_dict_set_int(&options,"muxrate",rate,0);
        }
    } else {
        av_dict_set(&options,"movflags","+faststart",0);
        av_dict_set(&options,"use_editlist","1",0);
    }
    BmCastStart start={source_start,origin,r->profile,r->level,r->width,r->height,r->has_b_frames,r->audio_transcoded};
    if (q->on_start(q->opaque,&start)) {status=BM_CANCELLED;goto done;}
    ret = avformat_write_header(out, &options);
    if (ret < 0) goto failed;
    if (av_dict_count(options)) { status = BM_UNAVAILABLE; goto done; }
    while (!inputs[0].eof || !inputs[1].eof) {
        if (interrupted(&inputs[0].call) || interrupted(&inputs[1].call)) { status = BM_CANCELLED; goto done; }
        int index = inputs[0].eof ? 1 : inputs[1].eof ? 0 :
            (cast_time(&inputs[0], inputs[0].packet->dts) <= cast_time(&inputs[1], inputs[1].packet->dts) ? 0 : 1);
        /* A TS join starts with PSI + the video IDR even when encoder priming
         * has an earlier audio DTS (no B-frame video decode lead). Packet times
         * remain intact; only this first cross-stream emission is reordered. */
        if (!q->output_kind && !r->packets) index=0;
        CastInput *in = &inputs[index];
        AVPacket *p = in->packet;
        int64_t dts = cast_time(in, p->dts) - origin;
        if (dts < 0 || dts <= last_dts[index]) { status = BM_UNSUPPORTED_LAYOUT; goto done; }
        last_dts[index] = dts;
        writer.time_us = FFMAX(writer.time_us,dts);
        writer.key = !index && (p->flags & AV_PKT_FLAG_KEY) ? 1 : 0;
        if (writer.key) {
            if(last_key>=0) r->gop_us=FFMAX(r->gop_us,dts-last_key);
            last_key=dts;
        }
        r->has_b_frames |= !index && p->pts != p->dts;
        r->duration_us=FFMAX(r->duration_us,cast_time(in,p->pts+p->duration)-source_start);
        if (!index && !q->output_kind) {
            ret = av_bsf_send_packet(filter, p);
            if (ret < 0) goto failed;
            ret = av_bsf_receive_packet(filter, filtered);
            if (ret < 0) goto failed;
            p = filtered;
        }
        p->pts = av_rescale_q(cast_time(in, p->pts) - origin, AV_TIME_BASE_Q, out->streams[index]->time_base);
        p->dts = av_rescale_q(dts, AV_TIME_BASE_Q, out->streams[index]->time_base);
        p->duration = av_rescale_q(p->duration, in->format->streams[0]->time_base, out->streams[index]->time_base);
        p->stream_index = index;
        p->pos = -1;
        ret = av_write_frame(out, p);
        /* Even pes_payload_size=0 rounds to a TS payload block. Flush small
         * AAC packets explicitly so a later keyframe group has no older audio. */
        if (ret >= 0 && !q->output_kind) ret = av_write_frame(out, NULL);
        av_packet_unref(filtered);
        avio_flush(io);
        if (ret < 0 || io->error < 0) { if (ret >= 0) ret = io->error; goto failed; }
        ++r->packets;
        ret = cast_read(in);
        if (ret < 0) goto failed;
    }
    ret = av_write_trailer(out);
    avio_flush(io);
    if (ret < 0 || io->error < 0) { if (ret >= 0) ret = io->error; goto failed; }
    if(file_output.denied_open || file_output.close_error) {status=BM_IO;goto done;}
    r->complete = 1;
    goto done;
failed:
    status = ret == AVERROR_EXIT || (inputs[0].call.request && interrupted(&inputs[0].call)) || (inputs[1].call.request && interrupted(&inputs[1].call))
        ? BM_CANCELLED : (io && io->error < 0 ? output_error(io->error) : error_status(ret));
done:
    av_dict_free(&options);
    av_packet_free(&filtered);
    av_bsf_free(&filter);
    if (out) { out->pb = NULL; avformat_free_context(out); }
    if (io) { av_freep(&io->buffer); avio_context_free(&io); }
    cast_close(&inputs[1]);
    cast_close(&inputs[0]);
    if(writer.file) {int close_ret=avio_close(writer.file);if(close_ret<0 && status==BM_OK) status=BM_IO;}
    if(status) r->complete=0;
    r->status = status;
    return BM_OK;
}
uint32_t bm_cast_mux_v1(const BmCastRequest *q,BmCastResult *r) { return cast_mux(q,r); }


/* Read-only full packet preflight for diagnostics; no video decoding/encoding. */
uint32_t bm_cast_preflight_v1(const BmRequest *q,BmCastResult *r) {
    if(!q || !q->cancelled || !r) return BM_INVALID_REQUEST;
    BmCastInfo info;
    if(bm_cast_info_v1(sizeof(info),&info)) return BM_UNAVAILABLE;
    memset(r,0,sizeof(*r));CastInput in={0};
    uint32_t status=cast_open(&in,q,AVMEDIA_TYPE_VIDEO,AV_CODEC_ID_H264,"mov");
    if(status) goto done;
    r->profile=in.config->extradata_size>=4 && in.config->extradata[0]==1 ? in.config->extradata[1] : -1;
    r->level=in.config->extradata_size>=4 && in.config->extradata[0]==1 ? in.config->extradata[3] : -1;
    r->width=in.config->width;r->height=in.config->height;
    r->has_b_frames=in.config->video_delay>0;
    int64_t first=INT64_MAX,end=INT64_MIN,key=INT64_MIN;
    for(;;) {
        if(interrupted(&in.call)) {status=BM_CANCELLED;goto done;}
        int ret=cast_read(&in);
        if(ret<0) {status=interrupted(&in.call)?BM_CANCELLED:error_status(ret);goto done;}
        if(!ret) break;
        AVPacket *p=in.packet;int64_t pts=cast_time(&in,p->pts);
        first=FFMIN(first,pts);end=FFMAX(end,pts+cast_time(&in,p->duration));
        r->has_b_frames|=p->pts!=p->dts;
        if(p->flags&AV_PKT_FLAG_KEY) {
            if(key!=INT64_MIN) r->gop_us=FFMAX(r->gop_us,pts-key);
            key=pts;
        }
        r->packets++;r->bytes+=p->size;
    }
    if(!r->packets || key==INT64_MIN || end<=first) {status=BM_INVALID_MEDIA;goto done;}
    r->source_start_us=first;r->duration_us=end-first;r->complete=1;
done: cast_close(&in);r->status=status;return BM_OK;
}
