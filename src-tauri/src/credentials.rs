//! The shell owns every secret. On macOS they are generic passwords in the login
//! Keychain under the service `com.makapark.maka`, one item per name (ANTHROPIC_API_KEY,
//! RESEND_API_KEY, the connector tokens, …). The sidecar never touches the Keychain: it
//! asks the broker (broker.rs) over a session-scoped Unix socket, and the broker calls
//! this module. On other platforms (development only) the store is a 0600 JSON file, the
//! same shape as the sidecar's own dev keystore.
//!
//! Names are validated here so a bad name never reaches the Keychain; `list()` comes from
//! an index item this module maintains (the Keychain has no cheap "list by service").

use std::collections::BTreeSet;

pub const SERVICE: &str = "com.makapark.maka";
pub const INDEX_ITEM: &str = "maka.index";
pub const MAX_VALUE_BYTES: usize = 64 * 1024;

pub trait Store: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
    fn list(&self) -> Result<Vec<String>, String>;
    /// Where the secrets live, for diagnostics (never a secret).
    fn describe(&self) -> String;
}

/// A credential name: the environment-variable style the sidecar uses (`ANTHROPIC_API_KEY`)
/// or a keystore name (`stripe`, `metaAds`); letters, digits, `_`, `.` and `-`, 1..64 chars.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

pub fn check_name(name: &str) -> Result<(), String> {
    if valid_name(name) {
        Ok(())
    } else {
        Err(format!("invalid credential name {name:?}"))
    }
}

pub fn check_value(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("empty value; use DEL to remove a credential".into());
    }
    if value.len() > MAX_VALUE_BYTES {
        return Err(format!("value too large ({} bytes, cap {})", value.len(), MAX_VALUE_BYTES));
    }
    Ok(())
}

/// Index maintenance shared by both backends: the index is a newline-separated sorted
/// set of names stored as one more item.
fn parse_index(text: &str) -> BTreeSet<String> {
    text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).map(String::from).collect()
}

fn render_index(set: &BTreeSet<String>) -> String {
    set.iter().cloned().collect::<Vec<_>>().join("\n")
}

/// Wraps a raw item backend (get/set/delete of one item) into a `Store` with validation
/// and the index.
pub struct Indexed<B: Backend>(pub B);

pub trait Backend: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<Vec<u8>>, String>;
    fn write(&self, account: &str, value: &[u8]) -> Result<(), String>;
    fn remove(&self, account: &str) -> Result<(), String>;
    fn describe(&self) -> String;
}

impl<B: Backend> Indexed<B> {
    fn index(&self) -> Result<BTreeSet<String>, String> {
        Ok(self.0.read(INDEX_ITEM)?.map(|b| parse_index(&String::from_utf8_lossy(&b))).unwrap_or_default())
    }
    fn save_index(&self, set: &BTreeSet<String>) -> Result<(), String> {
        if set.is_empty() {
            self.0.remove(INDEX_ITEM)
        } else {
            self.0.write(INDEX_ITEM, render_index(set).as_bytes())
        }
    }
}

impl<B: Backend> Store for Indexed<B> {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        check_name(name)?;
        if name == INDEX_ITEM {
            return Ok(None);
        }
        Ok(self.0.read(name)?.map(|b| String::from_utf8_lossy(&b).into_owned()).filter(|s| !s.is_empty()))
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        check_name(name)?;
        check_value(value)?;
        if name == INDEX_ITEM {
            return Err("reserved name".into());
        }
        self.0.write(name, value.as_bytes())?;
        let mut idx = self.index()?;
        if idx.insert(name.to_string()) {
            self.save_index(&idx)?;
        }
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        check_name(name)?;
        if name == INDEX_ITEM {
            return Err("reserved name".into());
        }
        self.0.remove(name)?;
        let mut idx = self.index()?;
        if idx.remove(name) {
            self.save_index(&idx)?;
        }
        Ok(())
    }
    fn list(&self) -> Result<Vec<String>, String> {
        Ok(self.index()?.into_iter().collect())
    }
    fn describe(&self) -> String {
        self.0.describe()
    }
}

/// macOS: generic passwords in the login Keychain.
#[cfg(target_os = "macos")]
pub mod keychain {
    use super::{Backend, SERVICE};
    use security_framework::base::Error;
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    pub struct Keychain;

    fn is_not_found(e: &Error) -> bool {
        e.code() == ERR_SEC_ITEM_NOT_FOUND
    }

