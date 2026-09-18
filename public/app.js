const socket = io();

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const S = {
  screen: 'menu',
  st: null,
  botCount: 1,
  chatOpen: false,
  pendingWild: null,
  lastTopId: null,
  knownHand: new Set(),
  toastTimer: null,
  stampTimer: null,
  shuffleTimer: null,
  shuffling: false,
};

const COLOR_HEX = { red: '#e5311b', yellow: '#f2a900', green: '#009a4d', blue: '#0669b0' };

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function show(screen) {
  S.screen = screen;
  $('#screen-menu').classList.toggle('hidden', screen !== 'menu');
  $('#screen-lobby').classList.toggle('hidden', screen !== 'lobby');
  $('#screen-table').classList.toggle('hidden', screen !== 'table');
  if (screen !== 'table') {
    $('#chat-panel').classList.remove('open');
    $('#color-picker').hidden = true;
    $('#over').hidden = true;
  }
}

/* ---------- card rendering ---------- */

function svgIcon(kind) {
  const stroke = 'stroke="#fff" fill="none" stroke-width="11"';
  switch (kind) {
    case 'skip':
      return `<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="31" ${stroke}/><line x1="28" y1="28" x2="72" y2="72" stroke="#fff" stroke-width="11"/></svg>`;
    case 'reverse':
      return `<svg viewBox="0 0 100 100" aria-hidden="true">
        <path d="M30 60 a24 24 0 0 1 42 -14" ${stroke}/>
        <path d="M70 40 a24 24 0 0 1 -42 14" ${stroke}/>
        <polygon points="72,18 80,42 54,38" fill="#fff"/>
        <polygon points="28,82 20,58 46,62" fill="#fff"/>
      </svg>`;
    case 'wild':
    case 'wild4':
      return `<svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="37" fill="#fff"/>
        <path d="M50 50 L50 13 A37 37 0 0 1 87 50 Z" fill="#e5311b"/>
        <path d="M50 50 L87 50 A37 37 0 0 1 50 87 Z" fill="#f2a900"/>
        <path d="M50 50 L50 87 A37 37 0 0 1 13 50 Z" fill="#009a4d"/>
        <path d="M50 50 L13 50 A37 37 0 0 1 50 13 Z" fill="#0669b0"/>
      </svg>`;
  }
  return null;
}

function faceContent(card) {
  if (card.kind === 'number') return card.value;
  if (card.kind === 'draw2') return `<span class="plus">+<sup>2</sup></span>`;
  const icon = svgIcon(card.kind);
  return icon || card.value;
}

function cornerContent(card) {
  if (card.kind === 'number') return card.value;
  if (card.kind === 'draw2') return `+2`;
  if (card.kind === 'wild4') return `+4`;
  const icon = svgIcon(card.kind);
  return icon || '';
}

function makeCard(card, { playable = false, dim = false } = {}) {
  const el = document.createElement('div');
  el.className = `card ${card.color}` + (playable ? ' ok' : '') + (dim ? ' dim' : '');
  el.dataset.id = card.id;
  el.innerHTML = `
    <div class="oval"></div>
    <div class="face">${faceContent(card)}</div>
    <span class="corner tl">${cornerContent(card)}</span>
    <span class="corner br">${cornerContent(card)}</span>`;
  return el;
}

function backCard() {
  const el = document.createElement('div');
  el.className = 'card back';
  el.innerHTML = `<div class="oval"></div><div class="face">UNO</div>`;
  return el;
}

/* ---------- hand ---------- */

