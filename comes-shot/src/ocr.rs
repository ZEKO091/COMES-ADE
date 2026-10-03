//! Text recognition with the OCR engine built into Windows (no downloads).
//! Uses the user's profile languages, so Spanish and English both work.

use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;

use crate::gfx;
use crate::image::Image;

pub fn recognize(img: &Image) -> Result<String, String> {
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| crate::i18n::t("instala un idioma con reconocimiento de texto en Configuración de Windows").to_string())?;

    // Small text reads much better when enlarged first.
    let max_dim = OcrEngine::MaxImageDimension().unwrap_or(10000);
    let mut src = img.clone();
    let longest = img.width.max(img.height);
    if longest < 1600 {
        let f = if longest < 600 { 3 } else { 2 };
        if longest * f <= max_dim {
            if let Ok(up) = gfx::scale_image(img, img.width * f, img.height * f) {
                src = up;
            }
        }
    }
    if src.width > max_dim || src.height > max_dim {
        let s = max_dim as f32 / src.width.max(src.height) as f32;
        let (w, h) = (((src.width as f32) * s) as u32, ((src.height as f32) * s) as u32);
        src = gfx::scale_image(&src, w.max(1), h.max(1)).map_err(|e| e.message().to_string())?;
    }

    let run = || -> windows::core::Result<String> {
        let writer = DataWriter::new()?;
        writer.WriteBytes(&src.data)?;
        let buffer = writer.DetachBuffer()?;
        let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
            &buffer,
            BitmapPixelFormat::Bgra8,
            src.width as i32,
            src.height as i32,
            BitmapAlphaMode::Premultiplied,
        )?;
        let result = engine.RecognizeAsync(&bitmap)?.get()?;
        let mut lines = Vec::new();
        for line in result.Lines()? {
            lines.push(line.Text()?.to_string());
        }
        Ok(lines.join("\n"))
    };
    run().map_err(|e| e.message().to_string())
}
