const params = new URLSearchParams(location.search);
const channelId = params.get('channelId');
const liveId    = params.get('liveId');
const MAX_MESSAGES = 30;

const setupEl   = document.getElementById('setup');
const overlayEl = document.getElementById('overlay');
const messagesEl = document.getElementById('messages');

// ── Role icons ────────────────────────────────────────────────
const MOD_ICON    = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="12" height="12"><path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>')}`;
const MEMBER_ICON = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="12" height="12"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>')}`;

const SUPERCHAT_COLOURS = {
  blue: '#1565c0', lightblue: '#00b0ff', green: '#00bfa5',
  yellow: '#ffb300', orange: '#e65100', magenta: '#ad1457', red: '#c62828',
};

// ── Avatar SVG fallback ───────────────────────────────────────
const AVATAR_COLOURS = [
  '#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c',
  '#3498db','#9b59b6','#e91e63','#00bcd4','#ff5722',
];

function makeAvatarSvg(name) {
  const letter = (name || '?')[0].toUpperCase();
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const colour = AVATAR_COLOURS[hash % AVATAR_COLOURS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36">
    <circle cx="18" cy="18" r="18" fill="${colour}"/>
    <text x="18" y="23" text-anchor="middle" font-size="16" font-family="Segoe UI,Arial,sans-serif" font-weight="bold" fill="white">${letter}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// ── Mode ──────────────────────────────────────────────────────
if (channelId || liveId) {
  applyFont();
  runOverlay();
} else {
  runSetup();
}

// ── Apply font from URL params ────────────────────────────────
function applyFont() {
  const font = params.get('font');
  const size = params.get('fontSize');
  if (font) document.body.style.fontFamily = `'${font}', sans-serif`;
  if (size) document.body.style.setProperty('--chat-font-size', `${size}px`);
}

// ── Setup screen ──────────────────────────────────────────────
async function runSetup() {
  setupEl.classList.remove('hidden');

  // Font family picker
  const fontSelect = document.getElementById('font-family');
  await loadFontList(fontSelect);

  // Font size slider
  const sizeSlider = document.getElementById('font-size');
  const sizeLabel  = document.getElementById('font-size-val');
  sizeSlider.addEventListener('input', () => {
    sizeLabel.textContent = `${sizeSlider.value}px`;
    updatePreview();
  });
  fontSelect.addEventListener('change', updatePreview);

  function updatePreview() {
    const preview = document.getElementById('font-preview');
    preview.style.fontFamily = `'${fontSelect.value}', sans-serif`;
    preview.style.fontSize   = `${sizeSlider.value}px`;
  }
  updatePreview();

  // Generate URL
  document.getElementById('go-btn').addEventListener('click', () => {
    const type  = document.getElementById('id-type').value;
    const value = document.getElementById('id-value').value.trim();
    if (!value) { document.getElementById('id-value').focus(); return; }

    const p = new URLSearchParams({
      [type]: value,
      font:     fontSelect.value,
      fontSize: sizeSlider.value,
    });
    const url = `${location.origin}/?${p.toString()}`;
    document.getElementById('url-text').textContent = url;
    document.getElementById('preview-link').href = url;
    document.getElementById('result').classList.remove('hidden');
  });

  document.getElementById('copy-btn').addEventListener('click', () => {
    const url = document.getElementById('url-text').textContent;
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('copy-btn');
      btn.textContent = 'Copiado!';
      setTimeout(() => { btn.textContent = 'Copiar'; }, 2000);
    });
  });
}

async function loadFontList(select) {
  let families = [];
  try {
    if ('queryLocalFonts' in window) {
      const fonts = await window.queryLocalFonts();
      families = [...new Set(fonts.map(f => f.family))].sort();
    }
  } catch { /* permission denied or not supported */ }

  if (!families.length) {
    families = [
      'Arial', 'Bahnschrift', 'Calibri', 'Cambria', 'Comic Sans MS',
      'Consolas', 'Courier New', 'Georgia', 'Impact', 'Segoe UI',
      'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
    ];
  }

  families.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    if (f === 'Segoe UI') opt.selected = true;
    select.appendChild(opt);
  });
}

// ── Chat overlay ──────────────────────────────────────────────
function runOverlay() {
  setupEl.classList.add('hidden');
  overlayEl.classList.remove('hidden');
  document.body.classList.add('overlay-mode');

  let reconnectDelay = 1000;

  function connect() {
    const ws = new WebSocket(`ws://${location.host}`);

    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify(channelId ? { type: 'start', channelId } : { type: 'start', liveId }));
    });

    ws.addEventListener('message', ({ data }) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'chat') addMessage(msg);
      } catch { /* ignore */ }
    });

    ws.addEventListener('close', () => {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30_000);
    });

    ws.addEventListener('error', () => ws.close());
  }

  connect();
}

// ── Render a message ──────────────────────────────────────────
function addMessage({ author, avatar, message, role, badgeIcon, superchat }) {
  const el = document.createElement('div');
  el.className = `message ${role}${superchat ? ' superchat' : ''}`;
  if (superchat) el.style.setProperty('--sc-color', SUPERCHAT_COLOURS[superchat.color] || '#1565c0');

  // Avatar
  const img = document.createElement('img');
  img.className = 'avatar';
  img.alt = '';
  img.decoding = 'async';
  img.src = avatar || makeAvatarSvg(author);
  if (avatar) img.onerror = () => { img.src = makeAvatarSvg(author); };

  // Header row: name badge [+ superchat amount]
  const header = document.createElement('div');
  header.className = 'msg-header';

  const name = document.createElement('span');
  name.className = 'name';
  if (role === 'mod' || role === 'member') {
    const icon = document.createElement('img');
    icon.className = 'badge-icon';
    icon.alt = '';
    icon.src = badgeIcon || (role === 'mod' ? MOD_ICON : MEMBER_ICON);
    if (badgeIcon) icon.onerror = () => { icon.src = role === 'mod' ? MOD_ICON : MEMBER_ICON; };
    name.appendChild(icon);
  }
  name.appendChild(document.createTextNode(author));
  header.appendChild(name);

  if (superchat) {
    const amount = document.createElement('span');
    amount.className = 'sc-amount';
    amount.textContent = superchat.amount;
    header.appendChild(amount);
  }

  // Message text
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = message;

  el.append(img, header, text);
  messagesEl.appendChild(el);

  while (messagesEl.children.length > MAX_MESSAGES) {
    messagesEl.removeChild(messagesEl.firstChild);
  }
}
