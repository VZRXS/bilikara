//! Shared HTTP transport setup. Desktop keeps the platform trust store. Android
//! uses Mozilla's compiled root certificates, so networking does not depend on
//! a JVM/class-loader initialization hook. Chain, hostname and expiry validation
//! remain enabled; updating the app also updates this locked trust-store package.
pub(crate) fn builder() -> reqwest::blocking::ClientBuilder {
    let builder = reqwest::blocking::Client::builder();
    #[cfg(target_os = "android")]
    let builder =
        builder.tls_certs_only(webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().map(|der| {
            reqwest::Certificate::from_der(der.as_ref())
                .expect("compiled Mozilla root certificate must be valid DER")
        }));
    builder
}

#[cfg(test)]
mod tests {
    #[test]
    fn client_builds_without_platform_initialization() {
        super::builder().build().expect("HTTP client");
    }
}
