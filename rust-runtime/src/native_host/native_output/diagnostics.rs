//! Local pipeline facts only; the network report is owned by T7a.
use super::*;
use std::sync::Mutex;
#[derive(Default)]
pub(super) struct OutputTrace {
    value: Mutex<Value>,
}
impl OutputTrace {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            value: Mutex::new(json!({"pipeline_level":"L1","sink":"local"})),
        })
    }
    fn set(&self, key: &str, value: Value) {
        self.value.lock().unwrap_or_else(|p| p.into_inner())[key] = value;
    }
    pub fn preflight(&self, value: Value) {
        self.set("preflight", value);
    }
    pub fn first_packet(&self) {
        self.set("first_packet", json!(true));
    }
    pub fn pipeline_end(&self, outcome: &str) {
        self.set("pipeline", json!(outcome));
    }
    pub fn terminal(&self, code: Option<&str>) {
        self.set("terminal_code", json!(code));
    }
    pub fn snapshot(&self) -> Value {
        self.value.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}
#[derive(Default)]
pub(super) struct Log {
    output: Option<Arc<OutputTrace>>,
}
impl Log {
    pub fn begin_output(&mut self, trace: Arc<OutputTrace>) {
        self.output = Some(trace);
    }
    pub fn output_failure(&self) -> Value {
        self.output
            .as_ref()
            .and_then(|t| {
                let value = t.snapshot();
                value["terminal_code"]
                    .as_str()
                    .filter(|c| !matches!(*c, "stopped" | "paused"))
                    .map(|code| json!({"stage":"pipeline","code":code}))
            })
            .unwrap_or(Value::Null)
    }
}
