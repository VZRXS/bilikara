//! Android's in-process Rust Host. The shell resolves private storage and serves
//! the existing bundled Host/Remote assets; it owns no playlist business rules.
use bilikara_runtime::native_host::{Asset, NativeHost, RemoteExportRenderer};
use bilikara_runtime::{AppStateRequest, execute_app_state};
use serde::Serialize;
use std::sync::Arc;
use tauri::Manager;

// Operational startup result, not a second application-state authority.
struct AndroidBootstrap {
    error: Option<String>,
    host: Option<NativeHost>,
}

type AndroidHostSetup = (bool, RemoteExportRenderer, String);

// Fixed native UI action from the packaged startup document only. No URL or
// provider name comes from JavaScript; Android resolves its active component.
#[tauri::command]
async fn android_webview_diagnostics(window: tauri::WebviewWindow) -> Result<(), String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, view| {
                let result = env.call_method(
                    activity,
                    "showWebViewDiagnostics",
                    "(Landroid/webkit/WebView;)V",
                    &[jni::objects::JValue::Object(view)],
                );
                if result.is_err() {
                    let _ = env.exception_clear();
                }
                let _ = sender.send(
                    result
                        .map(|_| ())
                        .map_err(|_| "无法打开 WebView 诊断".to_owned()),
                );
            });
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "WebView 诊断操作超时".to_owned())?
}

#[derive(Serialize)]
struct AndroidAlphaStatus {
    schema_version: u32,
    stage: &'static str,
    backend: &'static str,
    revision: u64,
    host_api_ready: bool,
    persistence_ready: bool,
    playback_ready: bool,
    window_controls_ready: bool,
    bootstrap_url: String,
}

#[tauri::command]
async fn android_alpha_status(
    bootstrap: tauri::State<'_, AndroidBootstrap>,
    window: tauri::WebviewWindow,
) -> Result<AndroidAlphaStatus, String> {
    if let Some(error) = &bootstrap.error {
        return Err(error.clone());
    }
    let response = execute_app_state(AppStateRequest::Snapshot { schema_version: 1 });
    let snapshot = response.snapshot().ok_or_else(|| {
        response.error().map_or_else(
            || "Native AppState returned no snapshot".to_owned(),
            |error| format!("{}: {}", error.kind, error.message),
        )
    })?;
    let host = bootstrap
        .host
        .as_ref()
        .ok_or_else(|| "Native Host listener is unavailable".to_owned())?;
    let bootstrap_url = host.bootstrap_url().to_owned();
    let origin = tauri::Url::parse(&bootstrap_url)
        .map_err(|_| "Native Host origin is invalid".to_owned())?
        .origin()
        .ascii_serialization();
    // Install the origin-scoped window bridge before the bootstrap navigates.
    // The local-only IPC capability remains unchanged: no Remote gets IPC.
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, view| {
                let result: Result<AndroidHostSetup, jni::errors::Error> = (|| {
                    let vm = env.get_java_vm()?;
                    // Retain the class, not Activity/WebView, for HTTP workers.
                    let class = env.get_object_class(activity)?;
                    let class = env.new_global_ref(class)?;
                    let version = env
                        .call_method(activity, "installedAppVersion", "()Ljava/lang/String;", &[])?
                        .l()?;
                    let version: String = env
                        .get_string(&jni::objects::JString::from(version))?
                        .into();
                    let origin = env.new_string(origin)?;
                    let ready = env
                        .call_method(
                            activity,
                            "installHostWindowControls",
                            "(Landroid/webkit/WebView;Ljava/lang/String;)Z",
                            &[
                                jni::objects::JValue::Object(view),
                                jni::objects::JValue::Object(&origin),
                            ],
                        )?
                        .z()?;
                    let renderer: RemoteExportRenderer = Arc::new(move |spec, path| {
                        let mut env = vm
                            .attach_current_thread()
                            .map_err(|_| "export_attach".to_owned())?;
                        let result = env.with_local_frame(8, |env| -> jni::errors::Result<i32> {
                            let spec = env.new_string(spec)?;
                            let path = env.new_string(path.to_string_lossy())?;
                            let class: &jni::objects::JClass<'_> = class.as_obj().into();
                            env.call_static_method(
                                class,
                                "renderRemoteExport",
                                "(Ljava/lang/String;Ljava/lang/String;)I",
                                &[
                                    jni::objects::JValue::Object(&spec),
                                    jni::objects::JValue::Object(&path),
                                ],
                            )?
                            .i()
                        });
                        if result.is_err() {
                            let _ = env.exception_clear();
                        }
                        match result {
                            Ok(0) => Ok(()),
                            _ => Err("export_render".into()),
                        }
                    });
                    Ok((ready, renderer, version))
                })();
                if result.is_err() {
                    let _ = env.exception_clear();
                }
                let _ = sender.send(result.ok());
            });
        })
        .map_err(|_| "Cannot initialize Android window controls".to_owned())?;
    let bridge = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .ok()
            .flatten()
    })
    .await
    .map_err(|_| "Cannot initialize Android window controls".to_owned())?;
    let window_controls_ready = if let Some((ready, renderer, version)) = bridge {
        host.set_export_renderer(renderer)?;
        // Missing version facts disable release popups, never Host startup.
        let _ = host.set_app_version(&version);
        ready
    } else {
        false
    };
    Ok(AndroidAlphaStatus {
        schema_version: 3,
        stage: "native-host-alpha",
        backend: "rust",
        revision: snapshot.revision,
        host_api_ready: true,
        persistence_ready: true,
        playback_ready: true,
        window_controls_ready,
        bootstrap_url,
    })
}

