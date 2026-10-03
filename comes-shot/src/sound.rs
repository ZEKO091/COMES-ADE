//! Capture sound: the Windows "Chimes" sound, loaded into memory once so it
//! plays instantly. If chimes.wav is missing, a synthesized chime is used.

use std::sync::OnceLock;

use windows::core::PCWSTR;
use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};

static WAV: OnceLock<Vec<u8>> = OnceLock::new();

fn chimes() -> Option<Vec<u8>> {
    let windir = std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into());
    let bytes = std::fs::read(std::path::Path::new(&windir).join("Media").join("chimes.wav")).ok()?;
    bytes.starts_with(b"RIFF").then_some(bytes)
}

/// Two soft bell tones (E6 then C6) with natural decay.
fn synth_chime() -> Vec<u8> {
    const RATE: u32 = 44_100;
    let n = (RATE as f32 * 0.9) as usize;
    let mut samples = vec![0i16; n];
    let tau = std::f32::consts::TAU;
    for (i, s) in samples.iter_mut().enumerate() {
        let t = i as f32 / RATE as f32;
        let bell = |start: f32, f: f32| {
            if t < start {
                return 0.0;
            }
            let u = t - start;
            let attack = (u / 0.004).min(1.0);
            let env = attack * (-u / 0.28).exp();
            // Fundamental plus inharmonic partials give the bell colour.
            env * ((tau * f * u).sin() + 0.45 * (tau * f * 2.76 * u).sin() * (-u / 0.12).exp()
                + 0.25 * (tau * f * 5.4 * u).sin() * (-u / 0.06).exp())
        };
        let v = bell(0.0, 1318.5) * 0.5 + bell(0.16, 1046.5) * 0.5;
        *s = (v.clamp(-1.0, 1.0) * 0.45 * i16::MAX as f32) as i16;
    }
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Loads the sound ahead of time so the first capture plays without delay.
pub fn preload() {
    WAV.get_or_init(|| chimes().unwrap_or_else(synth_chime));
}

pub fn capture() {
    let wav = WAV.get_or_init(|| chimes().unwrap_or_else(synth_chime));
    unsafe {
        let _ = PlaySoundW(PCWSTR(wav.as_ptr() as *const u16), None, SND_MEMORY | SND_ASYNC | SND_NODEFAULT);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sounds_are_valid_wav() {
        let s = super::synth_chime();
        assert!(s.starts_with(b"RIFF") && &s[8..12] == b"WAVE");
        if let Some(c) = super::chimes() {
            assert!(c.len() > 44);
        }
    }
}
