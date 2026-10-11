//! See Cargo.toml: the shell's pure modules, included by path, tested on any host.
#![allow(dead_code)]

#[path = "../../src/credentials.rs"]
pub mod credentials;
#[path = "../../src/broker.rs"]
pub mod broker;
#[path = "../../src/local_http.rs"]
pub mod local_http;
#[path = "../../src/voice_text.rs"]
pub mod voice_text;
#[path = "../../src/computer_policy.rs"]
pub mod computer_policy;
