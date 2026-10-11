// Voice (phase 4 step 14): push-to-talk and one station voice, in the park page.
//
// Speech in: inside the macOS app the shell recognises on the device (macOS Speech, the
// Tauri commands voice_listen_start / voice_listen_stop); outside it the browser records
// (MediaRecorder) and the sidecar relays the audio to Hugging Face's recogniser. Either way
// the transcript is shown first, editable, and nothing acts on it until the Superintendent
// clicks "Ask the Peak" or "Use as the mission text" (nothing acts on a misheard word).
// Speech out: the shell's AVSpeechSynthesizer (voice_speak) or the Web Speech API; when the
// voice is on, the park says Gate items as they arrive and the Peak's answers.
// The pure parts (`voicePath`, `sentenceFor`, `speakable`) are tested under Node.

export const SPEAK_MAX_CHARS = 400;

// Which way speech-to-text can go here, and why.
export function voicePath({ tauri = false, mediaRecorder = false, asrWired = false } = {}) {
  if (tauri) return { path: 'shell', label: 'macOS Speech in the app (on the device)' };
  if (mediaRecorder && asrWired) return { path: 'browser', label: 'the browser records, Hugging Face recognises (through the sidecar; HF_TOKEN)' };
  if (mediaRecorder) return { path: 'none', label: 'not wired: no HF_TOKEN for recognition outside the app' };
  return { path: 'none', label: 'not available: this browser cannot record audio' };
}

