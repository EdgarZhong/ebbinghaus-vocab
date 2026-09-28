//! 本机 HTTPS 客户端装配。Android 的系统 HTTP 代理不会自动传给 Rust 网络栈；
//! 每次请求按目标地址查询系统 ProxySelector，避免代理切换后继续使用旧出口。

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// 云同步只连接固定的服务端，但 GET、POST、PUT 会密集交替发送。Client 内含连接池，
/// 因此只缓存不含令牌的 Client；每次 Android 请求仍先查系统代理，以代理选择为缓存键。
/// 代理切换后新请求使用新 Client，已经开始的请求自然用旧连接结束。
struct SyncClientCache {
    client: reqwest::Client,
    #[cfg(target_os = "android")]
    proxy: ProxySelection,
    #[cfg(not(target_os = "android"))]
    proxy: DesktopProxySelection,
}

static SYNC_CLIENT: OnceLock<Mutex<Option<SyncClientCache>>> = OnceLock::new();

#[cfg(not(target_os = "android"))]
#[derive(PartialEq, Eq)]
struct DesktopProxySelection {
    environment: [Option<std::ffi::OsString>; 9],
}

#[cfg(not(target_os = "android"))]
fn desktop_proxy_selection() -> DesktopProxySelection {
    // 当前固定的 reqwest 特性未启用 system-proxy；其默认代理匹配器在构造 Client
    // 时读取这些环境变量。连不用于 HTTPS 的 HTTP 项也纳入键，避免以后扩展目的地时
    // 缓存语义悄然变窄。快照只驻留进程内存，不打印可能含凭据的代理地址。
    const VARIABLES: [&str; 9] = [
        "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY",
        "all_proxy", "NO_PROXY", "no_proxy", "REQUEST_METHOD",
    ];
    DesktopProxySelection {
        environment: std::array::from_fn(|index| std::env::var_os(VARIABLES[index])),
    }
}

pub(crate) async fn sync_client(
    webview: &tauri::Webview,
    destination: &reqwest::Url,
    request_timeout: Duration,
) -> Result<reqwest::Client, ()> {
    // Android 查询同时完成系统证书验证器的 JNI 初始化，必须先于任何 Client 构造。
    // 不持锁等待 UI 线程，避免同时发起的同步请求互相阻塞代理查询。
    #[cfg(target_os = "android")]
    let proxy = android_proxy_for(webview, destination).await?;
    #[cfg(not(target_os = "android"))]
    let proxy = desktop_proxy_selection();
    #[cfg(not(target_os = "android"))]
    let _ = (webview, destination);

    let cache = SYNC_CLIENT.get_or_init(|| Mutex::new(None));
    let mut entry = cache.lock().map_err(|_| ())?;
    if let Some(cached) = entry.as_ref() {
        if cached.proxy == proxy { return Ok(cached.client.clone()); }
    }

    #[cfg(target_os = "android")]
    let builder = android_builder(&proxy)?;
    #[cfg(not(target_os = "android"))]
    let builder = reqwest::Client::builder();
    let client = builder
        .timeout(request_timeout)
        .connect_timeout(Duration::from_secs(8))
        // Bearer 仅能发往同步的固定域名；服务端意外返回 3xx 时不转发令牌。
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| ())?;
    *entry = Some(SyncClientCache {
        client: client.clone(),
        proxy,
    });
    Ok(client)
}

/// 桌面沿用 reqwest 原有代理发现；Android 明确读取系统选择，未配置时直连。
pub(crate) async fn builder(
    webview: &tauri::Webview,
    destination: &reqwest::Url,
) -> Result<reqwest::ClientBuilder, ()> {
    #[cfg(target_os = "android")]
    {
        // reqwest 构造客户端时就创建平台证书验证器；JNI 初始化必须在此之前完成。
        // 同一次原生回调还读取当前代理，任何一步失败均返回调用方而非在 worker panic。
        let proxy = android_proxy_for(webview, destination).await?;
        android_builder(&proxy)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (webview, destination);
        Ok(reqwest::Client::builder())
    }
}

#[cfg(target_os = "android")]
fn android_builder(proxy: &ProxySelection) -> Result<reqwest::ClientBuilder, ()> {
    let mut client = reqwest::Client::builder().no_proxy();
    match proxy {
        ProxySelection::Direct => {}
        ProxySelection::Http(host, port) => {
            let mut proxy_url = reqwest::Url::parse("http://localhost/").map_err(|_| ())?;
            // set_host/set_port 会拒绝代理地址中的路径、凭据和无效端口；
            // TLS 仍由目标服务器校验，HTTP 代理只承载 CONNECT 隧道。
            proxy_url.set_host(Some(host)).map_err(|_| ())?;
            proxy_url.set_port(Some(*port)).map_err(|_| ())?;
            client = client.proxy(reqwest::Proxy::https(proxy_url).map_err(|_| ())?);
        }
    }
    Ok(client)
}

#[cfg(target_os = "android")]
#[derive(PartialEq, Eq)]
enum ProxySelection {
    Direct,
    Http(String, u16),
}

