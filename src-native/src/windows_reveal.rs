//! Explorer can hand off to an existing process with a nonzero exit code.
//! Ask the Shell to select the file and check its actual HRESULT instead.
//! https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shopenfolderandselectitems
use super::{err, Result};
use std::{ffi::c_void, fs, os::windows::ffi::OsStrExt, path::Path, ptr};

#[link(name = "Ole32")]
extern "system" {
    fn CoInitializeEx(reserved: *const c_void, mode: u32) -> i32;
    fn CoUninitialize();
    fn CoTaskMemFree(memory: *const c_void);
}
#[link(name = "Shell32")]
extern "system" {
    fn SHParseDisplayName(
        name: *const u16,
        context: *const c_void,
        item: *mut *mut c_void,
        attributes: u32,
        output_attributes: *mut u32,
    ) -> i32;
    fn SHOpenFolderAndSelectItems(
        item: *const c_void,
        count: u32,
        children: *const *const c_void,
        flags: u32,
    ) -> i32;
}

pub(super) fn reveal(file: &Path) -> Result<()> {
    let file = fs::canonicalize(file).map_err(err)?;
    let mut name: Vec<u16> = file.as_os_str().encode_wide().chain(Some(0)).collect();
    // Shell paths use ordinary drive/UNC prefixes, while Rust canonical paths
    // use verbatim prefixes. Keep all remaining UTF-16 code units unchanged.
    if let Some(std::path::Component::Prefix(prefix)) = file.components().next() {
        match prefix.kind() {
            std::path::Prefix::VerbatimDisk(_) => {
                drop(name.drain(..4));
            }
            std::path::Prefix::VerbatimUNC(_, _) => {
                drop(name.splice(..8, [b'\\' as u16, b'\\' as u16]));
            }
            _ => {}
        }
    }
    // Use a dedicated COM apartment; the HTTP worker may already use MTA.
    std::thread::spawn(move || unsafe {
        let initialized = CoInitializeEx(ptr::null(), 2);
        if initialized < 0 {
            return Err(format!("无法初始化文件定位服务（0x{initialized:08X}）"));
        }
        let mut item = ptr::null_mut();
        let parsed = SHParseDisplayName(name.as_ptr(), ptr::null(), &mut item, 0, ptr::null_mut());
        let result = if parsed < 0 || item.is_null() {
            Err(format!("无法定位日志文件（0x{parsed:08X}）"))
        } else {
            // With count=0, the absolute PIDL identifies the selected file.
            let opened = SHOpenFolderAndSelectItems(item, 0, ptr::null(), 0);
            if opened < 0 {
                Err(format!("无法打开日志所在文件夹（0x{opened:08X}）"))
            } else {
                Ok(())
            }
        };
        if !item.is_null() {
            CoTaskMemFree(item);
        }
        CoUninitialize();
        result
    })
    .join()
    .map_err(|_| "文件定位任务异常，未报告打开成功".to_owned())?
}
