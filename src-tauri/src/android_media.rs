//! Resolve only APK-installed code. Media capability failure is nonfatal.
use jni::objects::{JObject, JString};
use std::{path::PathBuf, time::Duration};
use tauri::Manager;

fn companion_path(
    env: &mut jni::JNIEnv<'_>,
    activity: &JObject<'_>,
) -> jni::errors::Result<PathBuf> {
    let info = env
        .call_method(
            activity,
            "getApplicationInfo",
            "()Landroid/content/pm/ApplicationInfo;",
            &[],
        )?
        .l()?;
    let directory = env
        .get_field(info, "nativeLibraryDir", "Ljava/lang/String;")?
        .l()?;
    let directory: String = env.get_string(&JString::from(directory))?.into();
    Ok(PathBuf::from(directory).join("libbilikara_media_libav.so"))
}

pub(crate) fn initialize(app: &tauri::App) {
    let path = (|| {
        let window = app.get_webview_window("main")?;
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        window
            .with_webview(move |webview| {
                webview.jni_handle().exec(move |env, activity, _| {
                    let result = companion_path(env, activity);
                    if result.is_err() {
                        let _ = env.exception_clear();
                    }
                    let _ = sender.send(result.ok());
                });
            })
            .ok()?;
        receiver.recv_timeout(Duration::from_secs(5)).ok().flatten()
    })();
    // Run negotiation here, outside the JNI callback. A late callback after a
    // timeout cannot change process configuration after Host workers start.
    if let Some(path) = path {
        bilikara_runtime::native_host::configure_android_media(&path);
    } else {
        bilikara_runtime::native_host::android_media_unavailable();
    }
}
