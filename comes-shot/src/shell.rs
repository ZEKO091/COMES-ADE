//! Shell integration: Explorer, file dialogs, autostart and drag & drop.

use std::path::{Path, PathBuf};

use windows::core::{implement, BOOL, HRESULT, PCWSTR};
use windows::Win32::Foundation::{DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, HWND, S_OK, SIZE, POINT};
use windows::Win32::Graphics::Gdi::{CreateDIBSection, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS};
use windows::Win32::System::Com::{CoCreateInstance, IDataObject, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Ole::{DoDragDrop, IDropSource, IDropSource_Impl, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE};
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_READ, KEY_SET_VALUE, REG_SZ,
};
use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
use windows::Win32::UI::Shell::{
    BHID_DataObject, CLSID_DragDropHelper, FileOpenDialog, FileSaveDialog, IDragSourceHelper, IFileOpenDialog,
    IFileSaveDialog, IShellItem, SHCreateItemFromParsingName, ShellExecuteW, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS,
    SHDRAGIMAGE, SIGDN_FILESYSPATH,
};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::i18n::t;
use crate::image::Image;
use crate::util::wide;

pub fn open_path(p: &Path) {
    let op = wide("open");
    let path = wide(&p.to_string_lossy());
    unsafe {
        ShellExecuteW(None, PCWSTR(op.as_ptr()), PCWSTR(path.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL);
    }
}

/// Opens Explorer with the file selected.
pub fn reveal(p: &Path) {
    let args = wide(&format!("/select,\"{}\"", p.display()));
    let exe = wide("explorer.exe");
    unsafe {
        ShellExecuteW(None, PCWSTR::null(), PCWSTR(exe.as_ptr()), PCWSTR(args.as_ptr()), PCWSTR::null(), SW_SHOWNORMAL);
    }
}

pub fn open_in_notepad(p: &Path) {
    let args = wide(&format!("\"{}\"", p.display()));
    let exe = wide("notepad.exe");
    unsafe {
        ShellExecuteW(None, PCWSTR::null(), PCWSTR(exe.as_ptr()), PCWSTR(args.as_ptr()), PCWSTR::null(), SW_SHOWNORMAL);
    }
}

fn item_path(item: &IShellItem) -> Option<PathBuf> {
    unsafe {
        let p = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let s = p.to_string().ok();
        windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as _));
        s.map(PathBuf::from)
    }
}

fn folder_item(dir: &Path) -> Option<IShellItem> {
    let w = wide(&dir.to_string_lossy());
    unsafe { SHCreateItemFromParsingName(PCWSTR(w.as_ptr()), None).ok() }
}

pub fn save_dialog(owner: Option<HWND>, dir: &Path, name: &str, ext: &str) -> Option<PathBuf> {
    unsafe {
        let dlg: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let n_png = wide(t("Imagen PNG (sin pérdida)"));
        let s_png = wide("*.png");
        let n_jpg = wide(t("Imagen JPG"));
        let s_jpg = wide("*.jpg;*.jpeg");
        let specs = [
            COMDLG_FILTERSPEC { pszName: PCWSTR(n_png.as_ptr()), pszSpec: PCWSTR(s_png.as_ptr()) },
            COMDLG_FILTERSPEC { pszName: PCWSTR(n_jpg.as_ptr()), pszSpec: PCWSTR(s_jpg.as_ptr()) },
        ];
        let _ = dlg.SetFileTypes(&specs);
        let _ = dlg.SetFileTypeIndex(if ext == "jpg" { 2 } else { 1 });
        let def = wide(ext);
        let _ = dlg.SetDefaultExtension(PCWSTR(def.as_ptr()));
        let fname = wide(name);
        let _ = dlg.SetFileName(PCWSTR(fname.as_ptr()));
        if let Some(f) = folder_item(dir) {
            let _ = dlg.SetFolder(&f);
        }
        dlg.Show(owner).ok()?;
        item_path(&dlg.GetResult().ok()?)
    }
}

pub fn pick_folder(owner: Option<HWND>, start: &Path) -> Option<PathBuf> {
    unsafe {
        let dlg: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let opts = dlg.GetOptions().ok()?;
        let _ = dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
        if let Some(f) = folder_item(start) {
            let _ = dlg.SetFolder(&f);
        }
        let title = wide(t("Carpeta para las capturas"));
        let _ = dlg.SetTitle(PCWSTR(title.as_ptr()));
        dlg.Show(owner).ok()?;
        item_path(&dlg.GetResult().ok()?)
    }
}

