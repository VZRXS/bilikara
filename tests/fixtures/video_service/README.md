These certificates and the deliberately public private key belong only to the
local P04 HTTP/TLS test fixture. They are synthetic and are never used by the app,
installed in a trust store, or valid for any real Bilibili server. `ca.pem` is
trusted using the fixture process's `SSL_CERT_FILE`. `cert.pem` is a test leaf
signed by that CA, with the fixed service/short-link names as SANs. The CA signing
key is not needed by tests. Certificate verification remains enabled.

The fixture proxy handles every CONNECT locally and never forwards requests.
Linux supports this temporary trust configuration. The fixture explicitly skips
on Windows/macOS, whose platform verifiers need a different trust setup; portable
Rust service tests still cover input, parsing, binding, errors and local HTTP.
