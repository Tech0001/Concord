#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    // App-local workaround for the confirmed WebKitGTK/NVIDIA Wayland Error 71.
    // https://v2.tauri.app/develop/debug/linux-graphics/
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::path::Path::new("/proc/driver/nvidia/version").exists()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    concord_core::run();
}
