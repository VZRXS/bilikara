//! Test-only file adapter: executes the same disk implementation as the shell.
#[path = "../src/update_preferences.rs"]
mod update_preferences;

fn main() {
    let mut args = std::env::args().skip(1);
    let home = std::path::PathBuf::from(args.next().expect("owned fixture home"));
    let path = home.join(update_preferences::FILENAME);
    let result = match args.next().as_deref() {
        Some("load") => {
            serde_json::to_value(update_preferences::load(&path).expect("load preferences"))
        }
        Some("save") => {
            let preferences = serde_json::from_str(&args.next().expect("preferences JSON"))
                .expect("typed preferences");
            serde_json::to_value(
                update_preferences::save(&path, preferences).expect("save preferences"),
            )
        }
        _ => panic!("supported fixture action required"),
    };
    println!("{}", result.expect("preferences response"));
}
