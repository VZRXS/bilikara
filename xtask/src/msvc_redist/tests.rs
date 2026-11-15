use super::*;
use crate::config::Environment;

// Independent static PE64 descriptors exercise import policy, never native
// loading. The separate real-MSVC test below inspects the running test binary.
pub(crate) fn pe(imports: &[&str], arm: bool) -> Vec<u8> {
    let mut bytes = vec![0_u8; 0x1a00];
    bytes[..2].copy_from_slice(b"MZ");
    bytes[0x3c..0x40].copy_from_slice(&0x80_u32.to_le_bytes());
    bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
    bytes[0x84..0x86].copy_from_slice(&(if arm { 0xaa64_u16 } else { 0x8664 }).to_le_bytes());
    bytes[0x86..0x88].copy_from_slice(&1_u16.to_le_bytes());
    bytes[0x94..0x96].copy_from_slice(&0xf0_u16.to_le_bytes());
    bytes[0x96..0x98].copy_from_slice(&0x2022_u16.to_le_bytes());
    bytes[0x98..0x9a].copy_from_slice(&0x20b_u16.to_le_bytes());
    for (offset, value) in [
        (0x104, 16_u32),
        (0x110, 0x1000),
        (0x114, (imports.len() as u32 + 1) * 20),
        (0x190, 0x1800),
        (0x194, 0x1000),
        (0x198, 0x1800),
        (0x19c, 0x200),
    ] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    for (index, name) in imports.iter().enumerate() {
        let rva = 0x1400 + index as u32 * 0x80;
        let descriptor = 0x20c + index * 20;
        bytes[descriptor..descriptor + 4].copy_from_slice(&rva.to_le_bytes());
        let start = 0x600 + index * 0x80;
        bytes[start..start + name.len()].copy_from_slice(name.as_bytes());
    }
    bytes
}

fn configuration(root: &Path, source: Option<&Path>) -> Config {
    let mut environment = Environment::default();
    if let Some(source) = source {
        environment.0.insert(
            "BILIKARA_MSVC_REDIST_DIR".into(),
            source.as_os_str().to_owned(),
        );
    }
    Config::new(
        root,
        Platform::new("windows", "x86_64").unwrap(),
        environment,
        None,
    )
    .unwrap()
}

fn write(path: &Path, imports: &[&str], arm: bool) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, pe(imports, arm)).unwrap();
}

#[test]
fn stages_only_required_recursive_closure_beside_each_executable() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("selected CRT");
    let output = temp.path().join("bilikara");
    write(&source.join("VCRUNTIME140.dll"), &["KERNEL32.dll"], false);
    write(
        &source.join("VCRUNTIME140_1.dll"),
        &["vcruntime140.dll"],
        false,
    );
    write(&source.join("msvcp140.dll"), &["vcruntime140.dll"], false);
    write(&source.join("concrt140.dll"), &[], false);
    let host = temp.path().join("host.exe");
    let updater = temp.path().join("updater.exe");
    let shell = temp.path().join("shell.exe");
    write(&host, &["VCRUNTIME140.dll", "kernel32.dll"], false);
    write(&updater, &["msvcp140.dll"], false);
    write(&shell, &["VCRUNTIME140_1.dll"], false);
    let config = configuration(temp.path(), Some(&source));
    stage(&config, &[host, updater], &output.join("_internal")).unwrap();
    stage(&config, std::slice::from_ref(&shell), &output).unwrap();
    assert_eq!(
        runtime_files(&output)
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ["vcruntime140.dll", "vcruntime140_1.dll"]
    );
    assert_eq!(
        runtime_files(&output.join("_internal"))
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ["msvcp140.dll", "vcruntime140.dll"]
    );
    assert_eq!(
        fs::read(output.join("vcruntime140.dll")).unwrap(),
        fs::read(source.join("VCRUNTIME140.dll")).unwrap()
    );
    assert!(!output.join("concrt140.dll").exists());
    // Reassembly with a smaller closure retires only its known stale CRTs.
    write(&shell, &["vcruntime140.dll"], false);
    fs::write(output.join("unrelated.txt"), "preserved").unwrap();
    stage(&config, &[shell], &output).unwrap();
    assert!(!output.join("vcruntime140_1.dll").exists());
    assert!(output.join("unrelated.txt").is_file());
}

#[test]
fn source_selection_is_explicit_absolute_and_unambiguous() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("VS redist");
    let source = root.join("x64/Microsoft.VC145.CRT");
    fs::create_dir_all(&source).unwrap();
    let mut config = configuration(temp.path(), None);
    assert!(selected_directory(&config).is_err());
    config
        .env
        .0
        .insert("VCToolsRedistDir".into(), root.as_os_str().into());
    assert_eq!(
        selected_directory(&config).unwrap(),
        source.canonicalize().unwrap()
    );
    fs::create_dir(root.join("x64/Microsoft.VC144.CRT")).unwrap();
    assert!(
        selected_directory(&config)
            .unwrap_err()
            .to_string()
            .contains("exactly one")
    );
    config
        .env
        .0
        .insert("BILIKARA_MSVC_REDIST_DIR".into(), source.as_os_str().into());
    assert_eq!(
        selected_directory(&config).unwrap(),
        source.canonicalize().unwrap()
    );
    config
        .env
        .0
        .insert("BILIKARA_MSVC_REDIST_DIR".into(), "relative/path".into());
    assert!(
        selected_directory(&config)
            .unwrap_err()
            .to_string()
            .contains("absolute")
    );
}

