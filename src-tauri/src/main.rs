// The Maka macOS shell binary. Everything lives in the library (src/lib.rs) so that the
// Tauri mobile/desktop entry points share one `run()`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    maka_lib::run()
}
