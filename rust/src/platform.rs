pub(crate) fn normalize_machine_arch_impl(machine: &str) -> String {
    let normalized = machine.trim().to_lowercase().replace(' ', "");
    match normalized.as_str() {
        "amd64" | "x86_64" | "x64" => "x64".to_string(),
        "arm64" | "aarch64" => "arm64".to_string(),
        "i386" | "i686" | "x86" => "x86".to_string(),
        "" => "unknown".to_string(),
        _ => normalized,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_machine_architecture_aliases() {
        let cases = [
            ("amd64", "x64"),
            ("AMD64", "x64"),
            ("x86_64", "x64"),
            ("x64", "x64"),
            ("arm64", "arm64"),
            ("ARM64", "arm64"),
            ("aarch64", "arm64"),
            ("i386", "x86"),
            ("i686", "x86"),
            ("x86", "x86"),
            ("  AMD64 ", "x64"),
            ("", "unknown"),
            ("   ", "unknown"),
            ("riscv64", "riscv64"),
            ("unknown123", "unknown123"),
            ("ＲＩＳＣＶ 64", "ｒｉｓｃｖ64"),
        ];
        for (machine, expected) in cases {
            assert_eq!(normalize_machine_arch_impl(machine), expected);
        }
    }
}
