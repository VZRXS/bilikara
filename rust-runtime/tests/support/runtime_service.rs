use bilikara_runtime::{bilikara_runtime_free_string, bilikara_runtime_service};
use serde_json::{Value, json};
use std::ffi::{CStr, CString};

pub fn response(service: &str, request: Value) -> Value {
    let input = CString::new(json!({"service":service,"request":request}).to_string()).unwrap();
    // SAFETY: input is valid, nul-terminated UTF-8 for the entire call. The
    // owned response is read once and freed with the same public ABI allocator.
    unsafe {
        let output = bilikara_runtime_service(input.as_ptr());
        assert!(
            !output.is_null(),
            "invalid outer Runtime request: {service}"
        );
        let text = CStr::from_ptr(output).to_str().unwrap().to_owned();
        bilikara_runtime_free_string(output);
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["schema_version"], 1);
        value
    }
}
pub fn execute(service: &str, request: Value) -> Value {
    let value = response(service, request);
    assert_eq!(value["status"], "completed", "{}", value["error"]);
    assert!(value.get("error").is_none());
    value["result"].clone()
}
