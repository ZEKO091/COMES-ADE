//! Pixel buffers. Everything is 32-bit BGRA, top-down, opaque unless noted,
//! so captures keep their exact physical resolution (1080p, 1440p, 4K...).

use std::sync::Arc;

use crate::util::Rect;

#[derive(Clone)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub data: Arc<Vec<u8>>,
}

impl Image {
    pub fn new(width: u32, height: u32, data: Vec<u8>) -> Self {
        debug_assert_eq!(data.len(), (width * height * 4) as usize);
        Self { width, height, data: Arc::new(data) }
    }

    pub fn stride(&self) -> u32 {
        self.width * 4
    }

    pub fn bounds(&self) -> Rect {
        Rect::new(0, 0, self.width as i32, self.height as i32)
    }

    /// Copies a sub-rectangle. The rectangle is clipped to the image.
    pub fn crop(&self, r: Rect) -> Image {
        let r = match r.intersect(&self.bounds()) {
            Some(r) => r,
            None => return Image::new(1, 1, vec![0, 0, 0, 255]),
        };
        let mut out = Vec::with_capacity((r.w * r.h * 4) as usize);
        let stride = self.stride() as usize;
        for y in r.y..r.bottom() {
            let start = y as usize * stride + r.x as usize * 4;
            out.extend_from_slice(&self.data[start..start + r.w as usize * 4]);
        }
        Image::new(r.w as u32, r.h as u32, out)
    }

    /// Returns (r, g, b) at a pixel.
    pub fn rgb(&self, x: i32, y: i32) -> Option<(u8, u8, u8)> {
        if x < 0 || y < 0 || x >= self.width as i32 || y >= self.height as i32 {
            return None;
        }
        let i = (y as usize * self.width as usize + x as usize) * 4;
        let d = &self.data;
        Some((d[i + 2], d[i + 1], d[i]))
    }

    /// Mosaic of a region: one averaged colour per `block` x `block` cell.
    /// Returns a tiny image (cells wide x cells high) meant to be drawn with
    /// nearest-neighbour scaling over the region.
    pub fn pixelate(&self, r: Rect, block: i32) -> Option<Image> {
        let r = r.intersect(&self.bounds())?;
        let block = block.max(2);
        let cw = ((r.w + block - 1) / block).max(1);
        let ch = ((r.h + block - 1) / block).max(1);
        let mut out = vec![0u8; (cw * ch * 4) as usize];
        let stride = self.stride() as usize;
        for cy in 0..ch {
            for cx in 0..cw {
                let x0 = r.x + cx * block;
                let y0 = r.y + cy * block;
                let x1 = (x0 + block).min(r.right());
                let y1 = (y0 + block).min(r.bottom());
                let (mut sb, mut sg, mut sr, mut n) = (0u64, 0u64, 0u64, 0u64);
                for y in y0..y1 {
                    let row = y as usize * stride;
                    for x in x0..x1 {
                        let i = row + x as usize * 4;
                        sb += self.data[i] as u64;
                        sg += self.data[i + 1] as u64;
                        sr += self.data[i + 2] as u64;
                        n += 1;
                    }
                }
                let o = ((cy * cw + cx) * 4) as usize;
                let n = n.max(1);
                out[o] = (sb / n) as u8;
                out[o + 1] = (sg / n) as u8;
                out[o + 2] = (sr / n) as u8;
                out[o + 3] = 255;
            }
        }
        Some(Image::new(cw as u32, ch as u32, out))
    }
}
