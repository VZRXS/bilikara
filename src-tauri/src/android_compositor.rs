//! JNI bridge to HostCastCompositor (composited cast, L2 external video).
//! Retains only the packaged class and the JVM; each stream is a Kotlin
//! session id that Drop closes.
use bilikara_runtime::cast_compositor::{self, Compositor, Request, Stream, Unit};
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JByteArray, JClass, JObject, JString, JValue},
};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

struct Bridge {
    vm: JavaVM,
    class: GlobalRef,
}
impl Bridge {
    fn call<T>(
        &self,
        action: impl FnOnce(&mut JNIEnv<'_>, &JClass<'_>) -> jni::errors::Result<T>,
    ) -> Result<T, String> {
        let mut env = self
            .vm
            .attach_current_thread()
            .map_err(|_| "compositor thread attach failed".to_owned())?;
        let class: &JClass<'_> = self.class.as_obj().into();
        let result = env.with_local_frame(16, |env| action(env, class));
        result.map_err(|error| describe(&mut env, error))
    }
}

/// A Java exception's message, or the JNI error; clears the exception.
fn describe(env: &mut JNIEnv<'_>, error: jni::errors::Error) -> String {
    let Ok(throwable) = env.exception_occurred() else {
        return error.to_string();
    };
    if throwable.is_null() {
        return error.to_string();
    }
    let _ = env.exception_clear();
    env.call_method(&throwable, "toString", "()Ljava/lang/String;", &[])
        .and_then(|value| value.l())
        .and_then(|value| env.get_string(&JString::from(value)).map(String::from))
        .unwrap_or_else(|_| error.to_string())
        .chars()
        .take(300)
        .collect()
}

struct AndroidCompositor(Arc<Bridge>);
impl Compositor for AndroidCompositor {
    fn name(&self) -> &'static str {
        "android_mediacodec"
    }
    fn open(&self, request: &Request) -> Result<Box<dyn Stream>, String> {
        let path = request
            .video
            .to_str()
            .ok_or("non-UTF-8 media path")?
            .to_owned();
        let id = self.0.call(|env, class| {
            let path = env.new_string(&path)?;
            env.call_static_method(
                class,
                "open",
                "(Ljava/lang/String;JJIIIII)J",
                &[
                    JValue::Object(&path),
                    JValue::Long(request.start_us),
                    JValue::Long(request.end_us),
                    JValue::Int(request.width as i32),
                    JValue::Int(request.height as i32),
                    JValue::Int(request.fps.0 as i32),
                    JValue::Int(request.fps.1 as i32),
                    JValue::Int(request.bit_rate as i32),
                ],
            )?
            .j()
        })?;
        Ok(Box::new(AndroidStream {
            bridge: self.0.clone(),
            id,
            ended: false,
        }))
    }
}

struct AndroidStream {
    bridge: Arc<Bridge>,
    id: i64,
    ended: bool,
}
impl Stream for AndroidStream {
    fn next(&mut self, cancelled: &AtomicBool) -> Result<Option<Unit>, String> {
        if self.ended {
            return Ok(None);
        }
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err("cancelled".into());
            }
            let packed = self.bridge.call(|env, class| {
                let value = env
                    .call_static_method(
                        class,
                        "next",
                        "(JI)[B",
                        &[JValue::Long(self.id), JValue::Int(200)],
                    )?
                    .l()?;
                if value.is_null() {
                    return Ok(None);
                }
                env.convert_byte_array(JByteArray::from(value)).map(Some)
            })?;
            let Some(packed) = packed else { continue };
            if packed.len() < 17 {
                return Err("short compositor unit".into());
            }
            let flags = packed[0];
            if flags & 2 != 0 {
                self.ended = true;
                return Ok(None);
            }
            let pts = i64::from_be_bytes(packed[1..9].try_into().unwrap());
            let dts = i64::from_be_bytes(packed[9..17].try_into().unwrap());
            return Ok(Some(Unit {
                data: packed[17..].to_vec(),
                key: flags & 1 != 0,
                pts_us: pts,
                dts_us: dts,
            }));
        }
    }
    fn encoder(&self) -> String {
        self.bridge
            .call(|env, class| {
                let value = env
                    .call_static_method(
                        class,
                        "encoderName",
                        "(J)Ljava/lang/String;",
                        &[JValue::Long(self.id)],
                    )?
                    .l()?;
                env.get_string(&JString::from(value)).map(String::from)
            })
            .unwrap_or_default()
    }
    fn set_overlay(&mut self, rgba: &[u8]) -> Result<(), String> {
        self.bridge.call(|env, class| {
            let array = env.byte_array_from_slice(rgba)?;
            env.call_static_method(
                class,
                "setOverlay",
                "(J[B)V",
                &[JValue::Long(self.id), JValue::Object(&JObject::from(array))],
            )?
            .v()
        })
    }
}
impl Drop for AndroidStream {
    fn drop(&mut self) {
        let _ = self.bridge.call(|env, class| {
            env.call_static_method(class, "close", "(J)V", &[JValue::Long(self.id)])?
                .v()
        });
    }
}

/// Installs the MediaCodec compositor. Optional: without it the companion
/// has no H.264 encoder on Android, and composited casts fall back to L1.
pub(super) fn initialize(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("cast_compositor_unavailable");
        return;
    };
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let posted = window.with_webview(move |webview| {
        webview.jni_handle().exec(move |env, activity, _| {
            let result = (|| -> jni::errors::Result<Bridge> {
                // App classes resolve only through the Activity's class loader.
                let activity_class = env.get_object_class(activity)?;
                let loader = env
                    .call_method(
                        activity_class,
                        "getClassLoader",
                        "()Ljava/lang/ClassLoader;",
                        &[],
                    )?
                    .l()?;
                let name = env.new_string("com.bilikara.app.HostCastCompositor")?;
                let class = env
                    .call_method(
                        loader,
                        "loadClass",
                        "(Ljava/lang/String;)Ljava/lang/Class;",
                        &[JValue::Object(&name)],
                    )?
                    .l()?;
                Ok(Bridge {
                    vm: env.get_java_vm()?,
                    class: env.new_global_ref(JClass::from(class))?,
                })
            })();
            if result.is_err() {
                let _ = env.exception_clear();
            }
            let _ = sender.send(result.ok());
        });
    });
    if posted.is_err() {
        eprintln!("cast_compositor_unavailable");
        return;
    }
    match receiver.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Some(bridge)) => {
            if cast_compositor::install(Arc::new(AndroidCompositor(Arc::new(bridge)))).is_err() {
                eprintln!("cast_compositor_already_installed");
            } else {
                eprintln!("cast_compositor_ready android_mediacodec");
            }
        }
        _ => eprintln!("cast_compositor_unavailable"),
    }
}
