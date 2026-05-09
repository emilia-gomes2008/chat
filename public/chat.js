const params = new URLSearchParams(location.search);
const channelId = params.get('channelId');
const liveId    = params.get('liveId');
const MAX_MESSAGES = 30;

const setupEl    = document.getElementById('setup');
const overlayEl  = document.getElementById('overlay');
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
let currentBgValue = 'rgba(0,0,0,0.78)';
function setMsgBg(css) {
  currentBgValue = css;
  document.documentElement.style.setProperty('--msg-bg', css);
}
if (channelId || liveId) {
  applyStyles();
  runOverlay();
} else {
  runSetup();
}

// ── Style helpers ─────────────────────────────────────────────
function setRoleColor(role, hex) {
  document.documentElement.style.setProperty(`--color-${role}`, hex);
}


function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

// ── Apply styles from URL params (overlay mode) ───────────────
function applyStyles() {
  const font = params.get('font');
  const size = params.get('fontSize');
  if (font) document.body.style.fontFamily = `'${font}', sans-serif`;
  if (size) document.body.style.setProperty('--chat-font-size', `${size}px`);

  ['chatter', 'mod', 'member'].forEach(role => {
    const hex = params.get(`color-${role}`);
    if (hex) setRoleColor(role, `#${hex}`);
  });

  const msgBg = params.get('msgBg');
  if (msgBg) {
    setMsgBg(msgBg);
  } else {
    // backward-compat with old solid-only params
    const msgColor   = params.get('msgColor');
    const msgOpacity = params.get('msgOpacity');
    if (msgColor) {
      const r = parseInt(msgColor.slice(0, 2), 16);
      const g = parseInt(msgColor.slice(2, 4), 16);
      const b = parseInt(msgColor.slice(4, 6), 16);
      const a = msgOpacity ? parseInt(msgOpacity) / 100 : 0.78;
      if (!isNaN(r + g + b)) setMsgBg(`rgba(${r},${g},${b},${a})`);
    }
  }

  const textColor = params.get('textColor');
  if (textColor) document.documentElement.style.setProperty('--text-color', `#${textColor}`);

  const msgRadius = params.get('msgRadius');
  if (msgRadius) document.documentElement.style.setProperty('--msg-radius', `${msgRadius}px`);

  const borderColor = params.get('borderColor');
  const borderWidth = params.get('borderWidth') || '2';
  if (borderColor) document.documentElement.style.setProperty('--msg-border', `${borderWidth}px solid #${borderColor}`);

  if (params.get('textBold')      === '1') document.documentElement.style.setProperty('--text-font-weight', 'bold');
  if (params.get('textItalic')    === '1') document.documentElement.style.setProperty('--text-font-style', 'italic');
  if (params.get('textUnderline') === '1') document.documentElement.style.setProperty('--text-decoration', 'underline');
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

  const textStyles = { bold: false, italic: false, underline: false };

  function updatePreview() {
    const preview = document.getElementById('font-preview');
    preview.style.fontFamily   = `'${fontSelect.value}', sans-serif`;
    preview.style.fontSize     = `${sizeSlider.value}px`;
    const txt = preview.querySelector('.fp-text');
    if (txt) {
      txt.style.fontWeight     = textStyles.bold      ? 'bold'      : 'normal';
      txt.style.fontStyle      = textStyles.italic    ? 'italic'    : 'normal';
      txt.style.textDecoration = textStyles.underline ? 'underline' : 'none';
    }
  }
  updatePreview();

  // ── Channel buttons ───────────────────────────────────────
  let selectedChannelId   = 'UCmke4QQuseu1yjuDgbMYENw';
  let selectedChannelType = 'channelId';

  document.querySelectorAll('.channel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.channel-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const isCustom = btn.dataset.id === 'custom';
      document.getElementById('custom-channel').classList.toggle('hidden', !isCustom);
      if (!isCustom) {
        selectedChannelId   = btn.dataset.id;
        selectedChannelType = btn.dataset.type;
      }
    });
  });

  // ── Role colour pickers ───────────────────────────────────
  const colorInputs = {
    chatter: document.getElementById('color-chatter'),
    mod:     document.getElementById('color-mod'),
    member:  document.getElementById('color-member'),
  };
  Object.entries(colorInputs).forEach(([role, input]) => {
    const swatch = document.getElementById(`preview-${role}`);
    const apply = () => {
      setRoleColor(role, input.value);
      if (swatch) swatch.style.color = input.value;
    };
    input.addEventListener('input', apply);
    apply();
  });

  // ── Background type tabs ──────────────────────────────────
  let currentBgType = 'solid';
  const bgPanels = {
    solid:    document.getElementById('bg-panel-solid'),
    gradient: document.getElementById('bg-panel-gradient'),
    stripes:  document.getElementById('bg-panel-stripes'),
    image:    document.getElementById('bg-panel-image'),
  };

  document.querySelectorAll('.bg-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.bg-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      Object.values(bgPanels).forEach(p => p.classList.add('hidden'));
      currentBgType = tab.dataset.tab;
      bgPanels[currentBgType].classList.remove('hidden');
      applyBg();
    });
  });

  // ── Solid controls ────────────────────────────────────────
  const msgColorInput    = document.getElementById('msg-color');
  const msgOpacitySlider = document.getElementById('msg-opacity');
  const msgOpacityLabel  = document.getElementById('msg-opacity-val');

  function applyBgSolid() {
    setMsgBg(hexToRgba(msgColorInput.value, parseInt(msgOpacitySlider.value) / 100));
  }
  msgColorInput.addEventListener('input', applyBgSolid);
  msgOpacitySlider.addEventListener('input', () => {
    msgOpacityLabel.textContent = `${msgOpacitySlider.value}%`;
    applyBgSolid();
  });
  applyBgSolid();

  // ── Gradient controls ─────────────────────────────────────
  const gradColor1       = document.getElementById('grad-color1');
  const gradColor2       = document.getElementById('grad-color2');
  const gradAngleSlider  = document.getElementById('grad-angle');
  const gradAngleLabel   = document.getElementById('grad-angle-val');
  const gradOpacity      = document.getElementById('grad-opacity');
  const gradOpacityLabel = document.getElementById('grad-opacity-val');

  function applyBgGradient() {
    const a  = parseInt(gradOpacity.value) / 100;
    const c1 = hexToRgba(gradColor1.value, a);
    const c2 = hexToRgba(gradColor2.value, a);
    setMsgBg(`linear-gradient(${gradAngleSlider.value}deg,${c1},${c2})`);
  }
  [gradColor1, gradColor2].forEach(inp => inp.addEventListener('input', applyBgGradient));
  gradAngleSlider.addEventListener('input', () => {
    gradAngleLabel.textContent = `${gradAngleSlider.value}°`;
    applyBgGradient();
  });
  gradOpacity.addEventListener('input', () => {
    gradOpacityLabel.textContent = `${gradOpacity.value}%`;
    applyBgGradient();
  });

  // ── Stripes controls ──────────────────────────────────────
  const stripeColor1      = document.getElementById('stripe-color1');
  const stripeColor2      = document.getElementById('stripe-color2');
  const stripeAngleSlider = document.getElementById('stripe-angle');
  const stripeAngleLabel  = document.getElementById('stripe-angle-val');
  const stripeWidthSlider = document.getElementById('stripe-width');
  const stripeWidthLabel  = document.getElementById('stripe-width-val');
  const stripeOpacity     = document.getElementById('stripe-opacity');
  const stripeOpacityLabel = document.getElementById('stripe-opacity-val');

  function applyBgStripes() {
    const a  = parseInt(stripeOpacity.value) / 100;
    const c1 = hexToRgba(stripeColor1.value, a);
    const c2 = hexToRgba(stripeColor2.value, a);
    const deg = stripeAngleSlider.value;
    const w   = parseInt(stripeWidthSlider.value);
    setMsgBg(`repeating-linear-gradient(${deg}deg,${c1} 0,${c1} ${w}px,${c2} ${w}px,${c2} ${w * 2}px)`);
  }
  [stripeColor1, stripeColor2].forEach(inp => inp.addEventListener('input', applyBgStripes));
  stripeAngleSlider.addEventListener('input', () => {
    stripeAngleLabel.textContent = `${stripeAngleSlider.value}°`;
    applyBgStripes();
  });
  stripeWidthSlider.addEventListener('input', () => {
    stripeWidthLabel.textContent = `${stripeWidthSlider.value}px`;
    applyBgStripes();
  });
  stripeOpacity.addEventListener('input', () => {
    stripeOpacityLabel.textContent = `${stripeOpacity.value}%`;
    applyBgStripes();
  });

  // ── Image controls ────────────────────────────────────────
  const bgImageUrl      = document.getElementById('bg-image-url');
  const imgOverlay      = document.getElementById('img-overlay');
  const imgOverlayLabel = document.getElementById('img-overlay-val');

  function applyBgImage() {
    const url = bgImageUrl.value.trim();
    if (!url) { setMsgBg('rgba(0,0,0,0.78)'); return; }
    const o = (parseInt(imgOverlay.value) / 100).toFixed(2);
    setMsgBg(`linear-gradient(rgba(0,0,0,${o}),rgba(0,0,0,${o})),url('${url}') center/cover no-repeat`);
  }
  bgImageUrl.addEventListener('input', applyBgImage);
  imgOverlay.addEventListener('input', () => {
    imgOverlayLabel.textContent = `${imgOverlay.value}%`;
    applyBgImage();
  });

  function applyBg() {
    if (currentBgType === 'solid')    applyBgSolid();
    else if (currentBgType === 'gradient') applyBgGradient();
    else if (currentBgType === 'stripes')  applyBgStripes();
    else applyBgImage();
  }

  // ── Border ───────────────────────────────────────────────
  const borderEnabled     = document.getElementById('border-enabled');
  const borderColorInput  = document.getElementById('border-color');
  const borderWidthSlider = document.getElementById('border-width');
  const borderWidthLabel  = document.getElementById('border-width-val');

  function applyBorder() {
    const val = borderEnabled.checked
      ? `${borderWidthSlider.value}px solid ${borderColorInput.value}`
      : 'none';
    document.documentElement.style.setProperty('--msg-border', val);
  }
  borderEnabled.addEventListener('change', applyBorder);
  borderColorInput.addEventListener('input', applyBorder);
  borderWidthSlider.addEventListener('input', () => {
    borderWidthLabel.textContent = `${borderWidthSlider.value}px`;
    applyBorder();
  });
  applyBorder();

  // ── Text colour ───────────────────────────────────────────
  const textColorInput = document.getElementById('text-color');
  const applyTextColor = () => document.documentElement.style.setProperty('--text-color', textColorInput.value);
  textColorInput.addEventListener('input', applyTextColor);
  applyTextColor();

  // ── Text style toggles (bold / italic / underline) ────────
  const styleMap = {
    bold:      { prop: '--text-font-weight', on: 'bold',      off: 'normal' },
    italic:    { prop: '--text-font-style',  on: 'italic',    off: 'normal' },
    underline: { prop: '--text-decoration',  on: 'underline', off: 'none'   },
  };
  ['bold', 'italic', 'underline'].forEach(key => {
    const btn = document.getElementById(`style-${key}`);
    btn.addEventListener('click', () => {
      textStyles[key] = !textStyles[key];
      btn.classList.toggle('active', textStyles[key]);
      const { prop, on, off } = styleMap[key];
      document.documentElement.style.setProperty(prop, textStyles[key] ? on : off);
      updatePreview();
    });
  });

  // ── Border radius ─────────────────────────────────────────
  const msgRadiusSlider = document.getElementById('msg-radius');
  const msgRadiusLabel  = document.getElementById('msg-radius-val');
  msgRadiusSlider.addEventListener('input', () => {
    msgRadiusLabel.textContent = `${msgRadiusSlider.value}px`;
    document.documentElement.style.setProperty('--msg-radius', `${msgRadiusSlider.value}px`);
  });

  // ── Server URL field ──────────────────────────────────────
  const serverUrlInput = document.getElementById('server-url');
  const defaultOrigin = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? location.origin
    : 'http://localhost:3000';
  serverUrlInput.value = defaultOrigin;

  // ── Generate URL ──────────────────────────────────────────
  document.getElementById('go-btn').addEventListener('click', () => {
    const isCustom = !document.getElementById('custom-channel').classList.contains('hidden');
    let type, value;

    if (isCustom) {
      type  = document.getElementById('id-type').value;
      value = document.getElementById('id-value').value.trim();
      if (!value) { document.getElementById('id-value').focus(); return; }
    } else {
      type  = selectedChannelType;
      value = selectedChannelId;
    }

    const p = new URLSearchParams({
      [type]: value,
      font:            fontSelect.value,
      fontSize:        sizeSlider.value,
      'color-chatter': colorInputs.chatter.value.slice(1),
      'color-mod':     colorInputs.mod.value.slice(1),
      'color-member':  colorInputs.member.value.slice(1),
      msgBg:           currentBgValue,
      textColor:       textColorInput.value.slice(1),
      msgRadius:       msgRadiusSlider.value,
      ...(borderEnabled.checked ? {
        borderColor: borderColorInput.value.slice(1),
        borderWidth: borderWidthSlider.value,
      } : {}),
      ...(textStyles.bold      ? { textBold:      '1' } : {}),
      ...(textStyles.italic    ? { textItalic:    '1' } : {}),
      ...(textStyles.underline ? { textUnderline: '1' } : {}),
    });
    const serverBase = serverUrlInput.value.trim().replace(/\/$/, '') || location.origin;
    const url = `${serverBase}/overlay?${p.toString()}`;
    // Sanity-check: overlay requires channelId or liveId in the URL
    if (!url.includes('channelId=') && !url.includes('liveId=')) {
      alert('Erro: seleciona um canal antes de gerar o URL.');
      return;
    }
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
const seenIds = new Set();
const msgElements = new Map(); // id → DOM element, for targeted deletion

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
        if (msg.type === 'chat') {
          if (msg.id && seenIds.has(msg.id)) return;
          if (msg.id) seenIds.add(msg.id);
          addMessage(msg);
        } else if (msg.type === 'delete' && msg.id) {
          const el = msgElements.get(msg.id);
          if (el) { el.remove(); msgElements.delete(msg.id); }
        }
      } catch (e) { console.error('[chat]', e); }
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
function addMessage({ id, author, avatar, message, parts, role, badgeIcon, superchat, timestamp }) {
  const el = document.createElement('div');
  el.className = `message ${role}${superchat ? ' superchat' : ''}`;
  // Always use current time for positioning so old-timestamped messages
  // (e.g. approved from automod hold) are appended at the end instead of
  // being inserted at position 0 and immediately removed by the overflow limit.
  el.dataset.ts = Date.now();
  if (id) { el.dataset.msgid = id; msgElements.set(id, el); }

  // Avatar
  const img = document.createElement('img');
  img.className = 'avatar';
  img.alt = '';
  img.decoding = 'async';
  img.src = avatar || makeAvatarSvg(author);
  if (avatar) img.onerror = () => { img.src = makeAvatarSvg(author); };

  // Header: name text + badge icon on the right + optional superchat amount
  const header = document.createElement('div');
  header.className = 'msg-header';

  const name = document.createElement('span');
  name.className = 'name';
  name.appendChild(document.createTextNode(author));

  if (role === 'mod' || role === 'member') {
    const icon = document.createElement('img');
    icon.className = 'badge-icon';
    icon.alt = '';
    icon.src = badgeIcon || (role === 'mod' ? MOD_ICON : MEMBER_ICON);
    if (badgeIcon) icon.onerror = () => { icon.src = role === 'mod' ? MOD_ICON : MEMBER_ICON; };
    name.appendChild(icon);
  }
  header.appendChild(name);

  if (superchat) {
    const amount = document.createElement('span');
    amount.className = 'sc-amount';
    amount.textContent = superchat.amount;
    header.appendChild(amount);
  }

  // Message body (customisable background box)
  const msgBody = document.createElement('div');
  msgBody.className = 'msg-body';
  if (superchat) msgBody.style.setProperty('--sc-color', SUPERCHAT_COLOURS[superchat.color] || '#1565c0');

  const text = document.createElement('span');
  text.className = 'text';
  const msgParts = Array.isArray(parts) ? parts : [];
  if (msgParts.length) {
    for (const p of msgParts) {
      if (p.t === 'text') {
        text.append(p.v ?? '');
      } else if (p.t === 'img' && p.src) {
        const em = document.createElement('img');
        em.className = 'emoji-img';
        em.alt = p.alt || '';
        em.src = p.src;
        em.onerror = () => {
          if (p.alt) em.replaceWith(document.createTextNode(p.alt));
          else em.remove();
        };
        text.append(em);
      } else if (p.t === 'img' && p.alt) {
        text.append(document.createTextNode(p.alt));
      }
    }
  } else {
    text.textContent = message ?? '';
  }
  msgBody.appendChild(text);

  el.append(img, header, msgBody);

  // Insert at correct timestamp position (handles approved moderated messages)
  const ts = Number(el.dataset.ts);
  const children = Array.from(messagesEl.children);
  const after = children.findLast(c => Number(c.dataset.ts) <= ts);
  if (after) after.after(el);
  else messagesEl.prepend(el);

  while (messagesEl.children.length > MAX_MESSAGES) {
    const removed = messagesEl.removeChild(messagesEl.firstChild);
    if (removed.dataset.msgid) msgElements.delete(removed.dataset.msgid);
  }
}