#[cfg(target_os = "android")]
async fn android_proxy_for(
    webview: &tauri::Webview,
    destination: &reqwest::Url,
) -> Result<ProxySelection, ()> {
    use std::time::Duration;
    use tokio::sync::oneshot;

    let (sender, receiver) = oneshot::channel();
    let destination = destination.as_str().to_owned();
    webview.with_webview(move |platform| {
        platform.jni_handle().exec(move |env, activity, _webview| {
            let result = initialize_android_tls(env, activity)
                .and_then(|()| read_proxy_selector(env, &destination));
            let _ = sender.send(result);
        });
    }).map_err(|_| ())?;

    // Android UI 线程暂不可用时不能把云同步/探测永久挂起。
    tokio::time::timeout(Duration::from_secs(2), receiver)
        .await.map_err(|_| ())?
        .map_err(|_| ())?
}

#[cfg(target_os = "android")]
fn initialize_android_tls(
    env: &mut jni::JNIEnv<'_>,
    activity: &jni::objects::JObject<'_>,
) -> Result<(), ()> {
    use jni_verifier::{objects::JObject, EnvUnowned, Outcome};

    // Wry/Tauri 的 JNIEnv 来自 JNI 0.21，而 reqwest 依赖的验证器使用 JNI 0.22。
    // 先通过 NewLocalRef 建立独立的 Activity 引用，再把该引用所有权转给 0.22；
    // 两版仅在同一 JNI 回调内共享 ABI 原始指针，不互借包装对象或跨线程保留局部引用。
    let context = env.new_local_ref(activity).map_err(|_| {
        let _ = env.exception_clear();
    })?;
    let raw_env = env.get_raw() as *mut jni_verifier::sys::JNIEnv;
    let raw_context = context.into_raw() as jni_verifier::sys::jobject;
    // SAFETY: Wry 在当前已附加的 WebView JNI 线程调用本闭包；回调返回前 Env 与
    // 新建局部引用都有效。EnvUnowned 在此回调内完成初始化，不逃逸到异步任务。
    let mut verifier_env = unsafe { EnvUnowned::from_raw(raw_env) };
    let result = verifier_env.with_env(|env| {
        // SAFETY: raw_context 是上方 NewLocalRef 独占得到的有效局部引用。
        let context = unsafe { JObject::from_raw(env, raw_context) };
        let result = rustls_platform_verifier::android::init_with_env(env, context);
        if result.is_err() { env.exception_clear(); }
        result
    }).into_outcome();
    match result {
        Outcome::Ok(()) => Ok(()),
        Outcome::Err(_) | Outcome::Panic(_) => Err(()),
    }
}

#[cfg(target_os = "android")]
fn read_proxy_selector(
    env: &mut jni::JNIEnv<'_>,
    destination: &str,
) -> Result<ProxySelection, ()> {
    use jni::objects::JString;

    let uri_text = env.new_string(destination).map_err(|_| ())?;
    let uri = env.new_object("java/net/URI", "(Ljava/lang/String;)V", &[(&uri_text).into()])
        .map_err(|_| ())?;
    let selector = env.call_static_method(
        "java/net/ProxySelector", "getDefault", "()Ljava/net/ProxySelector;", &[]
    ).and_then(|value| value.l()).map_err(|_| ())?;
    if selector.is_null() { return Ok(ProxySelection::Direct); }
    let proxies = env.call_method(
        &selector, "select", "(Ljava/net/URI;)Ljava/util/List;", &[(&uri).into()]
    ).and_then(|value| value.l()).map_err(|_| ())?;
    if proxies.is_null() { return Err(()); }
    let count = env.call_method(&proxies, "size", "()I", &[])
        .and_then(|value| value.i()).map_err(|_| ())?;
    if count == 0 { return Ok(ProxySelection::Direct); }
    let proxy = env.call_method(&proxies, "get", "(I)Ljava/lang/Object;", &[0.into()])
        .and_then(|value| value.l()).map_err(|_| ())?;
    let proxy_type = env.call_method(&proxy, "type", "()Ljava/net/Proxy$Type;", &[])
        .and_then(|value| value.l()).map_err(|_| ())?;
    let type_name = env.call_method(&proxy_type, "name", "()Ljava/lang/String;", &[])
        .and_then(|value| value.l()).map_err(|_| ())?;
    let type_name: String = env.get_string(&JString::from(type_name))
        .map_err(|_| ())?.into();
    if type_name == "DIRECT" { return Ok(ProxySelection::Direct); }
    // SOCKS 与 PAC 无法等价映射成 HTTP CONNECT；拒绝静默直连，避免绕过设备策略。
    if type_name != "HTTP" { return Err(()); }

    let address = env.call_method(&proxy, "address", "()Ljava/net/SocketAddress;", &[])
        .and_then(|value| value.l()).map_err(|_| ())?;
    if address.is_null() { return Err(()); }
    let host = env.call_method(&address, "getHostString", "()Ljava/lang/String;", &[])
        .and_then(|value| value.l()).map_err(|_| ())?;
    if host.is_null() { return Err(()); }
    let host: String = env.get_string(&JString::from(host)).map_err(|_| ())?.into();
    let port = env.call_method(&address, "getPort", "()I", &[])
        .and_then(|value| value.i()).map_err(|_| ())?;
    if host.is_empty() || !(1..=65535).contains(&port) { return Err(()); }
    Ok(ProxySelection::Http(host, port as u16))
}
