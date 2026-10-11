//! Voice in the shell (phase 4 step 14): speech-to-text with macOS Speech on the device and
//! speech-to-speech with AVSpeechSynthesizer, as Tauri commands the park page calls.
//!
//! The page (served by the sidecar over loopback, allowed to call these by
//! `capabilities/default.json`) holds "hold to talk": `voice_listen_start` opens the
//! microphone through AVAudioEngine and feeds an on-device `SFSpeechAudioBufferRecognitionRequest`;
//! `voice_listen_stop` ends the audio and answers the transcript the recogniser reached.
//! Only the text leaves the shell; the audio never goes anywhere. `voice_speak` says a text
//! with the one station voice (AVSpeechSynthesizer, the system's en-US voice);
//! `voice_stop_speaking` cuts it; `voice_status` says whether the device can recognise at
//! all (framework support, the authorization the user granted, on-device availability).
//! The frameworks are reached through the objc2 bindings (Rust), which this Linux build
//! environment type-checks for Apple Silicon; the microphone and the recogniser themselves
//! are verified on the Mac (docs/RELEASE_RUNBOOK.md). Off macOS every command answers
//! "voice needs macOS" and the page falls back to the browser's recorder.

use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::voice_text::{speakable, tidy_transcript};

#[derive(Debug, Clone, Serialize)]
pub struct VoiceStatus {
    pub available: bool,
    pub on_device: bool,
    pub listening: bool,
    pub speaking: bool,
    pub authorization: String,
    pub engine: &'static str,
    pub reason: Option<String>,
}

/// Managed by Tauri; the platform objects live behind the mutex and are touched only there.
#[derive(Default)]
pub struct VoiceState {
    inner: Mutex<platform::Voice>,
}

#[tauri::command]
pub fn voice_status(state: State<'_, VoiceState>) -> VoiceStatus {
    let v = state.inner.lock().unwrap_or_else(|p| p.into_inner());
    v.status()
}

#[tauri::command]
pub fn voice_listen_start(state: State<'_, VoiceState>) -> Result<(), String> {
    let mut v = state.inner.lock().unwrap_or_else(|p| p.into_inner());
    v.listen_start()
}

#[tauri::command]
pub fn voice_listen_stop(state: State<'_, VoiceState>) -> Result<String, String> {
    let mut v = state.inner.lock().unwrap_or_else(|p| p.into_inner());
    v.listen_stop().map(|t| tidy_transcript(&t))
}

#[tauri::command]
pub fn voice_speak(state: State<'_, VoiceState>, text: String) -> Result<(), String> {
    let s = speakable(&text);
    if s.is_empty() {
        return Ok(());
    }
    let mut v = state.inner.lock().unwrap_or_else(|p| p.into_inner());
    v.speak(&s)
}

#[tauri::command]
pub fn voice_stop_speaking(state: State<'_, VoiceState>) -> Result<(), String> {
    let mut v = state.inner.lock().unwrap_or_else(|p| p.into_inner());
    v.stop_speaking()
}

#[cfg(target_os = "macos")]
mod platform {
    //! macOS: the Speech framework (SFSpeechRecognizer, on-device) over an AVAudioEngine
    //! input tap, and AVSpeechSynthesizer for the station voice.
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_avf_audio::{AVAudioEngine, AVAudioPCMBuffer, AVAudioTime, AVSpeechBoundary, AVSpeechSynthesisVoice, AVSpeechSynthesizer, AVSpeechUtterance};
    use objc2_foundation::{NSError, NSString};
    use objc2_speech::{SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask, SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus};

    use super::VoiceStatus;