function renderHand() {
  const st = S.st;
  if (!st) return;
  const hand = $('#hand');
  const cards = st.yourHand;
  const playable = new Set(st.playable);
  const myTurn = st.canAct;

  const existing = new Map([...hand.children].map((el) => [el.dataset.id, el]));
  const fresh = [];
  cards.forEach((card) => {
    let el = existing.get(card.id);
    if (!el) {
      el = makeCard(card, { playable: myTurn && playable.has(card.id), dim: myTurn && !playable.has(card.id) });
      if (!S.knownHand.has(card.id) && S.st && S.st.status === 'playing') el.classList.add('just-in');
      S.knownHand.add(card.id);
      hand.appendChild(el);
      fresh.push(el);
    } else {
      el.classList.toggle('ok', myTurn && playable.has(card.id));
      el.classList.toggle('dim', myTurn && !playable.has(card.id));
    }
  });
  existing.forEach((el, id) => {
    if (!cards.find((c) => c.id === id) && !el.classList.contains('flying')) el.remove();
  });

  const n = hand.children.length;
  const cw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cw')) || 88;
  const ch = (cw * 7) / 5;
  const padX = parseFloat(getComputedStyle(hand).paddingLeft) || 0;
  const avail = Math.max(0, hand.clientWidth - padX * 2);
  const maxStep = cw * 0.4;
  const mid = (n - 1) / 2;
  const rotPerPos = n > 1 ? Math.min(3.2, 14 / mid) : 0;
  const endRotRad = ((mid * rotPerPos) * Math.PI) / 180;
  const endExtra = n > 1 ? (cw * Math.cos(endRotRad) + ch * Math.sin(endRotRad) - cw) / 2 : 0;
  let step = maxStep;
  if (n > 1) {
    step = Math.min(maxStep, Math.max(0, (avail - cw - endExtra * 2) / (n - 1)));
    hand.style.setProperty('--step', `${step.toFixed(2)}px`);
  }
  const squeeze = step / maxStep;
  [...hand.children].forEach((el, i) => {
    el.style.setProperty('--rot', `${((i - mid) * rotPerPos * squeeze).toFixed(2)}deg`);
    el.style.setProperty('--ty', `${(Math.abs(i - mid) * 2.4 * squeeze).toFixed(2)}px`);
    el.style.zIndex = String(i);
  });

  const myPlate = $('#my-plate');
  const me = st.players.find((p) => p.index === st.yourIndex);
  $('#my-name').textContent = me ? me.name : 'You';
  $('#my-count').textContent = cards.length;
  myPlate.classList.toggle('current', st.canAct);
}

/* ---------- opponents / piles ---------- */

function renderOpponents() {
  const st = S.st;
  const wrap = $('#t-plates');
  const others = st.players.filter((p) => p.index !== st.yourIndex);
  wrap.innerHTML = others.map((p) => `
    <div class="plate ${p.isCurrent ? 'current' : ''} ${p.disconnected ? 'off' : ''}">
      <div class="plate-backs"><i></i><i></i><i></i></div>
      <div class="plate-name">${esc(p.name)}${p.isBot ? ' · bot' : ''}</div>
      <div class="plate-count">${p.handCount}</div>
    </div>`).join('');
}

function renderPiles() {
  const st = S.st;
  $('#t-code').textContent = st.code;
  $('#t-dir').textContent = st.direction === 1 ? '↻' : '↺';

  const pile = $('#discard-pile');
  pile.style.setProperty('--curcolor', st.currentColor ? COLOR_HEX[st.currentColor] : 'transparent');

  const holder = $('#discard-card');
  const top = st.top;
  if (top) {
    const current = holder.querySelector('.card');
    if (!current || current.dataset.id !== top.id) {
      holder.innerHTML = '';
      const el = makeCard(top);
      if (S.lastTopId) el.classList.add('in');
      holder.appendChild(el);
      S.lastTopId = top.id;
    }
  }
}

/* ---------- over / uno / toast ---------- */

function renderOver() {
  const st = S.st;
  const over = $('#over');
  if (st.status !== 'over') {
    over.hidden = true;
    return;
  }
  const rm = st.rematch;
  if (rm && rm.locked) {
    over.hidden = true;
    return;
  }
  const winner = st.players.find((p) => p.index === st.winner);
  const iWon = st.winner === st.yourIndex;
  $('#over-title').textContent = iWon ? 'You win the table' : `${winner ? winner.name : 'Someone'} wins`;
  $('#over-sub').textContent = iWon
    ? 'Every card played, every color called. Clean sweep.'
    : 'The deck took it this round. Run it back?';
  $('#btn-again').style.display = '';
  $('#btn-leave2').style.display = '';
  const box = $('#rematch');
  if (!rm) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const humans = st.players.filter((p) => !p.isBot);
  $('#rematch-list').innerHTML = humans
    .map((p) => {
      const voted = rm.votes.includes(p.index);
      const mine = p.index === st.yourIndex;
      return `<li class="${voted ? 'in' : ''} ${mine ? 'me' : ''}">
        <span class="pname">${esc(p.name)}${mine ? ' (you)' : ''}</span>
        <span class="rstat">${voted ? 'in' : 'deciding…'}</span>
      </li>`;
    })
    .join('');
  $('#btn-again').disabled = rm.youVoted;
  $('#btn-again').textContent = rm.youVoted ? 'In — waiting for the table' : 'Play again';
}

