//! Computer control (phase 4 step 18): the shell drives this Mac for a Ranger, through the
//! credential broker's socket (`COMPUTER <action> <base64 json>`, broker.rs), never over
//! HTTP. The sidecar (sidecar/computer/control.js) holds the leash, the Gate, the judge, the
//! trace and the handoffs; this side holds the frameworks and three locks of its own:
//!
//!   * the halt: ⌃⌥⌘H (lib.rs registers it) or a `halt` request stops every action until
//!     `resume`, which only the sidecar sends on the Superintendent's behalf;
//!   * the banner: a small always-on-top window ("A Maka Ranger is driving this Mac") shown
//!     from `begin` to `end`;
//!   * the sensitive apps: before a screenshot, a locate, a click, a key or typed text the
//!     frontmost app is checked against computer_policy.rs (Maka itself, browsers, banking,
//!     password managers, System Settings, terminals) and its front window's title and URL
//!     against the loopback rule (127.0.0.1, localhost, the sidecar's own host:port: a local
//!     web UI, which may be Maka's own; safety 2026-10-11 H2); either is refused with
//!     SENSITIVE_APP (the sidecar hands off to the Superintendent), and `focus` never brings
//!     a sensitive app to the front. `frontmost` reports the window too, so the sidecar
//!     applies the same rule with its own address.
//!
//! macOS only: Accessibility (AXUIElement, for `locate`), CGEvent (clicks, keys, text),
//! CGDisplayCreateImage (screenshots, PNG through the `png` crate) and NSWorkspace (the
//! apps). Elsewhere every action says computer control needs macOS. The frameworks only run
//! on the Mac; docs/RELEASE_RUNBOOK.md lists what to verify there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::broker::ComputerHost;
use crate::computer_policy::{loopback_window_reason, sensitive_reason, HALT_HOTKEY_LABEL};

pub const MAX_LOCATE_NODES: usize = 2000;
pub const MAX_LOCATE_DEPTH: usize = 14;
pub const MAX_TYPE_CHARS: usize = 2000;

type BannerFn = Box<dyn Fn(bool) + Send + Sync>;

/// The shell's side of computer control: the halt flag, who is driving, the banner hook,
/// and the sidecar's own host:port strings for the loopback-window rule.
#[derive(Default)]
pub struct Computer {
    halted: AtomicBool,
    driving: Mutex<Option<(String, String)>>,
    banner: Mutex<Option<BannerFn>>,
    own_hosts: Mutex<Vec<String>>,
}