fn initialize_platform_tls(app: &tauri::App) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Android main WebView is unavailable".to_owned())?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _| {
                let result = (|| {
                    // Retain the Application context, never the Activity, in the verifier.
                    let context = env
                        .call_method(
                            activity,
                            "getApplicationContext",
                            "()Landroid/content/Context;",
                            &[],
                        )
                        .and_then(|value| value.l())
                        .map_err(|_| "Android TLS application context is unavailable")?;
                    // Tauri and the verifier use different jni crate versions. Both
                    // wrappers borrow the same valid JNI frame only during this callback.
                    let mut platform_env =
                        unsafe { jni_platform::EnvUnowned::from_raw(env.get_raw().cast()) };
                    let context = context.into_raw();
                    match platform_env
                        .with_env(|env| {
                            let context = unsafe {
                                jni_platform::objects::JObject::from_raw(env, context.cast())
                            };
                            rustls_platform_verifier::android::init_with_env(env, context)
                        })
                        .into_outcome()
                    {
                        jni_platform::Outcome::Ok(()) => Ok(()),
                        _ => Err("Android platform TLS initialization failed"),
                    }
                })();
                if result.is_err() {
                    let _ = env.exception_clear();
                }
                let _ = sender.send(result);
            });
        })
        .map_err(|_| "Cannot initialize Android platform TLS".to_owned())?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "Android platform TLS initialization timed out".to_owned())?
        .map_err(str::to_owned)
}

fn initialize(app: &tauri::App) -> Result<NativeHost, String> {
    // Reqwest's platform verifier must be ready before any Host worker can use HTTPS.
    initialize_platform_tls(app)?;
    initialize_platform_media(app)?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Android app-private storage directory is unavailable".to_owned())?;
    let resolver = app.asset_resolver();
    bilikara_runtime::native_host::mobile::start(
        &directory,
        Arc::new(move |path| {
            resolver.get(path.to_owned()).map(|asset| Asset {
                bytes: asset.bytes,
                mime: asset.mime_type,
            })
        }),
    )
}