function showToast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function showUnoStamp(name) {
  const s = $('#uno-stamp');
  $('#uno-who').textContent = name ? `${name} shouts` : '';
  s.classList.remove('show');
  void s.offsetWidth;
  s.classList.add('show');
  clearTimeout(S.stampTimer);
  S.stampTimer = setTimeout(() => s.classList.remove('show'), 1150);
}

/* ---------- flying card animation ---------- */

function flyToDiscard(cardEl, isBack) {
  const target = $('#discard-pile').getBoundingClientRect();
  const start = cardEl.getBoundingClientRect();
  const clone = isBack ? backCard() : cardEl.cloneNode(true);
  clone.classList.add('flying');
  clone.style.width = start.width + 'px';
  clone.style.height = start.height + 'px';
  clone.style.left = start.left + 'px';
  clone.style.top = start.top + 'px';
  clone.style.margin = '0';
  document.body.appendChild(clone);

  const dx = target.left + target.width / 2 - (start.left + start.width / 2);
  const dy = target.top + target.height / 2 - (start.top + start.height / 2);
  requestAnimationFrame(() => {
    clone.style.transform = `translate(${dx}px, ${dy}px) rotate(${isBack ? -30 : -26}deg) scale(0.92)`;
    clone.style.opacity = '0.4';
  });
  setTimeout(() => clone.remove(), 360);
}

/* ---------- reshuffle animation ---------- */

function cleanupShuffle() {
  S.shuffling = false;
  clearTimeout(S.shuffleTimer);
  const layer = $('#shuffle-layer');
  layer.innerHTML = '';
  layer.hidden = true;
  $('#screen-table').classList.remove('shuffling');
}

function playReshuffle(count) {
  cleanupShuffle();
  const layer = $('#shuffle-layer');
  layer.hidden = false;
  S.shuffling = true;
  $('#screen-table').classList.add('shuffling');
  const disc = $('#discard-pile').getBoundingClientRect();
  const deck = $('#deck-pile').getBoundingClientRect();
  const cx = (r) => r.left + r.width / 2;
  const cy = (r) => r.top + r.height / 2;
  const n = Math.max(3, Math.min(count, 14));
  const spread = Math.min(420, window.innerWidth * 0.5);
  for (let i = 0; i < n; i++) {
    const el = backCard();
    el.classList.add('shuf');
    el.style.width = disc.width + 'px';
    el.style.height = disc.height + 'px';
    const sx = cx(disc) + (Math.random() * 28 - 14);
    const sy = cy(disc) + (Math.random() * 28 - 14);
    const mx = window.innerWidth / 2 + (Math.random() * spread - spread / 2);
    const my = Math.max(90, sy - 140 - Math.random() * 170);
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
    layer.appendChild(el);
    const dur = 1150 + i * 55 + Math.random() * 120;
    el.animate(
      [
        { transform: 'translate(-50%, -50%) rotate(0deg) scale(1)', opacity: 1 },
        {
          transform: `translate(calc(-50% + ${(mx - sx).toFixed(1)}px), calc(-50% + ${(my - sy).toFixed(1)}px)) rotate(${(Math.random() * 540 - 270).toFixed(0)}deg) scale(1.06)`,
          opacity: 1,
          offset: 0.5,
        },
        {
          transform: `translate(calc(-50% + ${(cx(deck) - sx).toFixed(1)}px), calc(-50% + ${(cy(deck) - sy).toFixed(1)}px)) rotate(${(Math.random() * 80 - 40).toFixed(0)}deg) scale(0.45)`,
          opacity: 0,
        },
      ],
      { duration: dur, delay: i * 40, easing: 'cubic-bezier(0.32, 0.72, 0.35, 1)', fill: 'forwards' }
    );
    setTimeout(() => el.remove(), dur + i * 40 + 80);
  }
  S.shuffleTimer = setTimeout(cleanupShuffle, 1900);
}

/* ---------- timer ring ---------- */

function updateTimer() {
  const st = S.st;
  const ring = $('#timer-ring');
  if (!st || st.status !== 'playing' || !st.canAct || !st.turnDeadline) {
    ring.hidden = true;
  } else {
    ring.hidden = false;
    const total = st.turnTotal;
    const left = Math.max(0, st.turnDeadline - Date.now());
    ring.style.setProperty('--p', Math.min(100, (left / total) * 100) + '%');
    const secs = Math.ceil(left / 1000);
    $('#deck-pile').title = secs <= 10 ? `Draw or act — ${secs}s left` : 'Draw a card';
  }
  const rm = st && st.status === 'over' ? st.rematch : null;
  const t = $('#rematch-timer');
  if (rm && !rm.youVoted && !rm.locked && rm.deadline) {
    const secs = Math.max(0, Math.ceil((rm.deadline - Date.now()) / 1000));
    t.textContent = `${secs}s left to decide — then the table moves on without you.`;
    t.hidden = false;
  } else {
    t.hidden = true;
  }
}