impl Computer {
    /// The sidecar's own addresses (host:port) as the shell knows them; a front window
    /// naming one is Maka's own UI and is never driven (safety 2026-10-11 H2).
    pub fn set_own_hosts(&self, hosts: Vec<String>) {
        *self.own_hosts.lock().unwrap_or_else(|p| p.into_inner()) = hosts;
    }
    fn own_hosts(&self) -> Vec<String> {
        self.own_hosts.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    /// The app list's reason or the window's: either makes the app in front off limits.
    fn front_reason(&self, app: &App) -> Option<String> {
        sensitive_reason(&app.bundle_id, &app.name).or_else(|| loopback_window_reason(&app.window_title, &app.window_url, &self.own_hosts()))
    }
    pub fn set_banner(&self, f: BannerFn) {
        *self.banner.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }
    fn show_banner(&self, on: bool) {
        if let Some(f) = self.banner.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            f(on);
        }
    }
    pub fn is_halted(&self) -> bool {
        self.halted.load(Ordering::SeqCst)
    }
    pub fn driving(&self) -> Option<(String, String)> {
        self.driving.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    /// The hotkey or the Superintendent: everything stops, the banner goes.
    pub fn halt(&self) {
        self.halted.store(true, Ordering::SeqCst);
        *self.driving.lock().unwrap_or_else(|p| p.into_inner()) = None;
        self.show_banner(false);
    }
    pub fn resume(&self) {
        self.halted.store(false, Ordering::SeqCst);
    }
}

fn refuse(code: &str, error: String, app: Option<&str>) -> Result<String, String> {
    Ok(json!({ "ok": false, "code": code, "error": error, "app": app }).to_string())
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

impl ComputerHost for Computer {
    fn handle(&self, action: &str, request: &str) -> Result<String, String> {
        let req: Value = serde_json::from_str(request).map_err(|e| format!("COMPUTER request is not JSON: {e}"))?;
        match action {
            "status" => {
                let p = platform::permissions();
                return Ok(json!({ "platform": platform::NAME, "permissions": p, "halted": self.is_halted(), "driving": self.driving().is_some(), "hotkey": HALT_HOTKEY_LABEL }).to_string());
            }
            "halt" => {
                self.halt();
                return Ok(json!({ "halted": true }).to_string());
            }
            "resume" => {
                self.resume();
                return Ok(json!({ "halted": false }).to_string());
            }
            _ => {}
        }
        if self.is_halted() {
            return refuse("HALTED", format!("halted by the hotkey ({HALT_HOTKEY_LABEL}) or the Peak; the Superintendent resumes it"), None);
        }
        match action {
            "begin" => {
                *self.driving.lock().unwrap_or_else(|p| p.into_inner()) = Some((str_of(&req, "agentId").to_string(), str_of(&req, "runId").to_string()));
                self.show_banner(true);
                Ok(json!({ "banner": true }).to_string())
            }
            "end" => {
                *self.driving.lock().unwrap_or_else(|p| p.into_inner()) = None;
                self.show_banner(false);
                Ok(json!({ "banner": false }).to_string())
            }
            "frontmost" => {
                let app = platform::frontmost()?;
                let why = self.front_reason(&app);
                Ok(json!({ "app": app.json(), "window": app.window_json(), "sensitive": why.is_some(), "reason": why }).to_string())
            }
            "apps" => {
                let apps: Vec<Value> = platform::apps()?.into_iter().map(|a| {
                    let mut v = a.json();
                    v["sensitive"] = Value::Bool(sensitive_reason(&a.bundle_id, &a.name).is_some());
                    v
                }).collect();
                Ok(json!({ "apps": apps }).to_string())
            }
            "focus" => {
                let bundle_id = str_of(&req, "bundleId");
                let name = str_of(&req, "name");
                if let Some(why) = sensitive_reason(bundle_id, name) {
                    return refuse("SENSITIVE_APP", format!("{why}; a Ranger never brings it to the front"), Some(if name.is_empty() { bundle_id } else { name }));
                }
                let app = platform::focus(bundle_id, name)?;
                if let Some(why) = sensitive_reason(&app.bundle_id, &app.name) {
                    return refuse("SENSITIVE_APP", why, Some(&app.name));
                }
                Ok(json!({ "app": app.json() }).to_string())
            }
            "screenshot" | "locate" | "click" | "type" | "key" => {
                // The shell's own lock: whatever the sidecar believes, a sensitive app in front,
                // or a front window showing a local web UI, is never acted on or captured.
                let front = platform::frontmost()?;
                if let Some(why) = self.front_reason(&front) {
                    return refuse("SENSITIVE_APP", why, Some(&front.name));
                }
                match action {
                    "screenshot" => {
                        let shot = platform::screenshot()?;
                        Ok(json!({ "png": crate::broker::base64_encode(&shot.png), "width": shot.width, "height": shot.height }).to_string())
                    }
                    "locate" => {
                        let query = str_of(&req, "query");
                        let depth = req.get("maxDepth").and_then(|d| d.as_u64()).map(|d| d as usize).unwrap_or(MAX_LOCATE_DEPTH).min(MAX_LOCATE_DEPTH);
                        let nodes = platform::tree(front.pid, depth, MAX_LOCATE_NODES)?;
                        let matches = crate::computer_policy::locate(&nodes, query, 200);
                        Ok(json!({ "nodes": matches, "scanned": nodes.len(), "app": front.json() }).to_string())
                    }
                    "click" => {
                        let x = req.get("x").and_then(|v| v.as_f64()).ok_or("click needs x")?;
                        let y = req.get("y").and_then(|v| v.as_f64()).ok_or("click needs y")?;
                        let right = str_of(&req, "button") == "right";
                        let double = req.get("double").and_then(|v| v.as_bool()).unwrap_or(false);
                        platform::click(x, y, right, double)?;
                        Ok(json!({ "clicked": { "x": x, "y": y, "button": if right { "right" } else { "left" }, "double": double } }).to_string())
                    }
                    "type" => {
                        let text = str_of(&req, "text");
                        if text.is_empty() || text.chars().count() > MAX_TYPE_CHARS {
                            return Err(format!("type needs 1 to {MAX_TYPE_CHARS} characters"));
                        }
                        platform::type_text(text)?;
                        Ok(json!({ "typed": text.chars().count() }).to_string())
                    }
                    _ => {
                        let modifiers: Vec<String> = req.get("modifiers").and_then(|m| m.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                        let chord = crate::computer_policy::parse_chord(&modifiers, str_of(&req, "key"))?;
                        platform::press(&chord)?;
                        Ok(json!({ "pressed": format!("{}{}", modifiers.iter().map(|m| format!("{m}+")).collect::<String>(), chord.key) }).to_string())
                    }
                }
            }
            other => Err(format!("unknown computer action {other}")),
        }
    }
}

/// A running app as the shell reports it.
#[derive(Debug, Clone)]
pub struct App {
    pub bundle_id: String,
    pub name: String,
    pub pid: i32,
    pub front: bool,
    /// The front window's title and document URL (Accessibility: AXFocusedWindow's AXTitle
    /// and AXDocument), filled for the frontmost app only; empty when unknown.
    pub window_title: String,
    pub window_url: String,
}

impl App {
    fn json(&self) -> Value {
        json!({ "bundleId": self.bundle_id, "name": self.name, "pid": self.pid, "front": self.front })
    }
    fn window_json(&self) -> Value {
        json!({ "title": self.window_title, "url": self.window_url })
    }
}

pub struct Shot {
    pub png: Vec<u8>,
    pub width: usize,
    pub height: usize,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{App, Shot};
    use crate::computer_policy::{chord_flags, AxNode, Chord};
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::display::CGDisplay;
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use core_graphics::geometry::CGPoint;
    use objc2_app_kit::{NSApplicationActivationOptions, NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace};
    use objc2_foundation::NSString;
    use serde_json::json;
    use std::ffi::c_void;

    pub const NAME: &str = "macos";

    type AXUIElementRef = *const c_void;
    type AXValueRef = *const c_void;
    const AX_VALUE_CGPOINT: u32 = 1;
    const AX_VALUE_CGSIZE: u32 = 2;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
        fn AXValueGetValue(value: AXValueRef, value_type: u32, out: *mut c_void) -> bool;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }

    pub fn permissions() -> serde_json::Value {
        let (ax, screen) = unsafe { (AXIsProcessTrusted(), CGPreflightScreenCaptureAccess()) };
        json!({ "accessibility": ax, "screenRecording": screen })
    }

    fn app_of(a: &NSRunningApplication, front: bool) -> App {
        let bundle_id = a.bundleIdentifier().map(|s| s.to_string()).unwrap_or_default();
        let name = a.localizedName().map(|s| s.to_string()).unwrap_or_default();
        App { bundle_id, name, pid: a.processIdentifier(), front, window_title: String::new(), window_url: String::new() }
    }

    /// The focused window's title and document URL through Accessibility (empty strings
    /// when the permission is missing or the app exposes neither). Browsers put the page
    /// URL in AXDocument of the window; the title names the page (safety 2026-10-11 H2).
    fn front_window(pid: i32) -> (String, String) {
        if !unsafe { AXIsProcessTrusted() } {
            return (String::new(), String::new());
        }
        let app = unsafe { AXUIElementCreateApplication(pid) };
        if app.is_null() {
            return (String::new(), String::new());
        }
        let root = unsafe { CFType::wrap_under_create_rule(app) };
        let Some(win) = ax_attr(root.as_CFTypeRef(), "AXFocusedWindow") else { return (String::new(), String::new()) };
        let title = ax_string(win.as_CFTypeRef(), "AXTitle");
        let mut url = ax_string(win.as_CFTypeRef(), "AXDocument");
        if url.is_empty() {
            url = ax_string(win.as_CFTypeRef(), "AXURL");
        }
        (title, url)
    }

    pub fn frontmost() -> Result<App, String> {
        let ws = NSWorkspace::sharedWorkspace();
        let app = ws.frontmostApplication().ok_or("no app is in front")?;
        let mut out = app_of(&app, true);
        let (title, url) = front_window(out.pid);
        out.window_title = title;
        out.window_url = url;
        Ok(out)
    }

    pub fn apps() -> Result<Vec<App>, String> {
        let ws = NSWorkspace::sharedWorkspace();
        let front = ws.frontmostApplication().map(|a| a.processIdentifier());
        let list = ws.runningApplications();
        let mut out = Vec::new();
        for i in 0..list.len() {
            let a = list.objectAtIndex(i);
            if a.activationPolicy() != NSApplicationActivationPolicy::Regular {
                continue;
            }
            let pid = a.processIdentifier();
            out.push(app_of(&a, Some(pid) == front));
        }
        Ok(out)
    }

    pub fn focus(bundle_id: &str, name: &str) -> Result<App, String> {
        let ws = NSWorkspace::sharedWorkspace();
        let list = ws.runningApplications();
        for i in 0..list.len() {
            let a = list.objectAtIndex(i);
            let app = app_of(&a, false);
            let by_id = !bundle_id.is_empty() && app.bundle_id.eq_ignore_ascii_case(bundle_id);
            let by_name = !name.is_empty() && app.name.eq_ignore_ascii_case(name);
            if by_id || by_name {
                let ok = a.activateWithOptions(NSApplicationActivationOptions::empty());
                if !ok {
                    return Err(format!("{} did not come to the front", app.name));
                }
                return Ok(App { front: true, ..app });
            }
        }
        let _ = NSString::from_str(name);
        Err(format!("no running app {}", if bundle_id.is_empty() { name } else { bundle_id }))
    }

    /// The main display as a PNG. Retina images are halved so the answer stays small.
    pub fn screenshot() -> Result<Shot, String> {
        let image = CGDisplay::main().image().ok_or("the screenshot failed (Screen Recording permission?)")?;
        let (w, h, bpr, bpp) = (image.width(), image.height(), image.bytes_per_row(), image.bits_per_pixel() / 8);
        if bpp < 3 {
            return Err(format!("unexpected pixel format ({} bits per pixel)", image.bits_per_pixel()));
        }
        let data = image.data();
        let bytes = data.bytes();
        let step = if w > 1800 { 2 } else { 1 };
        let (ow, oh) = (w / step, h / step);
        let mut rgb = Vec::with_capacity(ow * oh * 3);
        for y in 0..oh {
            let row = y * step * bpr;
            for x in 0..ow {
                let px = row + x * step * bpp;
                if px + 2 >= bytes.len() {
                    rgb.extend_from_slice(&[0, 0, 0]);
                    continue;
                }
                // CGDisplayCreateImage is BGRA, 32 bits little-endian.
                rgb.push(bytes[px + 2]);
                rgb.push(bytes[px + 1]);
                rgb.push(bytes[px]);
            }
        }
        let mut png = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut png, ow as u32, oh as u32);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            let mut writer = enc.write_header().map_err(|e| format!("png header: {e}"))?;
            writer.write_image_data(&rgb).map_err(|e| format!("png data: {e}"))?;
        }
        Ok(Shot { png, width: ow, height: oh })
    }

