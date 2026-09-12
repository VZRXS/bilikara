//! Stateless QR encoding and monochrome PNG serialization. No URL or login policy.
use qrcode::{Color, EcLevel, QrCode, types::QrError};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QrImageErrorKind {
    InvalidRequest,
    SizeLimit,
    CapacityExceeded,
    EncodingFailed,
}

#[derive(Debug, Serialize)]
pub struct QrImageError {
    pub kind: QrImageErrorKind,
    pub message: &'static str,
}

impl QrImageError {
    pub(crate) fn invalid_request() -> Self {
        Self {
            kind: QrImageErrorKind::InvalidRequest,
            message: "Invalid QR image request",
        }
    }

    fn encoding_failed() -> Self {
        Self {
            kind: QrImageErrorKind::EncodingFailed,
            message: "QR image encoding failed",
        }
    }
}

/// Preserve UTF-8 payload bytes, choose a fitting standard QR version at M level,
/// and render black/white pixels. Both existing callers use scale 10; the Remote
/// UI supplies its own quiet space (border 0), while login uses border 4.
pub fn generate_qr_png(
    payload: &str,
    module_scale: u32,
    border: u32,
) -> Result<Vec<u8>, QrImageError> {
    if payload.is_empty() || module_scale == 0 {
        return Err(QrImageError::invalid_request());
    }
    // Bound allocation independently of payload length. Do not impose a lower
    // byte cap than the encoder: numeric/alphanumeric inputs have higher capacity.
    if module_scale > 16 || border > 16 {
        return Err(QrImageError {
            kind: QrImageErrorKind::SizeLimit,
            message: "QR image scale or border exceeds the supported limit",
        });
    }
    let code =
        QrCode::with_error_correction_level(payload.as_bytes(), EcLevel::M).map_err(|error| {
            match error {
                QrError::DataTooLong => QrImageError {
                    kind: QrImageErrorKind::CapacityExceeded,
                    message: "QR payload exceeds M-level capacity",
                },
                _ => QrImageError::encoding_failed(),
            }
        })?;
    let scale = module_scale as usize;
    let border = border as usize;
    let width = (code.width() + 2 * border) * scale;
    // Version 40 has 177 modules: at the limits this is at most 3344 px.
    let stride = width.div_ceil(8);
    let mut pixels = vec![0xff; stride * width];
    for y in 0..code.width() {
        for x in 0..code.width() {
            if code[(x, y)] == Color::Dark {
                for py in (y + border) * scale..(y + border + 1) * scale {
                    for px in (x + border) * scale..(x + border + 1) * scale {
                        pixels[py * stride + px / 8] &= !(0x80 >> (px % 8));
                    }
                }
            }
        }
    }
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width as u32, width as u32);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::One);
        let mut writer = encoder
            .write_header()
            .map_err(|_| QrImageError::encoding_failed())?;
        writer
            .write_image_data(&pixels)
            .map_err(|_| QrImageError::encoding_failed())?;
        writer
            .finish()
            .map_err(|_| QrImageError::encoding_failed())?;
    }
    Ok(png)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_has_expected_dimensions_depth_and_quiet_border() {
        for border in [0, 4] {
            let bytes = generate_qr_png("https://example.test/", 10, border).unwrap();
            let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
            let mut reader = decoder.read_info().unwrap();
            let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
            let info = reader.next_frame(&mut pixels).unwrap();
            assert_eq!(info.width, (25 + 2 * border) * 10);
            assert_eq!(info.width, info.height);
            assert_eq!(info.bit_depth, png::BitDepth::One);
            assert_eq!(info.color_type, png::ColorType::Grayscale);
            assert_eq!(pixels[0], if border == 0 { 0 } else { 255 });
        }
    }

    #[test]
    fn limits_fail_without_an_image() {
        for (payload, scale, border, kind) in [
            ("", 10, 0, QrImageErrorKind::InvalidRequest),
            ("x", 0, 0, QrImageErrorKind::InvalidRequest),
            ("x", u32::MAX, 0, QrImageErrorKind::SizeLimit),
            ("x", 10, u32::MAX, QrImageErrorKind::SizeLimit),
        ] {
            assert_eq!(
                generate_qr_png(payload, scale, border).unwrap_err().kind,
                kind
            );
        }
        assert_eq!(
            generate_qr_png(&"x".repeat(2332), 10, 4).unwrap_err().kind,
            QrImageErrorKind::CapacityExceeded
        );
        assert!(generate_qr_png(&"x".repeat(2331), 1, 0).is_ok());
        assert!(generate_qr_png(&"1".repeat(5596), 1, 0).is_ok());
    }
}