// Plain speech from text: no URLs, no markdown marks, one breath long.
export function speakable(text) {
  let s = String(text || '')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*`#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= SPEAK_MAX_CHARS) return s;
  const cut = s.slice(0, SPEAK_MAX_CHARS);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(', '));
  return `${end > 120 ? cut.slice(0, end + 1) : cut}…`;
}

// What the park says for an event, or null for silence. Only what the event proved.
export function sentenceFor(event) {
  if (!event || !event.payload) return null;
  const p = event.payload;
  switch (event.type) {
    case 'gate.item':
      if (p.status !== 'pending') return null;
      if (p.kind === 'proposal') return speakable(`A proposal waits at the Gate: ${p.summary}.`);
      return speakable(`${p.agentId} waits at the Gate: ${p.summary}${typeof p.amountUsd === 'number' ? `, ${p.amountUsd.toFixed(2)} dollars` : ''}, under ${String(p.domain).replace(/_/g, ' ')}.`);
    case 'reflection.posted':
      return p.status === 'posted' ? speakable(`The Chief posted a reflection. ${p.portfolio || ''}`) : speakable(`The reflection was skipped: ${p.skipReason || 'no reason given'}.`);
    case 'browser.handoff':
      return p.status === 'waiting' ? speakable(`${p.agentId} needs you in the browser: ${p.kind.replace(/_/g, ' ')} at ${p.url || 'a page'}.`) : null;
    case 'recipe.run':
      return p.status === 'done' || p.status === 'failed' ? speakable(`Recipe ${p.recipeId} ${p.status}${p.reason ? `: ${p.reason}` : ''}.`) : null;
    default:
      return null;
  }
}

export function createVoice({ parent, api, getState, onMission = null, onAsk = null, tauri = typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core : null, log = console }) {
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  };
  let voiceOut = false;
  let listening = false;
  let recorder = null;
  let chunks = [];
  let shellStatus = null; // from voice_status
  const bar = el('div', { class: 'voice-bar' });
  const talk = el('button', { class: 'btn voice-talk', text: 'hold to talk', title: 'Hold to speak; release to see the transcript' });
  const out = el('button', { class: 'btn', text: 'voice: off', title: 'When on, the park says Gate items and the Peak\'s answers aloud' });
  const where = el('span', { class: 'small muted' });
  const box = el('div', { class: 'voice-box' });
  parent.append(bar);
  bar.append(talk, out, where, box);

  const path = () => {
    const s = getState();
    return voicePath({ tauri: Boolean(tauri), mediaRecorder: typeof MediaRecorder !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function', asrWired: Boolean(s.voice && s.voice.asrKey) });
  };

  async function refreshShell() {
    if (!tauri) return;
    try {
      shellStatus = await tauri.invoke('voice_status');
    } catch (err) {
      shellStatus = { available: false, reason: err && err.message ? err.message : String(err) };
    }
  }

  function render() {
    const p = path();
    const s = getState();
    where.textContent = `speech: ${p.label}${shellStatus && !shellStatus.available ? ` (${shellStatus.reason || 'not available'})` : ''}${s.voice && s.voice.hostedCap !== null && p.path === 'browser' ? ` · ${s.voice.hostedToday} of ${s.voice.hostedCap} hosted calls today` : ''} · speech out: ${tauri ? 'AVSpeechSynthesizer' : typeof speechSynthesis !== 'undefined' ? 'Web Speech' : 'none'}`;
    talk.disabled = p.path === 'none';
    talk.textContent = listening ? 'listening… release to stop' : 'hold to talk';
    talk.classList.toggle('active', listening);
    out.textContent = `voice: ${voiceOut ? 'on' : 'off'}`;
    out.classList.toggle('active', voiceOut);
  }

  function showTranscript(text, via) {
    const area = el('textarea', { class: 'prompt', rows: 2 });
    area.value = text;
    const notice = el('div', { class: 'notice', text: `heard via ${via === 'shell' ? 'macOS Speech' : via === 'huggingface' ? 'Hugging Face' : via}; nothing was sent. Edit, then choose.` });
    const close = () => box.replaceChildren();
    box.replaceChildren(
      el('div', { class: 'k', text: 'transcript' }),
      area,
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', text: 'Ask the Peak', onclick: async () => { const q = area.value.trim(); if (!q) return; notice.textContent = 'asking the Chief…'; api.post('/api/voice/heard', { via, text: q, accepted: true, use: 'ask' }).catch(() => {}); const r = await api.post('/api/peak/ask', { question: q }); if (!r.ok) { notice.textContent = `${r.body.code || r.status}: ${r.body.error || 'failed'}`; return; } notice.textContent = `${r.body.answer || '(no answer)'} — evidence: run ${r.body.runId}`; if (onAsk) onAsk(r.body); speak(r.body.answer || ''); } }),
        el('button', { class: 'btn', text: 'Use as the mission text', onclick: () => { const q = area.value.trim(); if (!q) return; api.post('/api/voice/heard', { via, text: q, accepted: true, use: 'mission' }).catch(() => {}); if (onMission) onMission(q); notice.textContent = 'Put into the mission form at the Peak; nothing was sent: click "Brief the Chief" there.'; } }),
        el('button', { class: 'btn', text: 'Discard', onclick: () => { api.post('/api/voice/heard', { via, text: area.value, accepted: false }).catch(() => {}); close(); } }),
      ),
      notice,
    );
  }

  async function startListening() {
    if (listening) return;
    const p = path();
    if (p.path === 'none') return;
    listening = true;
    render();
    try {
      if (p.path === 'shell') {
        await tauri.invoke('voice_listen_start');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : undefined);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start();
    } catch (err) {
      listening = false;
      render();
      box.replaceChildren(el('div', { class: 'notice', text: `could not start listening: ${err && err.message ? err.message : err}` }));
    }
  }

  async function stopListening() {
    if (!listening) return;
    listening = false;
    render();
    const p = path();
    try {
      if (p.path === 'shell') {
        const r = await tauri.invoke('voice_listen_stop');
        const text = typeof r === 'string' ? r : (r && r.text) || '';
        if (text.trim()) showTranscript(text.trim(), 'shell');
        else box.replaceChildren(el('div', { class: 'notice', text: 'nothing was recognised' }));
        return;
      }
      if (!recorder) return;
      const rec = recorder;
      recorder = null;
      await new Promise((resolve) => { rec.onstop = resolve; rec.stop(); });
      for (const t of rec.stream.getTracks()) t.stop();
      const blob = new Blob(chunks, { type: (rec.mimeType || 'audio/webm').split(';')[0] });
      chunks = [];
      box.replaceChildren(el('div', { class: 'notice', text: `recognising ${blob.size} bytes through the sidecar…` }));
      const r = await api.raw('/api/voice/transcribe', blob, blob.type || 'audio/webm');
      if (!r.ok) {
        box.replaceChildren(el('div', { class: 'notice', text: `${r.body.code || r.status}: ${r.body.error || 'recognition failed'}` }));
        return;
      }
      if ((r.body.text || '').trim()) showTranscript(r.body.text.trim(), 'huggingface');
      else box.replaceChildren(el('div', { class: 'notice', text: 'nothing was recognised' }));
    } catch (err) {
      box.replaceChildren(el('div', { class: 'notice', text: `listening failed: ${err && err.message ? err.message : err}` }));
    }
  }

  function speak(text) {
    const s = speakable(text);
    if (!s) return false;
    if (tauri) {
      tauri.invoke('voice_speak', { text: s }).catch((err) => log.error('voice_speak failed:', err));
      return true;
    }
    if (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined') {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(s));
      return true;
    }
    return false;
  }

  talk.addEventListener('mousedown', startListening);
  talk.addEventListener('touchstart', (e) => { e.preventDefault(); startListening(); });
  window.addEventListener('mouseup', () => { if (listening) stopListening(); });
  talk.addEventListener('touchend', (e) => { e.preventDefault(); stopListening(); });
  talk.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); startListening(); } });
  talk.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); stopListening(); } });
  out.addEventListener('click', () => { voiceOut = !voiceOut; render(); if (voiceOut) speak('Voice on.'); else if (tauri) tauri.invoke('voice_stop_speaking').catch(() => {}); else if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); });
  refreshShell().then(render);
  render();

  return {
    render,
    speak,
    // Called by app.js for every event: when the voice is on, say what the event proved.
    onEvent(event) {
      if (!voiceOut) return false;
      const s = sentenceFor(event);
      if (!s) return false;
      return speak(s);
    },
    isOn: () => voiceOut,
  };
}