setInterval(updateTimer, 250);

window.addEventListener('resize', () => {
  if (S.screen === 'table' && S.st) renderHand();
});

/* ---------- chat ---------- */

function renderChat() {
  const st = S.st;
  if (!st) return;
  const me = st.players.find((p) => p.index === st.yourIndex);
  const box = $('#chat-msgs');
  const msgs = st.chat || [];
  box.innerHTML = msgs.map((m) => `
    <div class="msg">
      <span class="mname ${me && m.name === me.name ? 'me' : ''}">${esc(m.name)}</span>
      <span class="mtext">${esc(m.text)}</span>
    </div>`).join('');
  box.scrollTop = box.scrollHeight;
}

/* ---------- actions ---------- */

function emit(action, payload = {}) {
  socket.emit(action, payload, (res) => {
    if (res && res.ok === false && res.error) showToast(res.error);
  });
}

function tryPlay(card) {
  const st = S.st;
  if (!st || !st.canAct) return;
  if (card.kind === 'wild' || card.kind === 'wild4') {
    S.pendingWild = card.id;
    $('#color-picker').hidden = false;
    return;
  }
  emit('play', { card: card.id });
}

function onState(st) {
  S.st = st;
  if (st.status === 'lobby') show('lobby');
  else if (st.status === 'playing' || st.status === 'over') show('table');
  if (S.screen === 'lobby') renderLobby();
  if (S.screen === 'table') {
    if (st.status === 'playing') cleanupShuffle();
    renderOpponents();
    renderPiles();
    renderHand();
    renderChat();
    renderOver();
    updateTimer();
    renderUnoButton();
    renderPass();
  }
}

function renderUnoButton() {
  const st = S.st;
  const me = st.players.find((p) => p.index === st.yourIndex);
  const armed = st.status === 'playing' && me && me.mustCallUno;
  const btn = $('#btn-uno');
  btn.disabled = !armed;
  btn.classList.toggle('armed', armed);
}

function renderPass() {
  const st = S.st;
  $('#btn-pass').hidden = !(st.status === 'playing' && st.canAct && st.drewThisTurn);
}

