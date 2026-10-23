//! The iOS startup window may visit only its packaged diagnostic document and
//! the exact listener created by this process. This grants no remote IPC.
use tauri::Url;

pub(crate) fn packaged_startup(url: &Url) -> bool {
    url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/ios-startup.html"
        && url.query().is_none()
        && url.fragment().is_none()
}

pub(crate) struct HostNavigation {
    bootstrap: Option<Url>,
}

impl HostNavigation {
    pub(crate) fn new(bootstrap: Option<&str>) -> Result<Self, &'static str> {
        let bootstrap = bootstrap
            .map(|value| {
                let url = Url::parse(value).map_err(|_| "invalid_host_origin")?;
                let token = url.path().strip_prefix("/bootstrap/").unwrap_or("");
                if url.scheme() != "http"
                    || url.host_str() != Some("127.0.0.1")
                    || !url.port().is_some_and(|port| port > 0)
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                    || token.len() != 43
                    || !token
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                {
                    return Err("invalid_host_origin");
                }
                Ok(url)
            })
            .transpose()?;
        Ok(Self { bootstrap })
    }

    pub(crate) fn allows(&self, url: &Url) -> bool {
        if packaged_startup(url) {
            return true;
        }
        let Some(bootstrap) = &self.bootstrap else {
            return false;
        };
        if url == bootstrap {
            return true;
        }
        url.origin() == bootstrap.origin()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && matches!(url.path(), "/" | "/index.html")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_listener_and_the_packaged_startup_can_navigate() {
        let token = "a".repeat(43);
        let policy =
            HostNavigation::new(Some(&format!("http://127.0.0.1:12345/bootstrap/{token}")))
                .unwrap();
        for url in [
            "tauri://localhost/ios-startup.html".to_owned(),
            format!("http://127.0.0.1:12345/bootstrap/{token}"),
            "http://127.0.0.1:12345/".into(),
            "http://127.0.0.1:12345/index.html".into(),
        ] {
            assert!(policy.allows(&Url::parse(&url).unwrap()));
        }
        for url in [
            "https://www.bilibili.com/",
            "http://127.0.0.1:12346/",
            "http://localhost:12345/",
            "http://127.0.0.1:12345/remote",
            "http://127.0.0.1:12345/controller.html",
            "http://127.0.0.1:12345/api/state",
            "http://127.0.0.1:12345/?hostPlatform=android",
            "http://user@127.0.0.1:12345/",
            "http://127.0.0.1:12345/#remote",
            "tauri://localhost/remote.html",
            "tauri://localhost/ios-startup.html?next=remote",
            "tauri://other/ios-startup.html",
            "tauri://localhost:12345/ios-startup.html",
            "data:text/html,hello",
            "about:blank",
        ] {
            assert!(!policy.allows(&Url::parse(url).unwrap()), "{url}");
        }
        assert!(
            !policy.allows(
                &Url::parse(&format!(
                    "http://127.0.0.1:12345/bootstrap/{}",
                    "b".repeat(43)
                ))
                .unwrap()
            )
        );
        let failed = HostNavigation::new(None).unwrap();
        assert!(failed.allows(&Url::parse("tauri://localhost/ios-startup.html").unwrap()));
        assert!(!failed.allows(&Url::parse("http://127.0.0.1:12345/").unwrap()));
    }

    #[test]
    fn invalid_bootstrap_never_expands_the_navigation_scope() {
        for prefix in [
            "https://127.0.0.1:12345/",
            "http://localhost:12345/",
            "http://127.0.0.1/",
            "http://user@127.0.0.1:12345/",
        ] {
            assert!(
                HostNavigation::new(Some(&format!("{prefix}bootstrap/{}", "a".repeat(43))))
                    .is_err()
            );
        }
        for token in [
            "a".repeat(42),
            "a".repeat(44),
            format!("{}?x=1", "a".repeat(43)),
            format!("{}#x", "a".repeat(43)),
            format!("{}%", "a".repeat(42)),
        ] {
            assert!(
                HostNavigation::new(Some(&format!("http://127.0.0.1:12345/bootstrap/{token}")))
                    .is_err()
            );
        }
    }
}
