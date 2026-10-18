//! Keep Windows window chrome from opening a second, native context menu.
use std::ffi::c_void;

const SUBCLASS_ID: usize = 0x585758;
const WM_NCDESTROY: u32 = 0x0082;

type WindowProc = unsafe extern "system" fn(*mut c_void, u32, usize, isize, usize, usize) -> isize;

#[link(name = "comctl32")]
extern "system" {
    fn SetWindowSubclass(window: *mut c_void, callback: WindowProc, id: usize, data: usize) -> i32;
    fn RemoveWindowSubclass(window: *mut c_void, callback: WindowProc, id: usize) -> i32;
    fn DefSubclassProc(window: *mut c_void, message: u32, wparam: usize, lparam: isize) -> isize;
}

fn opens_system_menu(message: u32, wparam: usize, window: usize) -> bool {
    match message {
        // Mouse and Alt+Space entry points. Preserve every actual window command.
        0x0112 => matches!(wparam & 0xfff0, 0xf090 | 0xf100),
        // A right click on the caption or system icon must not reach DefWindowProc.
        0x00a4 | 0x00a5 => matches!(wparam, 2 | 3),
        // Tauri's draggable client caption can send WM_CONTEXTMENU directly.
        // Child WebView controls retain their own context-menu event handling.
        0x007b => wparam == window,
        _ => false,
    }
}

unsafe extern "system" fn window_proc(
    window: *mut c_void,
    message: u32,
    wparam: usize,
    lparam: isize,
    id: usize,
    _data: usize,
) -> isize {
    if opens_system_menu(message, wparam, window as usize) {
        return 0;
    }
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(window, window_proc, id);
    }
    DefSubclassProc(window, message, wparam, lparam)
}

pub(crate) fn attach(window: &tauri::Window) {
    // WebView-ready runs on the owning UI thread. Subclass only our Tauri window,
    // never the separate Windows file/folder dialog windows.
    match window.hwnd() {
        Ok(handle)
            if unsafe { SetWindowSubclass(handle.0.cast(), window_proc, SUBCLASS_ID, 0) } != 0 => {}
        Ok(_) => eprintln!("无法停用系统窗口菜单：{}", std::io::Error::last_os_error()),
        Err(error) => eprintln!("无法取得应用窗口：{error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caption_mouse_and_keyboard_menu_entry_points_are_blocked() {
        for (message, wparam) in [(0x0112, 0xf090), (0x0112, 0xf10f), (0x00a4, 2), (0x00a5, 3)] {
            assert!(opens_system_menu(message, wparam, 42));
        }
    }

    #[test]
    fn window_actions_and_client_context_events_remain_available() {
        for (message, wparam) in [
            (0x0112, 0xf060),
            (0x0112, 0xf020),
            (0x0112, 0xf030),
            (0x0112, 0xf120),
            (0x007b, 0),
            (0x00a5, 1),
            (WM_NCDESTROY, 0),
        ] {
            assert!(!opens_system_menu(message, wparam, 42));
        }
    }

    #[test]
    fn client_caption_context_menu_is_blocked_without_intercepting_child_controls() {
        assert!(opens_system_menu(0x007b, 42, 42));
        assert!(!opens_system_menu(0x007b, 43, 42));
    }
}