function renderLobby() {
  const st = S.st;
  $('#lobby-code').textContent = st.code;
  const list = $('#lobby-players');
  list.innerHTML = st.players.map((p) => `
    <li>
      <span class="dot ${p.isBot ? 'bot' : ''} ${p.ready ? 'rdy' : ''}"></span>
      <span class="pname">${esc(p.name)}${p.isBot ? '' : (p.index === st.yourIndex ? ' (you)' : '')}</span>
      <span class="tag ${p.ready ? 'ready-on' : ''}">${p.isBot ? 'bot' : (p.ready ? 'ready' : 'not ready')}</span>
      ${!p.isBot && p.index !== st.yourIndex && st.isHost ? `<button class="rm kick" data-kick="${p.index}" title="Kick from the table" aria-label="Kick ${esc(p.name)}">kick</button>` : ''}
      ${p.isBot ? `<button class="rm" data-index="${p.index}" title="Remove bot" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}
    </li>`).join('');
  const me = st.players.find((p) => p.index === st.yourIndex);
  const canHost = st.isHost;
  $('#btn-start').disabled = !canHost || st.players.length < 2 || !st.allReady;
  $('#btn-start').title = st.allReady ? '' : 'Waiting for everyone to be ready';
  $('#btn-add-bot').disabled = !canHost || st.players.length >= 4;
  const rb = $('#btn-ready');
  rb.textContent = me && me.ready ? 'Ready — tap to un-ready' : "I'm ready";
  rb.classList.toggle('ready-on', !!(me && me.ready));
  $('#lobby-error').textContent = '';
}

function menuError(msg) {
  const el = $('#menu-error');
  el.textContent = msg || '';
}

function leaveToMenu() {
  S.st = null;
  S.knownHand.clear();
  S.lastTopId = null;
  socket.emit('leave');
  show('menu');
}

/* ---------- menu wiring ---------- */

$('#bots-row').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  S.botCount = parseInt(chip.dataset.bots, 10);
  $$('#bots-row .chip').forEach((c) => c.classList.toggle('on', c === chip));
});

$('#btn-create').addEventListener('click', () => {
  menuError('');
  const name = $('#menu-name').value.trim();
  socket.emit('create', { name, bots: S.botCount }, (res) => {
    if (res && res.ok === false) menuError(res.error);
  });
});

$('#btn-join').addEventListener('click', () => {
  menuError('');
  const name = $('#menu-name').value.trim();
  const code = $('#join-code').value.trim().toUpperCase();
  if (!code) return menuError('Enter a table code first.');
  socket.emit('join', { name, code }, (res) => {
    if (res && res.ok === false) menuError(res.error);
  });
});

$('#menu-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-create').click();
});
$('#join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-join').click();
});

/* ---------- lobby wiring ---------- */

$('#btn-start').addEventListener('click', () => emit('start'));
$('#btn-add-bot').addEventListener('click', () => emit('add-bot'));
$('#btn-leave').addEventListener('click', leaveToMenu);
$('#btn-ready').addEventListener('click', () => {
  const me = S.st && S.st.players.find((p) => p.index === S.st.yourIndex);
  emit('ready', { on: !(me && me.ready) });
});
$('#lobby-players').addEventListener('click', (e) => {
  const rm = e.target.closest('.rm');
  if (!rm) return;
  if (rm.dataset.kick != null) emit('kick', { index: parseInt(rm.dataset.kick, 10) });
  else emit('remove-bot', { index: parseInt(rm.dataset.index, 10) });
});
$('#btn-copy').addEventListener('click', () => {
  const code = $('#lobby-code').textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(code);
});

/* ---------- table wiring ---------- */

$('#hand').addEventListener('click', (e) => {
  const el = e.target.closest('.card');
  if (!el) return;
  const st = S.st;
  if (!st || !st.canAct) return;
  if (!st.playable.includes(el.dataset.id)) return;
  const card = st.yourHand.find((c) => c.id === el.dataset.id);
  if (!card) return;
  if (card.kind === 'wild' || card.kind === 'wild4') {
    S.pendingWild = card.id;
    $('#color-picker').hidden = false;
  } else {
    flyToDiscard(el, false);
    el.style.opacity = '0';
    emit('play', { card: card.id });
  }
});

$('#deck-pile').addEventListener('click', () => {
  const st = S.st;
  if (!st || !st.canAct) return;
  emit('draw');
});

$('#btn-uno').addEventListener('click', () => emit('uno'));

$('#btn-pass').addEventListener('click', () => {
  flyToDiscard($('#discard-pile .card'), true);
  emit('pass');
});

$('#color-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('.cp');
  if (!btn) return;
  const color = btn.dataset.color;
  $('#color-picker').hidden = true;
  const cardId = S.pendingWild;
  S.pendingWild = null;
  emit('play', { card: cardId, color });
});
$('#color-picker').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.hidden = true;
    S.pendingWild = null;
  }
});

function setChat(open) {
  S.chatOpen = open;
  $('#chat-panel').classList.toggle('open', open);
  if (open) renderChat();
}
$('#btn-chat').addEventListener('click', () => setChat(!S.chatOpen));
$('#btn-chat-close').addEventListener('click', () => setChat(false));

function sendChat(text) {
  text = text.trim();
  if (!text) return;
  socket.emit('chat', { text });
  $('#chat-text').value = '';
}
$('#btn-send').addEventListener('click', () => sendChat($('#chat-text').value));
$('#chat-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat($('#chat-text').value);
});
$('.chat-quick').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) sendChat(b.dataset.q);
});

$('#btn-again').addEventListener('click', () => emit('rematch', { again: true }));
$('#btn-leave2').addEventListener('click', leaveToMenu);

/* ---------- socket events ---------- */

socket.on('state', onState);

socket.on('toast', (t) => showToast(t.text));

socket.on('uno-shout', (u) => showUnoStamp(u.name));

socket.on('reshuffle', (r) => playReshuffle(r.count));

socket.on('kicked', (k) => {
  S.st = null;
  $('#over-title').textContent = 'You were kicked';
  $('#over-sub').textContent =
    k && k.reason === 'timeout'
      ? 'You took too long to decide, so the table moved on without you.'
      : 'The party leader showed you the door.';
  $('#rematch').hidden = true;
  $('#btn-again').style.display = 'none';
  $('#btn-leave2').style.display = '';
  $('#over').hidden = false;
  show('table');
});

socket.on('chat', (m) => {
  const st = S.st;
  if (st && st.chat) {
    st.chat.push(m);
    if (S.screen === 'table') renderChat();
  }
});

socket.on('connect', () => {
  // state is pushed server-side on (re)join; nothing to do
});

show('menu');
