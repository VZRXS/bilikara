// Compile the actual pure shell policy on Linux without linking UIKit/Tauri.
// Operational entry points are exercised on Apple CI and browser bridge tests.
#[expect(
    dead_code,
    reason = "The portable facade tests policy; UIKit consumes the remaining entry points"
)]
#[path = "../../src-tauri/src/ios_bridge_policy.rs"]
mod policy;