    impl Backend for Keychain {
        fn read(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
            match get_generic_password(SERVICE, account) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(e) if is_not_found(&e) => Ok(None),
                Err(e) => Err(format!("keychain read failed for {account}: {e}")),
            }
        }
        fn write(&self, account: &str, value: &[u8]) -> Result<(), String> {
            set_generic_password(SERVICE, account, value).map_err(|e| format!("keychain write failed for {account}: {e}"))
        }
        fn remove(&self, account: &str) -> Result<(), String> {
            match delete_generic_password(SERVICE, account) {
                Ok(()) => Ok(()),
                Err(e) if is_not_found(&e) => Ok(()),
                Err(e) => Err(format!("keychain delete failed for {account}: {e}")),
            }
        }
        fn describe(&self) -> String {
            format!("macOS Keychain, service {SERVICE}")
        }
    }
}

/// Not macOS: a 0600 JSON file in the shell's home (development only; the sidecar's own
/// dev keystore has the same shape).
pub mod file {
    use super::Backend;
    use std::collections::BTreeMap;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::Mutex;

    pub struct FileStore {
        pub path: PathBuf,
        lock: Mutex<()>,
    }

    impl FileStore {
        pub fn new(path: PathBuf) -> Self {
            FileStore { path, lock: Mutex::new(()) }
        }
        fn load(&self) -> Result<BTreeMap<String, String>, String> {
            match fs::read_to_string(&self.path) {
                Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{} is not valid JSON: {e}", self.path.display())),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
                Err(e) => Err(format!("cannot read {}: {e}", self.path.display())),
            }
        }
        fn save(&self, map: &BTreeMap<String, String>) -> Result<(), String> {
            if let Some(dir) = self.path.parent() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let tmp = self.path.with_extension("tmp");
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp).map_err(|e| e.to_string())?;
            f.write_all(serde_json::to_string_pretty(map).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
            fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
        }
    }

    impl Backend for FileStore {
        fn read(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
            let _g = self.lock.lock().unwrap();
            Ok(self.load()?.get(account).map(|s| s.as_bytes().to_vec()))
        }
        fn write(&self, account: &str, value: &[u8]) -> Result<(), String> {
            let _g = self.lock.lock().unwrap();
            let mut map = self.load()?;
            map.insert(account.to_string(), String::from_utf8_lossy(value).into_owned());
            self.save(&map)
        }
        fn remove(&self, account: &str) -> Result<(), String> {
            let _g = self.lock.lock().unwrap();
            let mut map = self.load()?;
            if map.remove(account).is_some() {
                self.save(&map)?;
            }
            Ok(())
        }
        fn describe(&self) -> String {
            format!("file {} (development fallback, not the Keychain)", self.path.display())
        }
    }
}

/// The store for this platform.
pub fn open(home: &std::path::Path) -> Box<dyn Store> {
    #[cfg(target_os = "macos")]
    {
        let _ = home;
        Box::new(Indexed(keychain::Keychain))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(Indexed(file::FileStore::new(home.join("shell-keystore.json"))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_values_are_checked() {
        assert!(valid_name("ANTHROPIC_API_KEY"));
        assert!(valid_name("metaAds"));
        assert!(valid_name("r2.secret-1"));
        assert!(!valid_name(""));
        assert!(!valid_name("has space"));
        assert!(!valid_name(&"x".repeat(65)));
        assert!(check_value("").is_err());
        assert!(check_value(&"v".repeat(MAX_VALUE_BYTES + 1)).is_err());
        assert!(check_value("sk-1").is_ok());
    }

    #[test]
    fn file_store_round_trips_and_keeps_an_index() {
        let dir = std::env::temp_dir().join(format!("maka-cred-{}", std::process::id()));
        let store = Indexed(file::FileStore::new(dir.join("ks.json")));
        assert_eq!(store.get("ANTHROPIC_API_KEY").unwrap(), None);
        store.set("ANTHROPIC_API_KEY", "sk-1").unwrap();
        store.set("stripe", "sk_test").unwrap();
        assert_eq!(store.get("ANTHROPIC_API_KEY").unwrap().as_deref(), Some("sk-1"));
        assert_eq!(store.list().unwrap(), vec!["ANTHROPIC_API_KEY".to_string(), "stripe".to_string()]);
        store.delete("stripe").unwrap();
        store.delete("stripe").unwrap();
        assert_eq!(store.list().unwrap(), vec!["ANTHROPIC_API_KEY".to_string()]);
        assert!(store.set(INDEX_ITEM, "x").is_err());
        assert!(store.get("bad name").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join("ks.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
