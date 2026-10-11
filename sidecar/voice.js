// Voice (phase 4 step 14): the sidecar's part, which is text and one relay.
//
//   createVoice({ env, keystorePath, fetch, netGuard, ledger, caps, bus, clock, baseUrl, model })
//     -> { status(), transcribe({ bytes, contentType, via }), heard({ via, text, chars }), tools: none }
//
// Speech-to-text happens in the macOS shell (macOS Speech, on-device; src-tauri/src/voice.rs)
// or, outside the shell, in the browser's MediaRecorder with Hugging Face's ASR as the
// recogniser. For that fallback the sidecar is a relay: it forwards the audio bytes to the
// Hugging Face Inference endpoint with the bearer HF_TOKEN through the outbound guard and
// answers the text. Nothing is written to disk, nothing is logged beyond the byte count and
// the duration, and the audio is dropped as soon as the answer arrives (D145). Each relay
// counts as a hosted worker call against `hostedWorkerCallsPerDay`, like an image.
// Text-to-speech is the shell's AVSpeechSynthesizer or the browser's Web Speech API; the
// sidecar never sees it. A transcript the Superintendent accepted (as a Peak question or
// a mission) is reported with `heard()` so the park's record says what was heard and
// where it was recognised; the text itself stays out of the event beyond its length.

import { makeEvent } from '../shared/events.js';
import { resolveKey } from './providers/keys.js';
import { guardedFetch, defaultNetGuard } from './netguard.js';

export const HF_ASR_BASE_URL = 'https://router.huggingface.co/hf-inference/models';
export const HF_ASR_DEFAULT_MODEL = 'openai/whisper-large-v3';
export const AUDIO_LIMIT_BYTES = 10 * 1024 * 1024; // ten megabytes of audio per request
export const AUDIO_TYPES = Object.freeze(['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/mpeg', 'audio/flac']);
export const VOICE_VIAS = Object.freeze(['shell', 'huggingface', 'browser']);

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function createVoice({ env = process.env, keystorePath, fetch: fetchImpl = globalThis.fetch, netGuard = null, ledger = null, caps = null, bus = null, clock = { now: () => Date.now() }, baseUrl = HF_ASR_BASE_URL, model = null, log = console } = {}) {
  const asrModel = model || env.HF_ASR_MODEL || HF_ASR_DEFAULT_MODEL;
  const guard = netGuard || defaultNetGuard();
  const emit = (type, payload) => bus && bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const keyFor = () => resolveKey('huggingface', { env, keystorePath });

  async function status() {
    const key = await keyFor();
    const hosted = ledger ? ledger.hostedToday() : null;
    return { asr: key ? 'huggingface' : 'not wired (HF_TOKEN)', asrKey: Boolean(key), model: asrModel, hostedToday: hosted ? hosted.calls : null, hostedCap: caps ? caps.hostedWorkerCallsPerDay : null, shell: 'macOS Speech and AVSpeechSynthesizer in the app (src-tauri); not from here', limitBytes: AUDIO_LIMIT_BYTES };
  }

  // The relay: bytes in, text out, nothing kept.
  async function transcribe({ bytes, contentType = 'audio/webm' } = {}) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw fail('NO_AUDIO', 'no audio in the request');
    if (bytes.length > AUDIO_LIMIT_BYTES) throw fail('TOO_LARGE', `audio is ${bytes.length} bytes; at most ${AUDIO_LIMIT_BYTES}`, 413);
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (!AUDIO_TYPES.includes(type)) throw fail('BAD_TYPE', `audio must be one of ${AUDIO_TYPES.join(', ')}, got ${type || 'nothing'}`, 415);
    const key = await keyFor();
    if (!key) throw fail('NOT_WIRED', 'speech recognition outside the app needs HF_TOKEN (Hugging Face); in the app, macOS Speech recognises on the device', 503);
    if (ledger && caps && typeof caps.hostedWorkerCallsPerDay === 'number' && ledger.hostedToday().calls >= caps.hostedWorkerCallsPerDay) throw fail('HOSTED_CAP', `the hosted worker reached its daily cap of ${caps.hostedWorkerCallsPerDay} call(s); recognition waits for tomorrow`, 429);
    const started = clock.now();
    let res;
    try {
      res = await guardedFetch(`${baseUrl}/${asrModel}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': type, accept: 'application/json' }, body: bytes }, { fetch: fetchImpl, guard });
    } catch (err) {
      if (err.code === 'NET_GUARD') throw fail('NET_GUARD', err.message, 502);
      throw fail('NETWORK', `Hugging Face unreachable: ${err.message}`, 502);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw fail('HF_AUTH', 'Hugging Face refused the token (check HF_TOKEN)', 502);
    if (res.status === 503) throw fail('MODEL_LOADING', `the recogniser is loading at Hugging Face; try again in a moment`, 503);
    if (!res.ok) throw fail('HF_ERROR', `Hugging Face answered ${res.status}: ${text.slice(0, 200)}`, 502);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw fail('BAD_RESPONSE', 'the recogniser answered something that is not JSON', 502);
    }
    const transcript = typeof json.text === 'string' ? json.text.trim() : '';
    const ms = clock.now() - started;
    // One hosted call, like an image: the same unpriced cost event the ledger counts.
    emit('cost.estimate', { runId: `voice-${started}`, turn: 1, provider: 'huggingface', model: asrModel, inputTokens: 0, outputTokens: 0, usd: null, reconciled: false, tier: 'hosted_worker' });
    emit('voice.transcript', { via: 'huggingface', chars: transcript.length, bytes: bytes.length, ms, accepted: false, model: asrModel });
    return { text: transcript, via: 'huggingface', model: asrModel, bytes: bytes.length, ms };
  }

  // The park page says what the Superintendent did with a transcript (and, for the shell
  // and the browser's own recogniser, that one was heard at all). Text stays out: its length is the record.
  function heard({ via, text = '', accepted = false, use = null } = {}) {
    if (!VOICE_VIAS.includes(via)) throw fail('BAD_REQUEST', `via must be one of ${VOICE_VIAS.join(', ')}`);
    const chars = String(text || '').length;
    emit('voice.transcript', { via, chars, accepted: Boolean(accepted), ...(use ? { use } : {}) });
    return { ok: true, via, chars, accepted: Boolean(accepted) };
  }

  return { status, transcribe, heard, model: asrModel };
}
