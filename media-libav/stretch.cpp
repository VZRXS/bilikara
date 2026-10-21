// Pinned, native Signalsmith. Exceptions must never cross the project C ABI.
#include "probe.h"
#include "signalsmith/signalsmith-stretch.h"
#include <cmath>

struct Voice {
    signalsmith::stretch::SignalsmithStretch<float> stretch{0};
    Voice() { stretch.presetDefault(2,48000,false); }
};
struct Input {
    const float *data;
    struct Channel {const float *data; float operator[](int n) const {return data[n*2];}};
    Channel operator[](int c) const {return {data+c};}
};
struct Output {
    float *data;
    struct Channel {float *data; float &operator[](int n) const {return data[n*2];}};
    Channel operator[](int c) const {return {data+c};}
};
void *bm_stretch_new_v1(void) {try{return new Voice;}catch(...){return nullptr;}}
void bm_stretch_free_v1(void *v) {delete static_cast<Voice *>(v);}
uint32_t bm_stretch_latency_v1(void *v) {
    if(!v) return 0;
    auto &s=static_cast<Voice *>(v)->stretch;
    return static_cast<uint32_t>(s.inputLatency()+s.outputLatency());
}
int32_t bm_stretch_prime_v1(void *v,const float *in,uint32_t count,float key) {
    if(!v||!in||count!=bm_stretch_latency_v1(v)||!std::isfinite(key)||std::abs(key)>12) return BM_INVALID_REQUEST;
    try {auto &s=static_cast<Voice *>(v)->stretch;s.setTransposeSemitones(key);s.outputSeek(Input{in},static_cast<int>(count));return BM_OK;}
    catch(...){return BM_BACKEND_FAILURE;}
}
int32_t bm_stretch_process_v1(void *v,const float *in,uint32_t ni,float *out,uint32_t no,float key) {
    if(!v||!in||!out||ni>8192||!ni||!no||no>4096||!std::isfinite(key)||std::abs(key)>12) return BM_INVALID_REQUEST;
    try {auto &s=static_cast<Voice *>(v)->stretch;s.setTransposeSemitones(key);s.process(Input{in},static_cast<int>(ni),Output{out},static_cast<int>(no));return BM_OK;}
    catch(...){return BM_BACKEND_FAILURE;}
}
