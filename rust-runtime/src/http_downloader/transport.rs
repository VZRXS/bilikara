//! Interruptible HTTP I/O for the synchronous download coordinator. Dropping a
//! pending reqwest future aborts that request; all range workers still join
//! before staging files or an attempt reservation can be released.
use super::*;
use std::future::Future;
use std::io;

#[derive(Clone)]
pub(super) struct Client<'a> {
    http: reqwest::Client,
    runtime: Arc<tokio::runtime::Runtime>,
    cancel: &'a AtomicBool,
    stopped: Option<Arc<AtomicBool>>,
}

impl<'a> Client<'a> {
    pub(super) fn new(
        request: &DownloadRequest,
        redirects: reqwest::redirect::Policy,
        cancel: &'a AtomicBool,
    ) -> Result<Self, DownloadError> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .map_err(|_| {
                DownloadError::new(
                    DownloadErrorKind::Network,
                    "failed to initialize HTTP runtime",
                )
            })?;
        let http = {
            let _entered = runtime.enter();
            crate::http_client::async_builder()
                .redirect(redirects)
                .connect_timeout(Duration::from_millis(request.connect_timeout_ms))
                .timeout(Duration::from_millis(request.request_timeout_ms))
                .build()
                .map_err(|_| {
                    DownloadError::new(
                        DownloadErrorKind::Network,
                        "failed to initialize HTTP client",
                    )
                })?
        };
        Ok(Self {
            http,
            runtime: Arc::new(runtime),
            cancel,
            stopped: None,
        })
    }

    pub(super) fn with_stop(&self, stopped: Arc<AtomicBool>) -> Self {
        Self {
            stopped: Some(stopped),
            ..self.clone()
        }
    }

    fn wait<T, F: Future<Output = Result<T, reqwest::Error>>>(
        &self,
        action: impl FnOnce() -> F,
    ) -> io::Result<T> {
        self.runtime.block_on(async {
            let mut future = Box::pin(action());
            loop {
                if self.cancel.load(Ordering::Acquire)
                    || self
                        .stopped
                        .as_ref()
                        .is_some_and(|flag| flag.load(Ordering::Acquire))
                {
                    return Err(io::Error::new(
                        io::ErrorKind::Interrupted,
                        "download cancelled",
                    ));
                }
                match tokio::time::timeout(Duration::from_millis(50), &mut future).await {
                    Ok(result) => return result.map_err(io::Error::other),
                    Err(_) => continue,
                }
            }
        })
    }

    pub(super) fn get(&self, url: &str, headers: HeaderMap) -> io::Result<Response<'a>> {
        let response = self.wait(|| self.http.get(url).headers(headers).send())?;
        Ok(Response {
            client: self.clone(),
            response,
            buffer: Vec::new(),
            offset: 0,
        })
    }
}

pub(super) struct Response<'a> {
    client: Client<'a>,
    response: reqwest::Response,
    buffer: Vec<u8>,
    offset: usize,
}

impl Response<'_> {
    pub(super) fn status(&self) -> StatusCode {
        self.response.status()
    }
    pub(super) fn headers(&self) -> &HeaderMap {
        self.response.headers()
    }
    pub(super) fn content_length(&self) -> Option<u64> {
        self.response.content_length()
    }
}

impl Read for Response<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        if self.client.cancel.load(Ordering::Acquire)
            || self
                .client
                .stopped
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::Acquire))
        {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "download cancelled",
            ));
        }
        while self.offset == self.buffer.len() {
            let Some(chunk) = self.client.wait(|| self.response.chunk())? else {
                return Ok(0);
            };
            self.buffer = chunk.to_vec();
            self.offset = 0;
        }
        let count = output.len().min(self.buffer.len() - self.offset);
        output[..count].copy_from_slice(&self.buffer[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }
}
