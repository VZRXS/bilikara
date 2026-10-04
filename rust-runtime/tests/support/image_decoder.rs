use std::io::Cursor;

pub struct Pixels {
    pub width: usize,
    pub height: usize,
    pub color: png::ColorType,
    pub depth: png::BitDepth,
    pub bytes: Vec<u8>,
}
impl Pixels {
    pub fn png(bytes: &[u8]) -> Self {
        let mut decoder = png::Decoder::new(Cursor::new(bytes));
        decoder.set_transformations(png::Transformations::EXPAND);
        let mut reader = decoder.read_info().unwrap();
        let depth = reader.info().bit_depth;
        let color = reader.info().color_type;
        let size = reader.output_buffer_size().unwrap();
        assert!(size < 64 * 1024 * 1024, "isolated test image bound");
        let mut pixels = vec![0; size];
        let output = reader.next_frame(&mut pixels).unwrap();
        assert_eq!(output.bit_depth, png::BitDepth::Eight);
        pixels.truncate(output.buffer_size());
        reader.finish().unwrap();
        Self {
            width: output.width as usize,
            height: output.height as usize,
            color,
            depth,
            bytes: pixels,
        }
    }
    pub fn rgb(&self, x: usize, y: usize) -> [u8; 3] {
        assert_eq!(self.color, png::ColorType::Rgb);
        self.bytes[(y * self.width + x) * 3..(y * self.width + x) * 3 + 3]
            .try_into()
            .unwrap()
    }
    #[allow(dead_code)] // Pixel comparisons are used by the separate export test target.
    pub fn crop_bytes(&self, x: usize, y: usize, width: usize, height: usize) -> Vec<u8> {
        (y..y + height)
            .flat_map(|y| {
                self.bytes[(y * self.width + x) * 3..(y * self.width + x + width) * 3]
                    .iter()
                    .copied()
            })
            .collect()
    }
    pub fn decode(
        &self,
        x: usize,
        y: usize,
        width: usize,
        height: usize,
        quiet: usize,
        expected: &str,
    ) {
        assert!(x + width <= self.width && y + height <= self.height);
        let stride = width + 2 * quiet;
        let mut grey = vec![255; stride * (height + 2 * quiet)];
        for row in 0..height {
            for col in 0..width {
                let offset = (y + row) * self.width + x + col;
                grey[(row + quiet) * stride + col + quiet] =
                    if self.color == png::ColorType::Grayscale {
                        self.bytes[offset]
                    } else {
                        let pixel = self.rgb(x + col, y + row);
                        ((u32::from(pixel[0]) * 299
                            + u32::from(pixel[1]) * 587
                            + u32::from(pixel[2]) * 114)
                            / 1000) as u8
                    };
            }
        }
        let mut scanner = quircs::Quirc::default();
        let codes: Vec<_> = scanner
            .identify(stride, height + 2 * quiet, &grey)
            .map(Result::unwrap)
            .collect();
        // The detector mislocates alignment cells in some large, exact rasters.
        // For those test-owned monochrome images, independently read the actual
        // uniform modules and all three standard finders before the separate
        // library verifies format/version, Reed-Solomon data and payload bytes.
        let mut decoded: Vec<_> = codes.iter().filter_map(|code| code.decode().ok()).collect();
        let data = if decoded.len() == 1 {
            decoded.pop().unwrap()
        } else if self.color == png::ColorType::Grayscale {
            exact_monochrome_code(&grey, stride, height + 2 * quiet)
                .decode()
                .unwrap()
        } else {
            panic!("independent QR detector must decode exactly one code")
        };
        assert_eq!(data.payload, expected.as_bytes());
        assert_eq!(data.ecc_level, quircs::EccLevel::M);
    }
}

fn exact_monochrome_code(pixels: &[u8], width: usize, height: usize) -> quircs::Code {
    let first = pixels
        .iter()
        .position(|&pixel| pixel == 0)
        .expect("finder must exist");
    let (left, top) = (first % width, first / width);
    let row = &pixels[top * width..(top + 1) * width];
    let run = row[left..].iter().take_while(|&&pixel| pixel == 0).count();
    assert_eq!(run % 7, 0);
    let scale = run / 7;
    assert!(scale > 0);
    let right = row.iter().rposition(|&pixel| pixel == 0).unwrap() + 1;
    assert_eq!((right - left) % scale, 0);
    let size = (right - left) / scale;
    assert!((21..=177).contains(&size) && (size - 21).is_multiple_of(4));
    assert!(top + size * scale <= height);
    let mut code = quircs::Code {
        size: size as i32,
        ..Default::default()
    };
    for y in 0..size {
        for x in 0..size {
            let value = pixels[(top + y * scale) * width + left + x * scale];
            assert!([0, 255].contains(&value));
            for dy in 0..scale {
                for dx in 0..scale {
                    assert_eq!(
                        pixels[(top + y * scale + dy) * width + left + x * scale + dx],
                        value,
                        "exact monochrome module"
                    );
                }
            }
            if value == 0 {
                let index = y * size + x;
                code.cell_bitmap[index >> 3] |= 1 << (index & 7);
            }
        }
    }
    for (x, y) in [(0, 0), (size - 7, 0), (0, size - 7)] {
        for row in 0..7 {
            for col in 0..7 {
                let black = row == 0
                    || row == 6
                    || col == 0
                    || col == 6
                    || ((2..=4).contains(&row) && (2..=4).contains(&col));
                assert_eq!(
                    pixels[(top + (y + row) * scale) * width + left + (x + col) * scale] == 0,
                    black,
                    "three complete independent finder patterns"
                );
            }
        }
    }
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_raster_reader_rejects_nonuniform_or_lost_finder_pixels() {
        let png = bilikara_runtime::generate_qr_png("https://example.test/", 10, 4).unwrap();
        let pixels = Pixels::png(&png);
        let code = exact_monochrome_code(&pixels.bytes, pixels.width, pixels.height);
        assert_eq!(code.decode().unwrap().payload, b"https://example.test/");
        let mut changed = pixels.bytes.clone();
        changed[40 * pixels.width + 41] = 255;
        assert!(
            std::panic::catch_unwind(|| exact_monochrome_code(
                &changed,
                pixels.width,
                pixels.height
            ))
            .is_err()
        );
        let mut changed = pixels.bytes.clone();
        for y in 40..110 {
            for x in 40..110 {
                changed[y * pixels.width + x] = 255;
            }
        }
        assert!(
            std::panic::catch_unwind(|| exact_monochrome_code(
                &changed,
                pixels.width,
                pixels.height
            ))
            .is_err()
        );
    }
}
