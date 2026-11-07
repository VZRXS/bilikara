/* L1 codec/resampler I/O only. Rust supplies canonical PCM/DSP decisions. */
#include <libswresample/swresample.h>
#define L1_RATE 48000
#define L1_CACHE (L1_RATE*16)
#define L1_CONVERT 400000

typedef struct {
    LiveInput input;
    AVCodecContext *decoder;
    SwrContext *swr;
    AVFrame *frame;
    float *cache,*converted;
    int64_t base;
    int count,head,draining,done;
} L1Source;
typedef struct {
    const BmL1Request *request;
    L1Source sources[2];
    AVCodecContext *encoder;
    AVFrame *frame;
    int64_t source_us,source_frame,frames,sent;
    int draining;
    float pcm[1024*2];
} L1Audio;

static void l1_source_close(L1Source *s) {
    avcodec_free_context(&s->decoder);swr_free(&s->swr);av_frame_free(&s->frame);
    av_freep(&s->cache);av_freep(&s->converted);live_close(&s->input);
}
static uint32_t l1_source_open(L1Source *s,const BmRequest *q) {
    uint8_t magic[4];
    /* Descriptor-only format detection. live_open independently checks scope. */
    if(q->fd<0 || !q->cancelled) return BM_INVALID_REQUEST;
    if(interrupted(&(Call){.request=q})) return BM_CANCELLED;
#ifdef _WIN32
    if(!bm_regular_fd(q->fd) || _lseeki64(q->fd,0,SEEK_SET)<0 || _read(q->fd,magic,4)!=4 || _lseeki64(q->fd,0,SEEK_SET)<0) return BM_IO;
#else
    struct stat st;
    if(fstat(q->fd,&st)||!S_ISREG(st.st_mode)) return BM_INVALID_REQUEST;
    if(lseek(q->fd,0,SEEK_SET)<0||read(q->fd,magic,4)!=4||lseek(q->fd,0,SEEK_SET)<0) return BM_IO;
#endif
    uint32_t status=live_open(&s->input,q,AVMEDIA_TYPE_AUDIO,AV_CODEC_ID_NONE,!memcmp(magic,"fLaC",4)?"flac":"mov");
    if(status) return status;
    AVCodecParameters *p=s->input.format->streams[0]->codecpar;
    if(p->codec_id!=AV_CODEC_ID_AAC && p->codec_id!=AV_CODEC_ID_FLAC && p->codec_id!=AV_CODEC_ID_EAC3 &&
       p->codec_id!=AV_CODEC_ID_AC3 && p->codec_id!=AV_CODEC_ID_MP3 && p->codec_id!=AV_CODEC_ID_OPUS) return BM_UNSUPPORTED_CODEC;
    if(p->sample_rate<8000||p->sample_rate>192000||p->ch_layout.nb_channels<1||p->ch_layout.nb_channels>8||
       !av_channel_layout_check(&p->ch_layout)) return BM_UNSUPPORTED_LAYOUT;
    const AVCodec *codec=avcodec_find_decoder(p->codec_id);
    if(!codec) return BM_UNSUPPORTED_CODEC;
    s->decoder=avcodec_alloc_context3(codec);s->frame=av_frame_alloc();
    s->cache=av_malloc_array(L1_CACHE*2,sizeof(float));s->converted=av_malloc_array(L1_CONVERT*2,sizeof(float));
    if(!s->decoder||!s->frame||!s->cache||!s->converted) return BM_BACKEND_FAILURE;
    int ret=avcodec_parameters_to_context(s->decoder,p);
    s->decoder->thread_count=1;s->decoder->pkt_timebase=s->input.format->streams[0]->time_base;
    s->decoder->err_recognition=AV_EF_CRCCHECK|AV_EF_BITSTREAM|AV_EF_BUFFER|AV_EF_EXPLODE;
    if(ret>=0) ret=avcodec_open2(s->decoder,codec,NULL);
    if(ret<0) return error_status(ret);
    AVChannelLayout stereo=AV_CHANNEL_LAYOUT_STEREO;
    ret=swr_alloc_set_opts2(&s->swr,&stereo,AV_SAMPLE_FMT_FLT,L1_RATE,&p->ch_layout,s->decoder->sample_fmt,p->sample_rate,0,NULL);
    if(ret>=0) ret=swr_init(s->swr);
    return ret<0?error_status(ret):BM_OK;
}
static int l1_append(L1Source *s,int64_t start,int count) {
    if(start < -INT64_C(604800)*L1_RATE || start > INT64_C(604800)*L1_RATE || count<0 || count>L1_CONVERT) return AVERROR_INVALIDDATA;
    if(!count) return 0;
    if(!s->count) s->base=start;
    int64_t gap=start-(s->base+s->count);
    /* Accept only sample-clock quantization, never silently bridge bad media. */
    if(gap < -48 || gap > 48) return AVERROR_INVALIDDATA;
    int skip=gap<0?(int)FFMIN(-gap,count):0;
    int zeros=gap>0?(int)gap:0;
    int add=count-skip+zeros;
    if(s->count+add>L1_CACHE) {
        int drop=s->count+add-L1_CACHE;
        s->head=(s->head+drop)%L1_CACHE;s->base+=drop;s->count-=drop;
    }
    for(int n=0;n<zeros;n++) {int index=(s->head+s->count+n)%L1_CACHE;s->cache[index*2]=s->cache[index*2+1]=0;}
    s->count+=zeros;
    for(int n=skip*2;n<count*2;n++) if(!isfinite(s->converted[n])) return AVERROR_INVALIDDATA;
    int position=(s->head+s->count)%L1_CACHE;
    int first=FFMIN(count-skip,L1_CACHE-position);
    memcpy(s->cache+position*2,s->converted+skip*2,first*2*sizeof(float));
    memcpy(s->cache,s->converted+(skip+first)*2,(count-skip-first)*2*sizeof(float));
    s->count+=count-skip;return 0;
}
static int l1_decode(L1Source *s) {
    for(;;) {
        if(interrupted(&s->input.call)) return AVERROR_EXIT;
        int ret=avcodec_receive_frame(s->decoder,s->frame);
        if(ret==AVERROR_EOF) {
            int64_t start=s->base+s->count;
            uint8_t *out=(uint8_t *)s->converted;
            int count=swr_convert(s->swr,&out,L1_CONVERT,NULL,0);
            if(count<0) return count;
            ret=l1_append(s,start,count);s->done=1;return ret;
        }
        if(ret>=0) {
            AVFrame *f=s->frame;
            if(f->nb_samples<=0||f->nb_samples>65536||f->pts==AV_NOPTS_VALUE||f->decode_error_flags||
               f->sample_rate!=s->decoder->sample_rate||f->format!=s->decoder->sample_fmt||
               av_channel_layout_compare(&f->ch_layout,&s->decoder->ch_layout)) {av_frame_unref(f);return AVERROR_INVALIDDATA;}
            int64_t position=av_rescale_q(f->pts,s->input.format->streams[0]->time_base,(AVRational){1,L1_RATE});
            int64_t delay=swr_get_delay(s->swr,L1_RATE);
            if(position < -INT64_C(604800)*L1_RATE || position > INT64_C(604800)*L1_RATE || delay<0 || delay>L1_CONVERT) {av_frame_unref(f);return AVERROR_INVALIDDATA;}
            int64_t start=position-delay;
            uint8_t *out=(uint8_t *)s->converted;
            int count=swr_convert(s->swr,&out,L1_CONVERT,(const uint8_t **)f->extended_data,f->nb_samples);
            av_frame_unref(f);
            if(count<0) return count;
            return l1_append(s,start,count);
        }
        if(ret!=AVERROR(EAGAIN)||s->draining) return ret;
        ret=live_read(&s->input);
        if(ret<0) return ret;
        if(!ret) {s->draining=1;ret=avcodec_send_packet(s->decoder,NULL);}
        else ret=avcodec_send_packet(s->decoder,s->input.packet);
        if(ret<0) return ret;
    }
}
static int l1_seek(L1Source *s,int64_t target) {
    int64_t timestamp=av_rescale_q(FFMAX(0,target-L1_RATE/4),(AVRational){1,L1_RATE},s->input.format->streams[0]->time_base);
    int ret=av_seek_frame(s->input.format,0,timestamp,AVSEEK_FLAG_BACKWARD);
    if(ret<0) return ret;
    avcodec_flush_buffers(s->decoder);swr_close(s->swr);ret=swr_init(s->swr);
    s->count=s->head=0;s->draining=s->done=s->input.eof=0;return ret;
}
static int32_t l1_read(void *opaque,uint32_t track,int64_t start,uint32_t frames,float *out) {
    L1Audio *a=opaque;
    if(track>=a->request->tracks||!frames||frames>16384||!out||
       start < -INT64_C(604800)*L1_RATE||start>INT64_C(604800)*L1_RATE) return BM_INVALID_REQUEST;
    L1Source *s=&a->sources[track];
    memset(out,0,frames*2*sizeof(float));
    int64_t end=start+frames;
    if(end<=0) return BM_OK;
    int64_t wanted=FFMAX(0,start);
    if((s->count && wanted<s->base) || (!s->done && wanted>s->base+s->count+L1_CACHE-L1_RATE)) {
        int ret=l1_seek(s,wanted);if(ret<0) return error_status(ret);
    }
    while(!s->done && s->base+s->count<end) {
        int ret=l1_decode(s);if(ret<0) return interrupted(&s->input.call)?BM_CANCELLED:error_status(ret);
    }
    if(wanted<s->base) {
        // Only leading silence before an actual positive stream start is valid.
        AVStream *stream=s->input.format->streams[0];
        int64_t declared=stream->start_time==AV_NOPTS_VALUE?0:av_rescale_q(stream->start_time,stream->time_base,(AVRational){1,L1_RATE});
        if(wanted>=declared) return BM_INVALID_MEDIA;
    }
    int64_t begin=FFMAX(wanted,s->base),limit=FFMIN(end,s->base+s->count);
    if(limit>begin) {
        int position=(s->head+(int)(begin-s->base))%L1_CACHE;
        int first=(int)FFMIN(limit-begin,L1_CACHE-position);
        memcpy(out+(begin-start)*2,s->cache+position*2,first*2*sizeof(float));
        memcpy(out+(begin-start+first)*2,s->cache,(size_t)(limit-begin-first)*2*sizeof(float));
    }
    return BM_OK;
}
static void l1_release(LiveInput *in) {
    L1Audio *a=in->state;if(!a) return;
    for(int n=0;n<2;n++) l1_source_close(&a->sources[n]);
    avcodec_free_context(&a->encoder);av_frame_free(&a->frame);av_free(a);in->state=NULL;
}
static int l1_next(LiveInput *in) {
    L1Audio *a=in->state;
    for(;;) {
        if(interrupted(&in->call)) return AVERROR_EXIT;
        int ret=avcodec_receive_packet(a->encoder,in->packet);
        if(ret==AVERROR_EOF) {in->eof=1;return 0;}
        if(ret>=0) return 1;
        if(ret!=AVERROR(EAGAIN)||a->draining) return ret;
        if(a->sent>=a->frames) {a->draining=1;ret=avcodec_send_frame(a->encoder,NULL);}
        else {
            int32_t status=a->request->render(a->request->opaque,l1_read,a,a->source_us,a->sent,1024,a->pcm);
            if(status) return status==BM_CANCELLED?AVERROR_EXIT:AVERROR_INVALIDDATA;
            ret=av_frame_make_writable(a->frame);if(ret<0) return ret;
            int count=(int)FFMIN(1024,a->frames-a->sent);
            for(int n=0;n<1024;n++) for(int c=0;c<2;c++) {
                float value=n<count?a->pcm[n*2+c]:0;
                if(!isfinite(value)) return AVERROR_INVALIDDATA;
                ((float *)a->frame->data[c])[n]=value;
            }
            a->frame->pts=a->source_frame+a->sent;a->sent+=count;
            ret=avcodec_send_frame(a->encoder,a->frame);
        }
        if(ret<0) return ret;
    }
}
uint32_t bm_l1_info_v1(uint32_t size,BmLiveInfo *info) {
    BmLiveInfo base;
    if(!info||size!=sizeof(*info)||bm_live_info_v1(sizeof(base),&base)||!avcodec_find_encoder(AV_CODEC_ID_AAC)||
       swresample_version()!=LIBSWRESAMPLE_VERSION_INT||strcmp(swresample_configuration(),BM_BUILD_CONFIG)) return BM_UNAVAILABLE;
    *info=(BmLiveInfo){1,sizeof(BmL1Request),sizeof(BmLiveResult)};return BM_OK;
}
static uint32_t l1_audio_open(LiveInput *in,const BmL1Request *q,int64_t source_us,int64_t end_us) {
    L1Audio *a=av_mallocz(sizeof(*a));
    if(!a) return BM_BACKEND_FAILURE;
    in->state=a;in->release=l1_release;in->next=l1_next;in->call.request=&q->live.video;
    a->request=q;a->source_us=source_us;a->source_frame=av_rescale_q(source_us,AV_TIME_BASE_Q,(AVRational){1,L1_RATE});
    a->frames=av_rescale_q(end_us-source_us,AV_TIME_BASE_Q,(AVRational){1,L1_RATE});
    if(a->frames<=0||a->frames>INT64_C(21600)*L1_RATE) return BM_UNSUPPORTED_LAYOUT;
    for(uint32_t n=0;n<q->tracks;n++) {uint32_t status=l1_source_open(&a->sources[n],&q->audio[n]);if(status) return status;}
    const AVCodec *codec=avcodec_find_encoder(AV_CODEC_ID_AAC);
    a->encoder=avcodec_alloc_context3(codec);a->frame=av_frame_alloc();in->packet=av_packet_alloc();in->format=avformat_alloc_context();
    if(!a->encoder||!a->frame||!in->packet||!in->format) return BM_BACKEND_FAILURE;
    AVCodecContext *e=a->encoder;
    e->sample_rate=L1_RATE;e->sample_fmt=AV_SAMPLE_FMT_FLTP;e->ch_layout=(AVChannelLayout)AV_CHANNEL_LAYOUT_STEREO;
    e->bit_rate=192000;e->profile=AV_PROFILE_AAC_LOW;e->time_base=(AVRational){1,L1_RATE};e->thread_count=1;
    int ret=avcodec_open2(e,codec,NULL);if(ret<0) return error_status(ret);
    if(e->frame_size!=1024||e->sample_fmt!=AV_SAMPLE_FMT_FLTP) return BM_UNSUPPORTED_LAYOUT;
    a->frame->nb_samples=1024;a->frame->sample_rate=L1_RATE;a->frame->format=e->sample_fmt;
    ret=av_channel_layout_copy(&a->frame->ch_layout,&e->ch_layout);
    if(ret>=0) ret=av_frame_get_buffer(a->frame,0);
    if(ret<0) return error_status(ret);
    AVStream *stream=avformat_new_stream(in->format,NULL);if(!stream) return BM_BACKEND_FAILURE;
    stream->time_base=e->time_base;in->format->bit_rate=e->bit_rate;
    ret=avcodec_parameters_from_context(stream->codecpar,e);
    return ret<0?error_status(ret):BM_OK;
}
uint32_t bm_live_l1_v1(const BmL1Request *q,BmLiveResult *r) {
    BmLiveInfo info;
    if(!q||!r||!q->render||!q->tracks||q->tracks>2) return BM_INVALID_REQUEST;
    if(bm_l1_info_v1(sizeof(info),&info)) return BM_UNAVAILABLE;
    return live_mux(&q->live,q,r);
}
