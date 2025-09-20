// Utilities
const qs = (s, el = document) => el.querySelector(s);
const el = {
  messages: qs('#messages'),
  form: qs('#composer'),
  input: qs('#input'),
  peers: qs('#peers'),
  myName: qs('#myName'),
  myAvatar: qs('#myAvatar'),
  groupStatus: qs('#groupStatus'),
  muteToggle: qs('#muteToggle'),
  voiceSelect: qs('#voiceSelect'),
  rateRange: qs('#rateRange'),
  pitchRange: qs('#pitchRange'),
  micBtn: qs('#micBtn'),
};

let room;
let groupHash = null; // derived from IP, only hashed value is shared
let tts = {
  muted: false,
  voice: null,
  rate: 1,
  pitch: 1,
};
let recognition = null, recognizing = false;

// Init
(async function init() {
  setupTTSUI();
  groupHash = await deriveLocalGroupHash().catch(() => null);
  if (!groupHash) {
    // Fallback: isolated device-only group
    groupHash = "isolated-" + crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
    el.groupStatus.textContent = "Isolated (no network match)";
  }

  room = new WebsimSocket();
  await room.initialize();

  // Reflect self info
  const me = room.peers[room.clientId] || {};
  el.myName.textContent = me.username || "You";
  el.myAvatar.src = me.avatarUrl || "https://unavatar.io/github";
  el.myAvatar.referrerPolicy = "no-referrer";

  // Publish presence with only the hash, never raw IP
  room.updatePresence({ groupHash });

  // Subscriptions
  room.subscribePresence(updatePeerList);
  room.subscribeRoomState(() => {}); // no-op, placeholder for future
  room.onmessage = (event) => {
    const data = event.data || event;
    switch (data.type) {
      case "connected":
      case "disconnected":
        updatePeerList(room.presence);
        break;
      case "chat":
        // Only accept if same groupHash
        if (typeof data.groupHash === "string" && data.groupHash === groupHash) {
          addMessage(data.clientId, data.username, data.avatarUrl, data.text, data.timestamp);
          speak(data.text);
        }
        break;
      default:
        // ignore all other events
        break;
    }
  };

  // UI events
  el.form.addEventListener('submit', onSend);
  el.muteToggle.addEventListener('change', () => {
    tts.muted = el.muteToggle.checked;
  });
  el.voiceSelect.addEventListener('change', () => {
    const v = speechSynthesis.getVoices().find(v => v.name === el.voiceSelect.value);
    tts.voice = v || null;
  });
  el.rateRange.addEventListener('input', () => tts.rate = parseFloat(el.rateRange.value));
  el.pitchRange.addEventListener('input', () => tts.pitch = parseFloat(el.pitchRange.value));
  setupSTT();

  // Status
  el.groupStatus.textContent = groupHash.startsWith("isolated-") ? "Isolated (no network match)" : "Local-only linked";
})();

// Send message
function onSend(e) {
  e.preventDefault();
  const text = el.input.value.trim();
  if (!text) return;
  el.input.value = "";

  const self = room.peers[room.clientId] || {};
  const payload = {
    type: "chat",
    text,
    timestamp: Date.now(),
    groupHash, // only hashed group identifier is shared
    echo: true,
  };
  room.send(payload);

  // Locally render (in case echo is disabled somewhere)
  addMessage(room.clientId, self.username, self.avatarUrl, text, payload.timestamp, true);
  speak(text);
}

