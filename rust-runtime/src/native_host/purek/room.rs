//! Pure K QR / UPnP wire validation. Protocol reference: ChunK-Helper (MIT),
//! e223fac61e3991689bf7ef7125297583f5b56b9e; attribution in third-party notices.
use super::*;

#[derive(Clone)]
pub(crate) struct Room {
    pub name: String,
    pub description: Url,
    pub authorization: Option<crate::dlna::purek::Room>,
}
fn invalid() -> ApiError {
    failure(400, "qr_invalid", "请使用完整的纯 K 房间投屏二维码")
}
pub(super) fn local_address(url: &Url) -> Result<Ipv4Addr, ApiError> {
    let ip = url
        .host_str()
        .and_then(|s| s.parse::<Ipv4Addr>().ok())
        .ok_or_else(invalid)?;
    let allowed = ip.is_private();
    #[cfg(test)]
    let allowed = allowed || ip.is_loopback();
    if !matches!(url.scheme(), "http" | "https")
        || !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err(invalid());
    }
    Ok(ip)
}
impl Room {
    pub fn from_input(raw: &str) -> Result<Self, ApiError> {
        if Url::parse(raw.trim()).is_ok_and(|url| url.host_str() == Some("wx.chunk.cn")) {
            Self::parse(raw)
        } else {
            Self::dlna(raw)
        }
    }

    pub fn dlna(raw: &str) -> Result<Self, ApiError> {
        let invalid = || failure(400, "description_invalid", "请填写局域网 DLNA 设备描述地址");
        if raw.len() > 4096 || raw.chars().any(char::is_control) {
            return Err(invalid());
        }
        let description = Url::parse(raw.trim()).map_err(|_| invalid())?;
        local_address(&description).map_err(|_| invalid())?;
        Ok(Self {
            name: "DLNA".into(),
            description,
            authorization: None,
        })
    }

    pub fn connection_type(&self) -> &'static str {
        if self.authorization.is_some() {
            "purek"
        } else {
            "dlna"
        }
    }

    pub fn authorization_url(&self) -> Option<&str> {
        self.authorization
            .as_ref()
            .map(crate::dlna::purek::Room::authorization_url)
    }

    pub fn parse(raw: &str) -> Result<Self, ApiError> {
        let parsed = crate::dlna::purek::Room::parse(raw);
        #[cfg(test)]
        let parsed = parsed.or_else(|_| crate::dlna::purek::Room::parse_fixture(raw));
        let authorization = parsed.map_err(|error| super::authorization_error(&error))?;
        Ok(Self {
            name: authorization.name().to_owned(),
            description: authorization.description_url().clone(),
            authorization: Some(authorization),
        })
    }
}
