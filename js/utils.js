import { state } from './state.js';

// Fisher-Yates de verdade — `a.sort(() => Math.random() - 0.5)` (versão
// antiga) NÃO embaralha uniforme: sort() faz um número de comparações
// baseado na ordem ORIGINAL do array, e um comparador aleatório quebra as
// premissas do algoritmo, enviesando o resultado (algumas posições finais
// saem favorecidas). Isso é exatamente o motivo de certos quadrados do
// Mosaico (array de 9) quase nunca serem a resposta certa — viés real,
// confirmado e reproduzível, não impressão. Continua mutando IN PLACE e
// devolvendo a mesma referência, igual a versão antiga (ver comentário em
// game-core.js sobre sempre chamar com array descartável, tipo .slice()/
// .filter()) — só o algoritmo por dentro mudou.
export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// pequena variação aleatória por quadrado a cada rodada — muda cada canal
// RGB em até ±JITTER (imperceptível ao olho no tabuleiro), pra que um bot
// que capture a tela e procure por um valor de cor exato/memorizado de uma
// rodada pra outra não consiga confiar em correspondência de pixel idêntica.
// Só mexe no valor exibido, nunca na cor "lógica" (key/name) que decide
// quem é o quadrado certo — a mecânica do jogo não muda em nada.
const COLOR_JITTER = 6;
export function jitterHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  const clamp = v => Math.max(0, Math.min(255, v));
  const j = () => Math.round((Math.random() * 2 - 1) * COLOR_JITTER);
  const r = clamp(((n >> 16) & 255) + j());
  const g = clamp(((n >> 8) & 255) + j());
  const b = clamp((n & 255) + j());
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/* ================== formatação de hora nas mensagens de chat ==================
   compartilhado entre o chat de clã (js/guilds.js) e as mensagens diretas
   entre amigos (js/dms.js) — hora curtinha sempre visível embaixo da
   mensagem; a data completa (sem repetir a hora, ver comentário original
   junto de renderChatMessages em js/guilds.js) só aparece ao clicar */
export function formatMsgTime(at) {
  if (!at || typeof at.toMillis !== 'function') return '';
  const loc = state.lang === 'en' ? 'en-US' : state.lang === 'es' ? 'es-ES' : 'pt-BR';
  return new Date(at.toMillis()).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
}
export function formatMsgFullDateTime(at) {
  if (!at || typeof at.toMillis !== 'function') return '';
  const loc = state.lang === 'en' ? 'en-US' : state.lang === 'es' ? 'es-ES' : 'pt-BR';
  return new Date(at.toMillis()).toLocaleDateString(loc, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// eventos pro Google Analytics (se o gtag não estiver na página, vira um no-op silencioso)
export const track = (name, params) => { try { if (window.gtag) window.gtag('event', name, params || {}); } catch {} };

/* ================== RNG determinística (desafio diário) ==================
   O desafio diário precisa que TODO MUNDO veja exatamente a mesma sequência
   de cores no mesmo dia — em vez de Math.random(), usamos um gerador
   determinístico (mulberry32) semeado a partir da data do dia (hashSeed).
   Toda a lógica de rodada (dailyNewRound) chama seededPick/seededShuffle
   NA MESMA ORDEM que newRound() chama pick/shuffle, pra garantir que a
   sequência bate entre as até 3 tentativas de uma mesma pessoa e entre
   jogadores diferentes. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h >>> 0;
}
export function seededPick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
export function seededShuffle(rng, a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ================== recordes locais (modo sem conta) ================== */
export function getLocalRecord(m) {
  try { return parseInt(localStorage.getItem('colorRushRecord_' + m)) || 0; } catch { return 0; }
}
export function setLocalRecord(m, v) {
  try { localStorage.setItem('colorRushRecord_' + m, v); } catch {}
}

/* ================== sons (Web Audio, sem arquivos) ================== */
let audioCtx = null;
let muted = false;
try { muted = localStorage.getItem('colorRushMuted') === '1'; } catch {}

export function isMuted() { return muted; }
export function setMuted(v) {
  muted = v;
  try { localStorage.setItem('colorRushMuted', muted ? '1' : '0'); } catch {}
}

export function audioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
export function tone(freq, dur = 0.12, type = 'sine', vol = 0.15, delay = 0) {
  if (muted) return;
  try {
    const c = audioContext();
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur);
  } catch {}
}
// cosmético da loja (equippedSfx) troca o som do acerto — a lógica de "sobe o
// tom a cada acerto" continua igual, só muda o timbre. "variant" explícito
// permite reusar pra prévia da loja, tocando um som mesmo sem estar equipado.
export function playCorrectSfxVariant(variant, n) {
  if (variant === 'sfx_8bit') {
    const f = 220 + Math.min(n, 24) * 55;
    tone(f, 0.06, 'square', 0.13);
    tone(f * 1.5, 0.04, 'square', 0.07, 0.02);
  } else if (variant === 'sfx_splash') {
    const f = 500 + Math.min(n, 24) * 20;
    tone(f, 0.07, 'sine', 0.13);
    tone(f * 0.5, 0.12, 'sine', 0.09, 0.04);
  } else if (variant === 'sfx_bell') {
    const f = 600 + Math.min(n, 24) * 25;
    tone(f, 0.15, 'sine', 0.12);
    tone(f * 1.5, 0.12, 'sine', 0.07, 0.03);
  } else if (variant === 'sfx_laser') {
    const f = 900 + Math.min(n, 24) * 30;
    tone(f, 0.05, 'sawtooth', 0.11);
    tone(f * 0.6, 0.08, 'sawtooth', 0.08, 0.03);
  } else if (variant === 'sfx_bubble') {
    const f = 350 + Math.min(n, 24) * 25;
    tone(f, 0.05, 'triangle', 0.12);
    tone(f * 1.8, 0.06, 'triangle', 0.09, 0.05);
  } else if (variant === 'sfx_synth') {
    const f = 300 + Math.min(n, 24) * 35;
    tone(f, 0.08, 'square', 0.1);
    tone(f * 1.25, 0.08, 'square', 0.08, 0.04);
    tone(f * 1.5, 0.1, 'square', 0.06, 0.08);
  } else {
    tone(440 + Math.min(n, 24) * 40, 0.1, 'square', 0.1);
  }
}
