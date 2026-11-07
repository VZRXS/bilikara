//! Foreground playback policy only. WebKit retains media/output ownership;
//! interruptions, background playback and route recovery require separate work.
use objc2_avf_audio::{AVAudioSession, AVAudioSessionCategoryPlayback};

pub(crate) fn configure() -> Result<(), &'static str> {
    // SAFETY: Called once by iOS application setup before WebView creation.
    // The shared session is retained for this call and the SDK category is a
    // constant NSString. Raw NSError details never cross the startup boundary.
    unsafe {
        let category = AVAudioSessionCategoryPlayback.ok_or("audio_session_unavailable")?;
        AVAudioSession::sharedInstance()
            .setCategory_error(category)
            .map_err(|_| "audio_session_configuration_failed")
    }
    // Do not activate on launch: the first real playback should activate audio,
    // without interrupting another app just because the Host page was opened.
}
