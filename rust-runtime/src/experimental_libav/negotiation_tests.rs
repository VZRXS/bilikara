use super::*;

#[test]
fn negotiation_rejects_mismatched_runtime_facts_and_layout() {
    fn set<const N: usize>(out: &mut wire::Text<N>, value: &str) {
        out.len = value.len() as u32;
        out.bytes[..value.len()].copy_from_slice(value.as_bytes());
    }
    let mut info: wire::Info = unsafe { std::mem::zeroed() };
    info.abi = 1;
    info.request_size = std::mem::size_of::<wire::Request>() as u32;
    info.result_size = std::mem::size_of::<wire::ProbeResult>() as u32;
    info.stream_size = std::mem::size_of::<wire::Stream>() as u32;
    info.build_versions = [4129125, 4129125, 3998053];
    info.runtime_versions = info.build_versions;
    set(&mut info.backend, "bilikara_media_libav");
    set(&mut info.build_version, "9.0.1");
    set(&mut info.runtime_version, "9.0.1");
    set(&mut info.build_config, "--disable-network --enable-shared");
    for config in &mut info.runtime_configs {
        set(config, "--disable-network --enable-shared");
    }
    assert!(convert_info(&info).is_ok());
    info.runtime_versions[0] += 1;
    assert!(matches!(
        convert_info(&info),
        Err(ProbeError::NegotiationFailed(
            NegotiationFailure::LayoutOrBuild
        ))
    ));
    info.runtime_versions = info.build_versions;
    set(&mut info.runtime_configs[1], "different");
    assert!(matches!(
        convert_info(&info),
        Err(ProbeError::NegotiationFailed(
            NegotiationFailure::LayoutOrBuild
        ))
    ));
    set(
        &mut info.runtime_configs[1],
        "--disable-network --enable-shared",
    );
    info.result_size -= 1;
    assert!(matches!(
        convert_info(&info),
        Err(ProbeError::NegotiationFailed(
            NegotiationFailure::LayoutOrBuild
        ))
    ));
}
