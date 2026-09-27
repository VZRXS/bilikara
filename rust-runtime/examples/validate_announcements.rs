//! Read-only publication gate: the same bounded schema as the native client.
use std::io::Read;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("Usage: validate_announcements <index.json>")?;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take((bilikara_runtime::announcements::MAX_FEED_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    bilikara_runtime::announcements::validate_manifest(&bytes)?;
    println!("Announcement manifest is valid ({} bytes)", bytes.len());
    Ok(())
}