    fn ax_attr(element: AXUIElementRef, name: &str) -> Option<CFType> {
        let key = CFString::new(name);
        let mut out: CFTypeRef = std::ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(element, key.as_concrete_TypeRef(), &mut out) };
        if err != 0 || out.is_null() {
            return None;
        }
        Some(unsafe { CFType::wrap_under_create_rule(out) })
    }

    fn ax_string(element: AXUIElementRef, name: &str) -> String {
        match ax_attr(element, name) {
            Some(v) if v.instance_of::<CFString>() => unsafe { CFString::wrap_under_get_rule(v.as_CFTypeRef() as CFStringRef) }.to_string(),
            Some(v) => {
                // A number or a boolean value: its description is good enough for a match.
                let d = format!("{v:?}");
                if d.len() < 80 { d } else { String::new() }
            }
            None => String::new(),
        }
    }

    fn ax_point(element: AXUIElementRef, name: &str, kind: u32) -> (f64, f64) {
        let Some(v) = ax_attr(element, name) else { return (0.0, 0.0) };
        let mut buf = [0f64; 2];
        let ok = unsafe { AXValueGetValue(v.as_CFTypeRef(), kind, buf.as_mut_ptr() as *mut c_void) };
        if ok { (buf[0], buf[1]) } else { (0.0, 0.0) }
    }

    fn walk(element: AXUIElementRef, depth: usize, max_depth: usize, out: &mut Vec<AxNode>, max: usize) {
        if out.len() >= max || depth > max_depth {
            return;
        }
        let role = ax_string(element, "AXRole");
        let title = ax_string(element, "AXTitle");
        let value = ax_string(element, "AXValue");
        let description = ax_string(element, "AXDescription");
        let (x, y) = ax_point(element, "AXPosition", AX_VALUE_CGPOINT);
        let (w, h) = ax_point(element, "AXSize", AX_VALUE_CGSIZE);
        if !role.is_empty() && (!title.is_empty() || !value.is_empty() || !description.is_empty()) {
            out.push(AxNode { id: format!("ax{}", out.len() + 1), role, title, value, description, x, y, w, h });
        }
        if let Some(children) = ax_attr(element, "AXChildren") {
            if children.instance_of::<CFArray>() {
                let arr: CFArray<CFType> = unsafe { CFArray::wrap_under_get_rule(children.as_CFTypeRef() as _) };
                for i in 0..arr.len() {
                    if let Some(child) = arr.get(i) {
                        walk(child.as_CFTypeRef(), depth + 1, max_depth, out, max);
                    }
                }
            }
        }
    }

    pub fn tree(pid: i32, max_depth: usize, max: usize) -> Result<Vec<AxNode>, String> {
        if !unsafe { AXIsProcessTrusted() } {
            return Err("Maka is not allowed to use Accessibility (System Settings → Privacy & Security → Accessibility)".into());
        }
        let app = unsafe { AXUIElementCreateApplication(pid) };
        if app.is_null() {
            return Err("no accessibility element for the app in front".into());
        }
        let root = unsafe { CFType::wrap_under_create_rule(app) };
        let mut out = Vec::new();
        walk(root.as_CFTypeRef(), 0, max_depth, &mut out, max);
        Ok(out)
    }

    fn source() -> Result<CGEventSource, String> {
        CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| "no event source".to_string())
    }

    fn post(ev: Result<CGEvent, ()>) -> Result<(), String> {
        let ev = ev.map_err(|_| "could not make the event".to_string())?;
        ev.post(CGEventTapLocation::HID);
        Ok(())
    }

    pub fn click(x: f64, y: f64, right: bool, double: bool) -> Result<(), String> {
        let p = CGPoint::new(x, y);
        let (button, down, up) = if right { (CGMouseButton::Right, CGEventType::RightMouseDown, CGEventType::RightMouseUp) } else { (CGMouseButton::Left, CGEventType::LeftMouseDown, CGEventType::LeftMouseUp) };
        post(CGEvent::new_mouse_event(source()?, CGEventType::MouseMoved, p, button))?;
        std::thread::sleep(std::time::Duration::from_millis(30));
        let clicks = if double { 2 } else { 1 };
        for n in 1..=clicks {
            for t in [down, up] {
                let ev = CGEvent::new_mouse_event(source()?, t, p, button).map_err(|_| "could not make the click".to_string())?;
                ev.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, n);
                ev.post(CGEventTapLocation::HID);
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        Ok(())
    }

    pub fn type_text(text: &str) -> Result<(), String> {
        for chunk in text.chars().collect::<Vec<_>>().chunks(20) {
            let s: String = chunk.iter().collect();
            let down = CGEvent::new_keyboard_event(source()?, 0, true).map_err(|_| "could not make the key event".to_string())?;
            down.set_string(&s);
            down.post(CGEventTapLocation::HID);
            let up = CGEvent::new_keyboard_event(source()?, 0, false).map_err(|_| "could not make the key event".to_string())?;
            up.set_string(&s);
            up.post(CGEventTapLocation::HID);
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Ok(())
    }

    pub fn press(chord: &Chord) -> Result<(), String> {
        let flags = CGEventFlags::from_bits_truncate(chord_flags(chord));
        for down in [true, false] {
            let ev = CGEvent::new_keyboard_event(source()?, chord.key_code, down).map_err(|_| "could not make the key event".to_string())?;
            ev.set_flags(flags);
            ev.post(CGEventTapLocation::HID);
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{App, Shot};
    use crate::computer_policy::{AxNode, Chord};

    pub const NAME: &str = "unsupported";
    const NEEDS_MAC: &str = "computer control needs macOS (the Accessibility and CGEvent frameworks)";

    pub fn permissions() -> serde_json::Value {
        serde_json::json!({ "accessibility": false, "screenRecording": false })
    }
    pub fn frontmost() -> Result<App, String> {
        Err(NEEDS_MAC.into())
    }
    pub fn apps() -> Result<Vec<App>, String> {
        Err(NEEDS_MAC.into())
    }
    pub fn focus(_bundle_id: &str, _name: &str) -> Result<App, String> {
        Err(NEEDS_MAC.into())
    }
    pub fn screenshot() -> Result<Shot, String> {
        Err(NEEDS_MAC.into())
    }
    pub fn tree(_pid: i32, _max_depth: usize, _max: usize) -> Result<Vec<AxNode>, String> {
        Err(NEEDS_MAC.into())
    }
    pub fn click(_x: f64, _y: f64, _right: bool, _double: bool) -> Result<(), String> {
        Err(NEEDS_MAC.into())
    }
    pub fn type_text(_text: &str) -> Result<(), String> {
        Err(NEEDS_MAC.into())
    }
    pub fn press(_chord: &Chord) -> Result<(), String> {
        Err(NEEDS_MAC.into())
    }
}
