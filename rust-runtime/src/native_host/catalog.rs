//! Native HTTP and Internet adapters share the same catalog service as Python FFI.
use super::*;
use crate::shared_catalog::{CatalogOperation, CatalogRequest, execute_catalog};

pub(super) fn read(path: &str, query: &str) -> Result<Value, ApiError> {
    execute_catalog(&CatalogRequest {
        operation: CatalogOperation::Read {
            path: path.into(),
            query: query.into(),
        },
        ..CatalogRequest::for_host()
    })
    .map_err(|error| ApiError::new(error.status_code, &error.kind, error.message))
}