#[test]
fn missing_transitive_crt_and_wrong_machine_fail_before_publication() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("CRT");
    let output = temp.path().join("package");
    let shell = temp.path().join("shell.exe");
    write(&shell, &["vcruntime140_1.dll"], false);
    write(
        &source.join("vcruntime140_1.dll"),
        &["vcruntime140.dll"],
        false,
    );
    fs::create_dir(&output).unwrap();
    fs::write(output.join("vcruntime140_1.dll"), "old generated file").unwrap();
    let config = configuration(temp.path(), Some(&source));
    assert!(
        stage(&config, std::slice::from_ref(&shell), &output)
            .unwrap_err()
            .to_string()
            .contains("vcruntime140.dll")
    );
    assert_eq!(
        fs::read(output.join("vcruntime140_1.dll")).unwrap(),
        b"old generated file"
    );
    write(&source.join("vcruntime140.dll"), &[], true);
    assert!(
        stage(&config, std::slice::from_ref(&shell), &output)
            .unwrap_err()
            .to_string()
            .contains("native MSVC PE")
    );
    write(&source.join("vcruntime140.dll"), &[], false);
    write(&shell, &["vcruntime140.dll"], true);
    assert!(stage(&config, &[shell], &output).is_err());
}

#[test]
fn no_system_or_path_fallback_and_no_debug_crt_collection() {
    let temp = tempfile::tempdir().unwrap();
    let shell = temp.path().join("shell.exe");
    let output = temp.path().join("package");
    let mut config = configuration(temp.path(), None);
    write(&shell, &["vcruntime140.dll"], false);
    config
        .env
        .0
        .insert("PATH".into(), temp.path().as_os_str().into());
    write(&temp.path().join("vcruntime140.dll"), &[], false);
    assert!(
        stage(&config, std::slice::from_ref(&shell), &output)
            .unwrap_err()
            .to_string()
            .contains("requires")
    );
    write(&shell, &["vcruntime140d.dll"], false);
    assert!(
        stage(&config, std::slice::from_ref(&shell), &output)
            .unwrap_err()
            .to_string()
            .contains("Unsupported")
    );
    write(&shell, &["kernel32.dll", "unrelated-private.dll"], false);
    stage(&config, &[shell], &output).unwrap();
    assert!(runtime_files(&output).unwrap().is_empty());
}

#[test]
fn installed_crts_must_be_the_exact_native_executable_closure() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path();
    let shell = directory.join("bilikara-desktop.exe");
    write(&shell, &["vcruntime140_1.dll"], false);
    let platform = Platform::new("windows", "x86_64").unwrap();
    assert!(
        installed(directory, std::slice::from_ref(&shell), platform)
            .unwrap()
            .is_empty()
    );
    write(
        &directory.join("vcruntime140_1.dll"),
        &["vcruntime140.dll"],
        false,
    );
    assert!(installed(directory, std::slice::from_ref(&shell), platform).is_err());
    write(&directory.join("vcruntime140.dll"), &[], false);
    assert_eq!(
        installed(directory, std::slice::from_ref(&shell), platform)
            .unwrap()
            .len(),
        2
    );
    write(&directory.join("concrt140.dll"), &[], false);
    assert!(
        installed(directory, std::slice::from_ref(&shell), platform)
            .unwrap_err()
            .to_string()
            .contains("outside")
    );
    fs::remove_file(directory.join("concrt140.dll")).unwrap();
    write(&directory.join("vcruntime140.dll"), &[], true);
    assert!(installed(directory, &[shell], platform).is_err());
}

#[test]
fn output_overlap_is_rejected_without_changing_selected_redist_inputs() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("selected-CRT");
    let shell = temp.path().join("shell.exe");
    write(&shell, &["vcruntime140.dll"], false);
    write(&source.join("vcruntime140.dll"), &[], false);
    write(&source.join("concrt140.dll"), &[], false);
    let config = configuration(temp.path(), Some(&source));
    for output in [source.clone(), source.join("child"), temp.path().to_owned()] {
        assert!(
            stage(&config, std::slice::from_ref(&shell), &output)
                .unwrap_err()
                .to_string()
                .contains("separate directories")
        );
        assert_eq!(
            fs::read(source.join("vcruntime140.dll")).unwrap(),
            pe(&[], false)
        );
        assert_eq!(
            fs::read(source.join("concrt140.dll")).unwrap(),
            pe(&[], false)
        );
        assert!(!source.join("child").exists());
    }
}

#[test]
fn release_cleanup_preserves_a_selected_redist_inside_the_old_product() {
    let temp = tempfile::tempdir().unwrap();
    let product = temp.path().join(".tmp/output/bilikara");
    let source = product.join("redist");
    let shell = temp.path().join("host.exe");
    write(&shell, &["vcruntime140.dll"], false);
    write(&source.join("vcruntime140.dll"), &[], false);
    let config = configuration(temp.path(), Some(&source));
    let selected = input_directory(&config, &[shell]).unwrap().unwrap();
    assert!(
        crate::release::clean_product(
            &config,
            product.parent().unwrap(),
            "bilikara",
            &[&selected],
        )
        .unwrap_err()
        .to_string()
        .contains("overlaps a prepared input")
    );
    assert_eq!(
        fs::read(source.join("vcruntime140.dll")).unwrap(),
        pe(&[], false)
    );
}

#[cfg(windows)]
#[test]
#[ignore = "requires the selected native MSVC redistributable environment"]
fn selected_real_msvc_crts_match_actual_native_executable_imports() {
    let temp = tempfile::tempdir().unwrap();
    let config = Config::new(
        temp.path(),
        Platform::current().unwrap(),
        Environment::current(),
        None,
    )
    .unwrap();
    let roots = [std::env::current_exe().unwrap()];
    stage(&config, &roots, temp.path()).unwrap();
    let actual = installed(temp.path(), &roots, config.platform).unwrap();
    assert!(
        !actual.is_empty(),
        "Native MSVC test executable must exercise the direct CRT imports"
    );
}
