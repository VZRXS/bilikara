use super::*;

#[test]
fn sample_files_are_verified_and_single_byte_corruption_is_rejected() {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../.tmp")
        .join(format!("sample-files-{}", token().unwrap()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("sample-b.ts");
    let mut bytes = include_bytes!("../../../../../../resources/cast-samples/sample-b.ts").to_vec();
    std::fs::write(&path, &bytes).unwrap();
    assert_eq!(read_path(Some(&directory)).unwrap(), bytes);
    let middle = bytes.len() / 2;
    bytes[middle] ^= 1;
    std::fs::write(&path, bytes).unwrap();
    assert_eq!(
        read_path(Some(&directory)),
        Err(SkipReason::SampleIntegrityFailed)
    );
    std::fs::remove_file(path).unwrap();
    assert_eq!(
        read_path(Some(&directory)),
        Err(SkipReason::SampleUnavailable)
    );
    std::fs::remove_dir(directory).unwrap();
}
