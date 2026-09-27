//! Compatibility launch inputs. Persisted preferences take precedence over
//! defaults; update routes read only explicitly configured HTTP(S) endpoints.
use super::*;

pub(super) fn extra_sources(preview: bool) -> Vec<String> {
    urls(
        &std::env::var(if preview {
            "BILIKARA_APP_RELEASES_API_FALLBACKS"
        } else {
            "BILIKARA_APP_RELEASE_API_FALLBACKS"
        })
        .unwrap_or_default(),
    )
}

fn urls(raw: &str) -> Vec<String> {
    let mut result = Vec::new();
    for value in raw.split([',', ';', '\n']).map(str::trim) {
        if reqwest::Url::parse(value)
            .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
            && !result.iter().any(|url| url == value)
        {
            result.push(value.to_owned());
        }
    }
    result
}

pub(super) fn download_proxy() -> Option<bilikara_rust::UpdateDownloadProxy> {
    let template = std::env::var("BILIKARA_UPDATE_DOWNLOAD_PROXY").unwrap_or_default();
    let template = template.trim();
    if template.is_empty() {
        return None;
    }
    Some(bilikara_rust::UpdateDownloadProxy {
        template: template.into(),
        proxy_first: truthy(
            &std::env::var("BILIKARA_UPDATE_DOWNLOAD_PROXY_FIRST").unwrap_or_default(),
        ),
    })
}

fn truthy(raw: &str) -> bool {
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub(super) fn initial_cache_items() -> usize {
    cache_items(std::env::var("BILIKARA_MAX_CACHE_ITEMS").ok().as_deref())
}

fn cache_items(raw: Option<&str>) -> usize {
    raw.map(|raw| raw.trim().parse::<i64>().unwrap_or(1).clamp(1, 5) as usize)
        .unwrap_or(3)
}

static PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

pub(super) fn configure_port(explicit: Option<String>) -> Result<(), String> {
    let raw = explicit.or_else(|| {
        if std::env::var_os("BILIKARA_DESKTOP_PID").is_some() {
            None
        } else {
            std::env::var("BILIKARA_PORT")
                .ok()
                .filter(|v| !v.trim().is_empty())
        }
    });
    let port = raw
        .map(|raw| raw.trim().parse::<u16>())
        .transpose()
        .map_err(|_| "BILIKARA_PORT / --port must be 0–65535")?
        .unwrap_or(0);
    PORT.set(port)
        .map_err(|_| "Desktop port already configured".to_owned())
}

pub(super) fn listeners(desktop: bool) -> Result<(Vec<TcpListener>, std::net::Ipv4Addr), ApiError> {
    let raw = if desktop {
        std::env::var("BILIKARA_HOST").unwrap_or_default()
    } else {
        String::new()
    };
    let bind = match raw.trim() {
        "" => std::net::Ipv4Addr::UNSPECIFIED,
        "localhost" => std::net::Ipv4Addr::LOCALHOST,
        value => {
            use std::net::ToSocketAddrs;
            (value, 0)
                .to_socket_addrs()
                .ok()
                .and_then(|addresses| {
                    addresses
                        .filter_map(|address| match address.ip() {
                            std::net::IpAddr::V4(ip) => Some(ip),
                            _ => None,
                        })
                        .next()
                })
                .ok_or_else(|| ApiError::invalid("BILIKARA_HOST 必须指向本机 IPv4 地址"))?
        }
    };
    bind_listeners(
        bind,
        if desktop {
            PORT.get().copied().unwrap_or(0)
        } else {
            0
        },
    )
    .map(|listeners| (listeners, bind))
}

fn bind_listeners(bind: std::net::Ipv4Addr, port: u16) -> Result<Vec<TcpListener>, ApiError> {
    let error = |_| ApiError::new(503, "listen", "无法开启 BILIKARA_HOST 指定的本地服务");
    let listener = TcpListener::bind((bind, port)).map_err(error)?;
    let port = listener.local_addr().map_err(error)?.port();
    let mut listeners = vec![listener];
    // The shell always bootstraps through 127.0.0.1. A LAN-only listener must
    // retain a separate loopback listener on the same port for trusted Host I/O.
    if !bind.is_unspecified() && bind != std::net::Ipv4Addr::LOCALHOST {
        listeners.push(TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).map_err(error)?);
    }
    for listener in &listeners {
        listener.set_nonblocking(true).map_err(error)?;
    }
    Ok(listeners)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_defaults_and_separators() {
        assert_eq!(
            urls("https://a.test/x; https://b.test\nhttps://a.test/x, file:///bad"),
            vec!["https://a.test/x", "https://b.test"]
        );
        for value in ["1", "TRUE", " yes ", "on"] {
            assert!(truthy(value));
        }
        assert!(!truthy("false"));
        assert_eq!(cache_items(None), 3);
        for (value, expected) in [("-1", 1), ("0", 1), ("4", 4), ("99", 5), ("invalid", 1)] {
            assert_eq!(cache_items(Some(value)), expected);
        }
    }
    #[test]
    fn explicit_interface_keeps_loopback_companion_on_same_port() {
        let listeners = bind_listeners(std::net::Ipv4Addr::new(127, 0, 0, 2), 0).unwrap();
        assert_eq!(listeners.len(), 2);
        assert_eq!(
            listeners[0].local_addr().unwrap().port(),
            listeners[1].local_addr().unwrap().port()
        );
        assert_eq!(
            listeners[1].local_addr().unwrap().ip(),
            std::net::Ipv4Addr::LOCALHOST
        );
    }
}