    /// The objects of one listening session. They are created and used under the state's
    /// mutex only; the recogniser's callbacks write into the shared transcript.
    struct Listening {
        engine: Retained<AVAudioEngine>,
        _tap: RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)>,
        request: Retained<SFSpeechAudioBufferRecognitionRequest>,
        task: Retained<SFSpeechRecognitionTask>,
        transcript: Arc<Mutex<Transcript>>,
    }

    #[derive(Default)]
    struct Transcript {
        text: String,
        is_final: bool,
        error: Option<String>,
    }

    #[derive(Default)]
    pub struct Voice {
        listening: Option<Listening>,
        synthesizer: Option<Retained<AVSpeechSynthesizer>>,
    }

    // The platform objects are only reached under the VoiceState mutex (one thread at a time),
    // which is what makes holding them in Tauri's managed state sound.
    unsafe impl Send for Voice {}

    fn authorization_name(status: SFSpeechRecognizerAuthorizationStatus) -> &'static str {
        match status {
            SFSpeechRecognizerAuthorizationStatus::Authorized => "authorized",
            SFSpeechRecognizerAuthorizationStatus::Denied => "denied",
            SFSpeechRecognizerAuthorizationStatus::Restricted => "restricted",
            SFSpeechRecognizerAuthorizationStatus::NotDetermined => "not determined",
            _ => "unknown",
        }
    }

    fn recognizer() -> Result<Retained<SFSpeechRecognizer>, String> {
        // `new` is the current locale's recogniser; a locale the framework cannot serve is
        // reported by isAvailable / supportsOnDeviceRecognition in status().
        Ok(unsafe { SFSpeechRecognizer::new() })
    }

    impl Voice {
        pub fn status(&self) -> VoiceStatus {
            let auth = unsafe { SFSpeechRecognizer::authorizationStatus() };
            let (available, on_device, reason) = match recognizer() {
                Ok(r) => {
                    let avail = unsafe { r.isAvailable() };
                    let on_device = unsafe { r.supportsOnDeviceRecognition() };
                    let reason = if !avail {
                        Some("the recogniser is not available right now".to_string())
                    } else if !on_device {
                        Some("this Mac cannot recognise on the device for this locale; the shell never sends audio off the device, so listening is off".to_string())
                    } else if auth == SFSpeechRecognizerAuthorizationStatus::Denied || auth == SFSpeechRecognizerAuthorizationStatus::Restricted {
                        Some("speech recognition is not allowed for Maka in System Settings → Privacy & Security".to_string())
                    } else {
                        None
                    };
                    (avail && on_device && reason.is_none(), on_device, reason)
                }
                Err(e) => (false, false, Some(e)),
            };
            VoiceStatus {
                available,
                on_device,
                listening: self.listening.is_some(),
                speaking: self.synthesizer.as_ref().map(|s| unsafe { s.isSpeaking() }).unwrap_or(false),
                authorization: authorization_name(auth).to_string(),
                engine: "macOS Speech (on device) + AVSpeechSynthesizer",
                reason,
            }
        }

        pub fn listen_start(&mut self) -> Result<(), String> {
            if self.listening.is_some() {
                return Err("already listening".into());
            }
            let recognizer = recognizer()?;
            if !unsafe { recognizer.supportsOnDeviceRecognition() } {
                return Err("this Mac cannot recognise speech on the device; nothing is sent off it".into());
            }
            match unsafe { SFSpeechRecognizer::authorizationStatus() } {
                SFSpeechRecognizerAuthorizationStatus::Authorized => {}
                SFSpeechRecognizerAuthorizationStatus::NotDetermined => {
                    // Ask once; the system shows its dialog and the next press proceeds.
                    let block = RcBlock::new(|_status: SFSpeechRecognizerAuthorizationStatus| {});
                    unsafe { SFSpeechRecognizer::requestAuthorization(&block) };
                    return Err("macOS asks for permission to recognise speech; allow it and hold the button again".into());
                }
                other => return Err(format!("speech recognition is {} for Maka (System Settings → Privacy & Security)", authorization_name(other))),
            }
            let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
            unsafe {
                request.setShouldReportPartialResults(true);
                request.setRequiresOnDeviceRecognition(true);
            }
            let transcript = Arc::new(Mutex::new(Transcript::default()));
            let sink = transcript.clone();
            let handler = RcBlock::new(move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                let mut t = sink.lock().unwrap_or_else(|p| p.into_inner());
                if !result.is_null() {
                    let r = unsafe { &*result };
                    let best = unsafe { r.bestTranscription() };
                    t.text = unsafe { best.formattedString() }.to_string();
                    t.is_final = unsafe { r.isFinal() };
                }
                if !error.is_null() {
                    let e = unsafe { &*error };
                    t.error = Some(e.localizedDescription().to_string());
                }
            });
            let engine = unsafe { AVAudioEngine::new() };
            let input = unsafe { engine.inputNode() };
            let format = unsafe { input.outputFormatForBus(0) };
            let req_for_tap = request.clone();
            let tap = RcBlock::new(move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
                unsafe { req_for_tap.appendAudioPCMBuffer(buffer.as_ref()) };
            });
            // The tap takes a raw block pointer; the RcBlock stays alive in `tap` until the
            // session ends (the tap is removed before `Listening` is dropped).
            unsafe { input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), RcBlock::as_ptr(&tap)) };
            unsafe { engine.prepare() };
            if let Err(e) = unsafe { engine.startAndReturnError() } {
                unsafe { input.removeTapOnBus(0) };
                return Err(format!("the microphone could not start: {} (System Settings → Privacy & Security → Microphone)", e.localizedDescription()));
            }
            let task = unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) };
            self.listening = Some(Listening { engine, _tap: tap, request, task, transcript });
            Ok(())
        }

        pub fn listen_stop(&mut self) -> Result<String, String> {
            let Some(session) = self.listening.take() else {
                return Err("not listening".into());
            };
            unsafe {
                session.engine.stop();
                session.engine.inputNode().removeTapOnBus(0);
                session.request.endAudio();
            }
            // Give the recogniser a moment to deliver its final result, then take what it has.
            let started = Instant::now();
            loop {
                {
                    let t = session.transcript.lock().unwrap_or_else(|p| p.into_inner());
                    if t.is_final || t.error.is_some() {
                        break;
                    }
                }
                if started.elapsed() > Duration::from_millis(1500) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            unsafe { session.task.cancel() };
            let t = session.transcript.lock().unwrap_or_else(|p| p.into_inner());
            if t.text.is_empty() {
                if let Some(e) = &t.error {
                    return Err(format!("nothing recognised: {e}"));
                }
            }
            Ok(t.text.clone())
        }

        pub fn speak(&mut self, text: &str) -> Result<(), String> {
            let synth = match &self.synthesizer {
                Some(s) => s.clone(),
                None => {
                    let s = unsafe { AVSpeechSynthesizer::new() };
                    self.synthesizer = Some(s.clone());
                    s
                }
            };
            unsafe {
                if synth.isSpeaking() {
                    synth.stopSpeakingAtBoundary(AVSpeechBoundary::Immediate);
                }
                let utterance = AVSpeechUtterance::speechUtteranceWithString(&NSString::from_str(text));
                if let Some(voice) = AVSpeechSynthesisVoice::voiceWithLanguage(Some(&NSString::from_str("en-US"))) {
                    utterance.setVoice(Some(&voice));
                }
                synth.speakUtterance(&utterance);
            }
            Ok(())
        }

        pub fn stop_speaking(&mut self) -> Result<(), String> {
            if let Some(s) = &self.synthesizer {
                unsafe {
                    if s.isSpeaking() {
                        s.stopSpeakingAtBoundary(AVSpeechBoundary::Immediate);
                    }
                }
            }
            Ok(())
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    //! Anywhere else the shell has no voice; the page uses the browser's recorder and the
    //! Web Speech API instead.
    use super::VoiceStatus;

    #[derive(Default)]
    pub struct Voice;

    impl Voice {
        pub fn status(&self) -> VoiceStatus {
            VoiceStatus { available: false, on_device: false, listening: false, speaking: false, authorization: "n/a".into(), engine: "none (voice needs macOS)", reason: Some("voice needs macOS".into()) }
        }
        pub fn listen_start(&mut self) -> Result<(), String> {
            Err("voice needs macOS".into())
        }
        pub fn listen_stop(&mut self) -> Result<String, String> {
            Err("voice needs macOS".into())
        }
        pub fn speak(&mut self, _text: &str) -> Result<(), String> {
            Err("voice needs macOS".into())
        }
        pub fn stop_speaking(&mut self) -> Result<(), String> {
            Ok(())
        }
    }
}
