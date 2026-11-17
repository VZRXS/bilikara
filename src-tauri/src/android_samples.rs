//! Resolve the packaged sample provider through the application's class loader.
use bilikara_runtime::{
    cast_samples::{self, SamplePlatform},
    dlna::diagnostics::SkipReason,
};
use jni::{
    JavaVM,
    objects::{GlobalRef, JClass, JString, JValue},
};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tauri::Manager;

struct AndroidSamples {
    vm: JavaVM,
    class: GlobalRef,
    root: PathBuf,
}
impl AndroidSamples {
    fn call(&self, method: &str, signature: &str) -> jni::errors::Result<jni::sys::jint> {
        let mut env = self.vm.attach_current_thread()?;
        let class: &JClass<'_> = self.class.as_obj().into();
        let result = env
            .call_static_method(class, method, signature, &[])
            .and_then(|v| {
                if signature == "()I" {
                    v.i()
                } else {
                    v.v().map(|()| 0)
                }
            });
        if result.is_err() {
            let _ = env.exception_clear();
        }
        result
    }
}
impl SamplePlatform for AndroidSamples {
    fn root(&self) -> PathBuf {
        self.root.clone()
    }
    fn prepare(&self) -> Result<(), SkipReason> {
        match self.call("prepare", "()I") {
            Ok(0) => Ok(()),
            Ok(1) => Err(SkipReason::PlatformUnavailable),
            Ok(2) => Err(SkipReason::SampleStorageInsufficient),
            _ => Err(SkipReason::SampleCopyFailed),
        }
    }
    fn cleanup(&self) {
        let _ = self.call("cleanup", "()V");
    }
}
pub(crate) fn initialize(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let _ = window.with_webview(move |webview| {
        webview.jni_handle().exec(move |env, activity, _| {
            let result = (|| -> jni::errors::Result<AndroidSamples> {
                let activity_class = env.get_object_class(activity)?;
                let loader = env
                    .call_method(
                        activity_class,
                        "getClassLoader",
                        "()Ljava/lang/ClassLoader;",
                        &[],
                    )?
                    .l()?;
                let name = env.new_string("com.bilikara.app.HostCastSamples")?;
                let class = env
                    .call_method(
                        loader,
                        "loadClass",
                        "(Ljava/lang/String;)Ljava/lang/Class;",
                        &[JValue::Object(&name)],
                    )?
                    .l()?;
                let class = JClass::from(class);
                let root = env
                    .call_static_method(
                        &class,
                        "initialize",
                        "(Landroid/app/Activity;)Ljava/lang/String;",
                        &[JValue::Object(activity)],
                    )?
                    .l()?;
                let root: String = env.get_string(&JString::from(root))?.into();
                Ok(AndroidSamples {
                    vm: env.get_java_vm()?,
                    class: env.new_global_ref(class)?,
                    root: root.into(),
                })
            })();
            if result.is_err() {
                let _ = env.exception_clear();
            }
            let _ = sender.send(result.ok());
        });
    });
    // A late callback cannot install a provider after Host initialization.
    if let Ok(Some(platform)) = receiver.recv_timeout(Duration::from_secs(5)) {
        cast_samples::configure(Arc::new(platform));
    }
}