fn initialize_platform_media(app: &tauri::App) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Android main WebView is unavailable".to_owned())?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _| {
                let result = (|| -> jni::errors::Result<std::path::PathBuf> {
                    let vm = env.get_java_vm()?;
                    let class = env.get_object_class(activity)?;
                    let class = env.new_global_ref(class)?;
                    let application = env
                        .call_method(
                            activity,
                            "getApplicationContext",
                            "()Landroid/content/Context;",
                            &[],
                        )?
                        .l()?;
                    let application = env.new_global_ref(application)?;
                    let hook: bilikara_runtime::native_host::output_platform::OutputActivityHook =
                        Arc::new(move |phase| {
                            use bilikara_runtime::native_host::output_platform::OutputActivity;
                            let mode = match phase {
                                OutputActivity::Stopped => 0,
                                OutputActivity::Paused => 1,
                                OutputActivity::Playing => 2,
                            };
                            let mut env = vm
                                .attach_current_thread()
                                .map_err(|_| "purek_output_platform".to_owned())?;
                            let class: &jni::objects::JClass<'_> = class.as_obj().into();
                            let result = env
                                .call_static_method(
                                    class,
                                    "updateNetworkPlayback",
                                    "(Landroid/content/Context;I)I",
                                    &[
                                        jni::objects::JValue::Object(application.as_obj()),
                                        jni::objects::JValue::Int(mode),
                                    ],
                                )
                                .and_then(|v| v.i());
                            if result.is_err() {
                                let _ = env.exception_clear();
                            }
                            match result {
                                Ok(0) => Ok(()),
                                Ok(2) => Err("purek_output_foreground_required".into()),
                                _ => Err("purek_output_platform".into()),
                            }
                        });
                    // Startup installs once before the Host can admit output.
                    // A duplicate setup is an initialization failure, not a fallback.
                    bilikara_runtime::native_host::output_platform::install(hook)
                        .map_err(|_| jni::errors::Error::NullPtr("output resources"))?;
                    let info = env
                        .call_method(
                            activity,
                            "getApplicationInfo",
                            "()Landroid/content/pm/ApplicationInfo;",
                            &[],
                        )?
                        .l()?;
                    let directory = jni::objects::JString::from(
                        env.get_field(info, "nativeLibraryDir", "Ljava/lang/String;")?
                            .l()?,
                    );
                    let directory: String = env.get_string(&directory)?.into();
                    Ok(std::path::PathBuf::from(directory).join("libbilikara_media_libav.so"))
                })();
                if result.is_err() {
                    let _ = env.exception_clear();
                }
                let _ = sender.send(
                    result
                        .map_err(|_| "Android native library directory is unavailable".to_owned()),
                );
            });
        })
        .map_err(|_| "Cannot initialize Android media libraries".to_owned())?;
    let companion = receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "Android media initialization timed out".to_owned())??;
    bilikara_runtime::native_host::configure_android_media(&companion)
}

pub(crate) fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            android_alpha_status,
            android_webview_diagnostics
        ])
        .setup(|app| {
            // Keep the local diagnostic page usable on a read/write failure.
            // Do not retry with empty defaults or delete the user's checkpoint.
            let (host, error) = match initialize(app) {
                Ok(host) => (Some(host), None),
                Err(error) => (None, Some(error)),
            };
            app.manage(AndroidBootstrap { host, error });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Android Beta application failed");
}

// Packaged service callbacks carry only fixed operation codes and OS facts.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_bilikara_app_HostMediaPlayback_nativeStopped(
    _env: jni::JNIEnv<'_>,
    _class: jni::objects::JClass<'_>,
    reason: jni::sys::jint,
) {
    bilikara_runtime::native_host::output_platform::interrupted(reason);
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_bilikara_app_HostMediaPlayback_nativeThermal(
    _env: jni::JNIEnv<'_>,
    _class: jni::objects::JClass<'_>,
    status: jni::sys::jint,
    headroom: jni::sys::jfloat,
) {
    bilikara_runtime::native_host::output_platform::thermal(status, headroom);
}
