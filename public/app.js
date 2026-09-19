import { createTable3D } from './table3d.js';

const socket = io();

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const S = {
  screen: 'menu',
  st: null,
  botCount: 1,
  chatOpen: false,
  pendingWild: null,
  toastTimer: null,
  stampTimer: null,
};

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

/* ---------- 3D table ---------- */

let T3D = null;

function ensureT3D() {
  if (T3D) return T3D;
  T3D = createTable3D($('#table3d'), {
    labels: $('#hud-labels'),
    onCardClick: (id) => {
      const st = S.st;
      if (!st || !st.canAct || !st.playable.includes(id)) return;
      const card = st.yourHand.find((c) => c.id === id);
      if (!card) return;
      if (card.kind === 'wild' || card.kind === 'wild4') {
        S.pendingWild = card.id;
        $('#color-picker').hidden = false;
      } else {
        T3D.sim.releaseCard(id);
        emit('play', { card: id });
      }
    },
    onDeckClick: () => {
      const st = S.st;
      if (!st || !st.canAct) return;
      emit('draw');
    },
  });
  return T3D;
}

function renderPlate(st) {
  const me = st.players.find((p) => p.index === st.yourIndex);
  $('#my-name').textContent = me ? me.name : 'You';
  $('#my-count').textContent = (st.yourHand || []).length;
  $('#my-plate').classList.toggle('current', !!st.canAct);
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
  over.hidden = false;
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

/* ---------- timer ---------- */

function updateTimer() {
  const st = S.st;
  const bar = $('#turn-timer');
  if (!st || st.status !== 'playing' || !st.canAct || !st.turnDeadline) {
    bar.hidden = true;
  } else {
    bar.hidden = false;
    const total = st.turnTotal;
    const left = Math.max(0, st.turnDeadline - Date.now());
    bar.style.setProperty('--p', Math.min(100, (left / total) * 100) + '%');
    bar.querySelector('span').textContent = Math.ceil(left / 1000) + 's';
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

function onState(st) {
  // prev is passed straight into T3D.sync: play detection asks "whose
  // turn was it in the *previous* state", and a stale prevState
  // attributes the played card to the wrong player (or to nobody).
  const prev = S.st;
  S.st = st;
  if (st.status === 'lobby') show('lobby');
  else if (st.status === 'playing' || st.status === 'over') show('table');
  if (S.screen === 'lobby') renderLobby();
  if (S.screen === 'table') {
    if (st.status === 'playing') {
      ensureT3D();
      T3D.sync(st, prev);
      renderPlate(st);
    } else if (T3D) {
      T3D.setOver();
    }
    $('#t-code').textContent = st.code;
    $('#t-dir').textContent = st.direction === 1 ? '↻' : '↺';
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
  if (T3D) T3D.reset();
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

$('#btn-uno').addEventListener('click', () => emit('uno'));

$('#btn-pass').addEventListener('click', () => emit('pass'));

$('#color-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('.cp');
  if (!btn) return;
  const color = btn.dataset.color;
  $('#color-picker').hidden = true;
  const cardId = S.pendingWild;
  S.pendingWild = null;
  if (T3D) T3D.sim.releaseCard(cardId, { flip: false });
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

socket.on('reshuffle', () => {
  if (T3D) T3D.reshuffle();
});

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
    if (st.chat.length > 120) st.chat.shift();
    if (S.screen === 'table') renderChat();
  }
});

socket.on('connect', () => {
  // state is pushed server-side on (re)join; nothing to do
});

show('menu');
