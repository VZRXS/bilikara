//! JNI-only cast resource bridge. Retain the packaged class and JVM, never an
//! Activity/WebView. HostCastPlatform retains only the Application and weak UI.
use bilikara_runtime::cast_platform::{
    self, CastPlatform, InitializationFailure, NetworkFacts, PlatformError,
};
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JClass, JObject, JValue},
};
use std::sync::Arc;
use tauri::Manager;

struct AndroidCast {
    vm: JavaVM,
    class: GlobalRef,
}
impl AndroidCast {
    fn call<T>(
        &self,
        action: impl FnOnce(&mut JNIEnv<'_>, &JClass<'_>) -> jni::errors::Result<T>,
    ) -> Result<T, PlatformError> {
        let mut env = self
            .vm
            .attach_current_thread()
            .map_err(|_| PlatformError::Unavailable)?;
        let class: &JClass<'_> = self.class.as_obj().into();
        let result = env.with_local_frame(16, |env| action(env, class));
        if result.is_err() {
            let _ = env.exception_clear();
        }
        result.map_err(|_| PlatformError::Unavailable)
    }
}
impl CastPlatform for AndroidCast {
    fn discovery_begin(&self, id: u64) -> bool {
        self.call(|env, class| {
            env.call_static_method(
                class,
                "acquireMulticast",
                "(J)Z",
                &[JValue::Long(id as i64)],
            )?
            .z()
        })
        .unwrap_or(false)
    }
    fn discovery_end(&self, id: u64) {
        let _ = self.call(|env, class| {
            env.call_static_method(
                class,
                "releaseMulticast",
                "(J)V",
                &[JValue::Long(id as i64)],
            )?
            .v()
        });
    }
    fn output_active(&self, id: u64, active: bool) -> Result<(), PlatformError> {
        self.output_mode(id, if active { 2 } else { 0 })
    }
    fn output_mode(&self, id: u64, mode: i32) -> Result<(), PlatformError> {
        match self.call(|env, class| {
            env.call_static_method(
                class,
                "updateNetworkPlayback",
                "(JI)I",
                &[JValue::Long(id as i64), JValue::Int(mode)],
            )?
            .i()
        })? {
            0 => Ok(()),
            2 => Err(PlatformError::ForegroundRequired),
            _ => Err(PlatformError::Unavailable),
        }
    }
    fn network_facts(&self) -> NetworkFacts {
        self.call(|env, class| {
            let value = env
                .call_static_method(class, "networkFacts", "()Ljava/lang/String;", &[])?
                .l()?;
            let text: String = env.get_string(&jni::objects::JString::from(value))?.into();
            Ok(text)
        })
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
    }
}

pub(super) fn initialize(app: &tauri::App) {
    cast_platform::initialize_optional(|| initialize_candidate(app));
}

fn initialize_candidate(app: &tauri::App) -> Result<Arc<dyn CastPlatform>, InitializationFailure> {
    let window = app
        .get_webview_window("main")
        .ok_or(InitializationFailure::InitializationFailed)?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _| {
                let result = (|| -> jni::errors::Result<Arc<dyn CastPlatform>> {
                    // Resolve with the Activity's app class loader on its JNI thread;
                    // FindClass on a later attached Rust worker cannot find app classes.
                    let activity_class = env.get_object_class(activity)?;
                    let loader = env
                        .call_method(
                            activity_class,
                            "getClassLoader",
                            "()Ljava/lang/ClassLoader;",
                            &[],
                        )?
                        .l()?;
                    let name = env.new_string("com.bilikara.app.HostCastPlatform")?;
                    let class = env
                        .call_method(
                            loader,
                            "loadClass",
                            "(Ljava/lang/String;)Ljava/lang/Class;",
                            &[JValue::Object(&name)],
                        )?
                        .l()?;
                    let class = JClass::from(class);
                    let ready = env
                        .call_static_method(
                            &class,
                            "initialize",
                            "(Landroid/app/Activity;)Z",
                            &[JValue::Object(activity)],
                        )?
                        .z()?;
                    if !ready {
                        return Err(jni::errors::Error::NullPtr(
                            "cast platform already initialized",
                        ));
                    }
                    let platform = AndroidCast {
                        vm: env.get_java_vm()?,
                        class: env.new_global_ref(class)?,
                    };
                    Ok(Arc::new(platform))
                })();
                if result.is_err() {
                    let _ = env.exception_clear();
                }
                let _ =
                    sender.send(result.map_err(|_| InitializationFailure::InitializationFailed));
            });
        })
        .map_err(|_| InitializationFailure::InitializationFailed)?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| match error {
            std::sync::mpsc::RecvTimeoutError::Timeout => {
                InitializationFailure::InitializationTimedOut
            }
            std::sync::mpsc::RecvTimeoutError::Disconnected => {
                InitializationFailure::InitializationFailed
            }
        })?
}

/// Fixed reason codes: 1 notification, 2 task/activity removal, 3 service failure,
/// 4 next's critical thermal stop. Each callback is fenced by its output lease.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_bilikara_app_HostMediaPlayback_nativeStopped(
    _env: JNIEnv<'_>,
    _class: JObject<'_>,
    reason: jni::sys::jint,
    lease: jni::sys::jlong,
) {
    if lease <= 0 {
        return;
    }
    let _ = std::panic::catch_unwind(|| {
        bilikara_runtime::native_host::cast_platform_stopped(lease as u64, reason);
        bilikara_runtime::native_host::output_platform::interrupted(lease as u64, reason);
    });
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_bilikara_app_HostMediaPlayback_nativeThermal(
    _env: JNIEnv<'_>,
    _class: JObject<'_>,
    status: jni::sys::jint,
    headroom: jni::sys::jfloat,
    lease: jni::sys::jlong,
) {
    if lease > 0 {
        let _ = std::panic::catch_unwind(|| {
            bilikara_runtime::native_host::output_platform::thermal(lease as u64, status, headroom);
        });
    }
}