// Render message
function addMessage(clientId, username, avatarUrl, text, timestamp, isYou = false) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${isYou || clientId === room.clientId ? 'you' : ''}`;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const img = document.createElement('img');
  img.src = avatarUrl || "https://unavatar.io/github";
  img.alt = username || "user";
  img.width = 18; img.height = 18; img.style.borderRadius = "50%"; img.referrerPolicy = "no-referrer";

  const author = document.createElement('span');
  author.className = 'author';
  author.textContent = username || "Unknown";

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(timestamp || Date.now()).toLocaleTimeString();

  meta.append(img, author, time);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  wrap.append(meta, bubble);
  el.messages.appendChild(wrap);
  el.messages.scrollTop = el.messages.scrollHeight;
}

// Presence list
function updatePeerList() {
  // Only show peers with same groupHash
  el.peers.innerHTML = "";
  const peers = room.peers || {};
  const presence = room.presence || {};
  const items = Object.entries(peers)
    .filter(([id]) => presence[id]?.groupHash === groupHash)
    .map(([id, p]) => ({ id, ...p }));
  for (const p of items) {
    const li = document.createElement('li');
    li.className = 'peer';
    const img = document.createElement('img');
    img.src = p.avatarUrl || "https://unavatar.io/github";
    img.alt = p.username || "user";
    img.referrerPolicy = "no-referrer";
    const span = document.createElement('span');
    span.textContent = p.username || "user";
    li.append(img, span);
    el.peers.appendChild(li);
  }
}

// TTS
function setupTTSUI() {
  const loadVoices = () => {
    const voices = speechSynthesis.getVoices();
    el.voiceSelect.innerHTML = "";
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      el.voiceSelect.appendChild(opt);
    }
    // Pick a default pleasant voice
    const prefer = voices.find(v => /en-US/i.test(v.lang) && /Female|Google/.test(v.name)) || voices[0];
    if (prefer) {
      el.voiceSelect.value = prefer.name;
      tts.voice = prefer;
    }
  };
  loadVoices();
  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = loadVoices;
  }
  // Default mute off
  el.muteToggle.checked = false;
  tts.muted = false;
}

function speak(text) {
  if (!text || tts.muted) return;
  const utter = new SpeechSynthesisUtterance(text);
  if (tts.voice) utter.voice = tts.voice;
  utter.rate = tts.rate;
  utter.pitch = tts.pitch;
  speechSynthesis.speak(utter);
}

function setupSTT() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { el.micBtn.disabled = true; el.micBtn.title = "Speech recognition not supported"; return; }
  recognition = new SR(); recognition.continuous = true; recognition.interimResults = true; recognition.lang = navigator.language || 'en-US';
  let finalText = '';
  recognition.onresult = (e) => { let interim=''; for (let i=e.resultIndex;i<e.results.length;i++){const r=e.results[i]; if (r.isFinal) { finalText += r[0].transcript; } else { interim += r[0].transcript; } } el.input.value = (finalText + ' ' + interim).trim(); if (e.results[e.results.length-1].isFinal && el.input.value) { el.form.requestSubmit(); } };
  recognition.onstart = () => { recognizing = true; el.micBtn.classList.add('recording'); el.micBtn.textContent = '⏹️'; };
  recognition.onend = () => { recognizing = false; el.micBtn.classList.remove('recording'); el.micBtn.textContent = '🎙️'; };
  recognition.onerror = () => { recognizing = false; el.micBtn.classList.remove('recording'); el.micBtn.textContent = '🎙️'; };
  el.micBtn.addEventListener('click', async () => { try { recognizing ? recognition.stop() : recognition.start(); } catch {} });
}

// Derive a non-reversible local group hash from public IP.
// Never store or expose the raw IP. Only share the hash for equality checks.
async function deriveLocalGroupHash() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    // Fetch minimal IP text. If blocked or offline, it will throw and we fallback.
    const res = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok) throw new Error('ip fetch failed');
    const { ip } = await res.json();
    if (!ip) throw new Error('no ip');
    const enc = new TextEncoder().encode(ip);
    const digest = await crypto.subtle.digest('SHA-256', enc);
    const bytes = new Uint8Array(digest);
    // Truncate to 12 hex chars for compact grouping
    const hex = Array.from(bytes).slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
    return `gh-${hex}`;
  } catch {
    return null;
  }
}