pub fn open_image_dialog(owner: Option<HWND>, start: &Path) -> Option<PathBuf> {
    unsafe {
        let dlg: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let n = wide(t("Imágenes"));
        let s = wide("*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.webp;*.tif;*.tiff");
        let specs = [COMDLG_FILTERSPEC { pszName: PCWSTR(n.as_ptr()), pszSpec: PCWSTR(s.as_ptr()) }];
        let _ = dlg.SetFileTypes(&specs);
        if let Some(f) = folder_item(start) {
            let _ = dlg.SetFolder(&f);
        }
        let title = wide(t("Abrir imagen para anotar"));
        let _ = dlg.SetTitle(PCWSTR(title.as_ptr()));
        dlg.Show(owner).ok()?;
        item_path(&dlg.GetResult().ok()?)
    }
}

// ---------------------------------------------------------------- autostart

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE: &str = "Comes Shot";

fn run_key(access: windows::Win32::System::Registry::REG_SAM_FLAGS) -> Option<HKEY> {
    let k = wide(RUN_KEY);
    let mut h = HKEY::default();
    unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(k.as_ptr()), Some(0), access, &mut h).ok().ok()? };
    Some(h)
}

pub fn autostart_enabled() -> bool {
    let Some(h) = run_key(KEY_READ) else { return false };
    let v = wide(RUN_VALUE);
    let ok = unsafe { RegQueryValueExW(h, PCWSTR(v.as_ptr()), None, None, None, None).is_ok() };
    unsafe {
        let _ = RegCloseKey(h);
    }
    ok
}

pub fn set_autostart(on: bool) {
    let Some(h) = run_key(KEY_SET_VALUE) else { return };
    let v = wide(RUN_VALUE);
    unsafe {
        if on {
            let exe = std::env::current_exe().unwrap_or_default();
            let cmd = wide(&format!("\"{}\" --background", exe.display()));
            let bytes = std::slice::from_raw_parts(cmd.as_ptr() as *const u8, cmd.len() * 2);
            let _ = RegSetValueExW(h, PCWSTR(v.as_ptr()), Some(0), REG_SZ, Some(bytes));
        } else {
            let _ = RegDeleteValueW(h, PCWSTR(v.as_ptr()));
        }
        let _ = RegCloseKey(h);
    }
}

// ---------------------------------------------------------------- drag & drop

#[implement(IDropSource)]
struct DropSource;

impl IDropSource_Impl for DropSource_Impl {
    fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        if escape.as_bool() {
            DRAGDROP_S_CANCEL
        } else if keys.0 & MK_LBUTTON.0 == 0 {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }
    fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

/// Drags a file out of the app (into Explorer, Discord, a browser, Word...).
/// Blocks until the drop finishes; returns true if something accepted it.
pub fn drag_file(path: &Path, preview: Option<&Image>) -> bool {
    unsafe {
        let p = wide(&path.to_string_lossy());
        let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(p.as_ptr()), None) else { return false };
        let Ok(data) = item.BindToHandler::<_, IDataObject>(None, &BHID_DataObject) else { return false };
        if let Some(img) = preview {
            if let Ok(helper) = CoCreateInstance::<_, IDragSourceHelper>(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER) {
                if let Some(hbm) = hbitmap(img) {
                    let mut di = SHDRAGIMAGE {
                        sizeDragImage: SIZE { cx: img.width as i32, cy: img.height as i32 },
                        ptOffset: POINT { x: img.width as i32 / 2, y: img.height as i32 / 2 },
                        hbmpDragImage: hbm,
                        crColorKey: windows::Win32::Foundation::COLORREF(0xFFFF_FFFF),
                    };
                    let _ = helper.InitializeFromBitmap(&mut di, &data);
                }
            }
        }
        let src: IDropSource = DropSource.into();
        let mut effect = DROPEFFECT(0);
        let hr = DoDragDrop(&data, &src, DROPEFFECT_COPY | DROPEFFECT_MOVE, &mut effect);
        hr == DRAGDROP_S_DROP && effect.0 != 0
    }
}

fn hbitmap(img: &Image) -> Option<windows::Win32::Graphics::Gdi::HBITMAP> {
    unsafe {
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: img.width as i32,
                biHeight: -(img.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let hbm = CreateDIBSection(None, &bmi, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
        if bits.is_null() {
            return None;
        }
        std::ptr::copy_nonoverlapping(img.data.as_ptr(), bits as *mut u8, img.data.len());
        Some(hbm)
    }
}

