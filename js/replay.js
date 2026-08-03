import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { db, functions } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { show } from './nav.js';
import { T, cName } from './i18n.js';
import { lvChip, modeLabel } from './levels.js';
import {
  CAOS_POOL, DAILY_COLORS, DAILY_PALETTE_OVERRIDE, DAILY_SHAPES_OVERRIDE, poolFor, poolItemById
} from './constants.js';
import { openProfileFromRanking } from './profile-public.js';

// envia o "filme" (rodadas + rastro do mouse) de uma partida que acabou de
// bater recorde — ver replayRounds/replayMouse em game-teste.js e
// saveMatchReplay em functions/index.js. Só uma chamada, no fim da partida,
// com tudo junto (não é "dispare e esqueça" por evento como touchActivity);
// não precisa do wrapper callable() porque não é um clique do usuário
// esperando resposta — roda em segundo plano enquanto a pessoa já está vendo
// a tela de resultado.
const callSaveMatchReplay = httpsCallable(functions, 'saveMatchReplay');
// conta (no servidor) esse replay como "assistido por outra pessoa" — dono
// assistindo o próprio replay não conta, e assistir de novo o mesmo replay
// também não soma de novo (ver markReplayWatched em functions/index.js).
// Melhor esforço: nunca deve atrapalhar a exibição do replay em si.
const callMarkReplayWatched = httpsCallable(functions, 'markReplayWatched');
// tenta salvar o replay algumas vezes antes de desistir — cobre quedas de
// rede de um instante bem na hora que a partida termina (upload silencioso
// que nunca chega no servidor não deixa log nenhum, nem de erro, porque a
// function nem chega a rodar). Só re-tenta ERRO DE REDE (a chamada não
// chegou no servidor) — uma resposta {ok:false} de verdade (sessão não
// confere, modo inválido etc.) é determinística, re-tentar não muda nada.
export async function saveMatchReplayWithRetry(payload, attemptsLeft = 3) {
  try {
    const res = await callSaveMatchReplay(payload);
    if (!res.data || !res.data.ok) console.warn('[replay] não salvou', res.data); // log temporário pra diagnóstico — remover depois
    return res;
  } catch (e) {
    if (attemptsLeft > 1) {
      await new Promise(r => setTimeout(r, 1200));
      return saveMatchReplayWithRetry(payload, attemptsLeft - 1);
    }
    console.warn('[replay] erro ao salvar (sem mais tentativas)', e);
    throw e;
  }
}

// desenha um quadrado do modo Trio (fundo/tc/word — ver newTrioRound em
// game-teste.js) — compartilhada entre a partida de verdade (newTrioRound), o
// replay (renderReplaySquares) e, no futuro, um tutorial dedicado, pra nunca
// desenhar esse quadrado especial de 2 jeitos diferentes por engano
export function renderTrioSquare(el, sq) {
  el.style.background = sq.bg.hex;
  el.style.boxShadow = `0 0 18px ${sq.bg.hex}99, 0 0 40px ${sq.bg.hex}55, inset 0 0 20px rgba(255,255,255,0.12)`;
  el.innerHTML = `<span class="word word-trio" style="color:${sq.tc.hex}">${cName(sq.word)}</span>`;
}

// desenha um quadrado do modo Caos (forma + cor de preenchimento + palavra,
// os 3 atributos independentes — ver newCaosRound em game-teste.js) — igual
// renderTrioSquare, função compartilhada entre a partida de verdade e o
// replay, pra nunca desenhar esse quadrado de 2 jeitos diferentes por engano
export function renderCaosSquare(el, sq) {
  el.className = 'square shape-square ' + sq.shape.shapeClass;
  el.style.background = '';
  el.style.boxShadow = '';
  el.innerHTML = `<span class="shape-fill ${sq.shape.shapeClass}" style="background:${sq.color.hex}; filter: drop-shadow(0 0 14px ${sq.color.hex}88) drop-shadow(0 0 26px ${sq.color.hex}44);"></span><span class="word">${cName(sq.word)}</span>`;
}

/* ================== tela de replay ==================
   reconstrói uma partida gravada (ver replayRounds/replayMouse em
   game-teste.js e saveMatchReplay no servidor) — não recalcula nem valida
   nada, só lê de volta o que já está salvo em replays/{sessionId} e desenha
   de novo. Rodada: cada round.sq já traz o tabuleiro inteiro resolvido (ver
   poolItemId/poolItemById), então basta reconstruir os quadrados igual o
   newRound de verdade fez na hora — sem precisar re-sortear nada. Cursor:
   anda por interpolação linear entre as duas amostras do rastro do mouse
   que cercam o instante atual (ponteiro pra frente amortizado O(1); só
   reseta e escaneia de novo se o tempo "voltar", ao arrastar a barra). */
let replayData = null;      // documento cru de replays/{sessionId}
let replayPlaying = false;
let replayAnimId = null;
let replayClockMs = 0;      // relógio de reprodução, em ms desde o início da partida gravada
let replayLastFrameAt = 0;  // performance.now() do último frame processado
let replayRoundIdx = -1;    // índice da rodada desenhada agora (evita redesenhar à toa)
let replayMouseIdx = 0;     // ponteiro pra frente no rastro do mouse
let replayTotalMs = 0;      // duração total da reprodução
let replayTargetSquareEl = null; // elemento do quadrado certo da rodada atual — usado pra disparar o flash de clique
let replayLastFlashIdx = -1;     // índice da última rodada que já disparou o flash de clique (evita repetir ao redesenhar)
const REPLAY_CLICK_FLASH_MS = 300; // janela, antes da rodada trocar, em que o "clique" é simulado (visual + som)

function renderReplaySquares(round, idx) {
  const rmode = replayData.mode;
  // replay do desafio diário (kind:'daily', ver saveMatchReplay em
  // functions/index.js) usa a paleta/pool estendidos do desafio diário nos
  // modos Clássico/Reverso/Formas/Formas Reverso — mesmo "mode" que o jogo
  // livre usa, então só dá pra saber qual pool reconstruir checando esse
  // flag à parte. Usa a paleta/pool DO DIA em que a partida foi jogada
  // (createdAt), não a de hoje — senão um dia com DAILY_PALETTE_OVERRIDE/
  // DAILY_SHAPES_OVERRIDE (ver dailyPoolFor) faz o replay tentar achar
  // chaves tipo 'blue'/'cyan' (ou um shapeClass de naipe) num pool que não
  // tem essas chaves, caindo todo no pool[0] (era isso que deixava tudo
  // amarelo antes de existir esse cuidado com a data certa).
  // dailyLocalDateStr vem de game-teste.js (domínio do desafio diário, ainda
  // não é um módulo próprio — fase futura), exposta lá só pra essa ponte
  const replayDateStr = (replayData.createdAt && typeof replayData.createdAt.toMillis === 'function')
    ? window.dailyLocalDateStr(new Date(replayData.createdAt.toMillis()))
    : window.dailyLocalDateStr();
  const pool = (replayData.kind === 'daily' && (rmode === 'classic' || rmode === 'reverse'))
    ? (DAILY_PALETTE_OVERRIDE[replayDateStr] || DAILY_COLORS)
    : (replayData.kind === 'daily' && (rmode === 'shapes' || rmode === 'shapes-reverse'))
      ? (DAILY_SHAPES_OVERRIDE[replayDateStr] || poolFor(rmode))
      : poolFor(rmode);
  const grid = $('replay-grid');
  grid.innerHTML = '';
  replayTargetSquareEl = null;
  let targetItem = null;
  let pairA = null, pairB = null; // só usados no modo Trio (ver abaixo)
  round.sq.forEach(cell => {
    const el = document.createElement('div');
    el.className = 'square';
    if (rmode === 'trio') {
      const sq = { bg: poolItemById(pool, cell.bg), tc: poolItemById(pool, cell.tc), word: poolItemById(pool, cell.word) };
      renderTrioSquare(el, sq);
      if (cell.pairA) { pairA = poolItemById(pool, cell.pairA); pairB = poolItemById(pool, cell.pairB); }
    } else if (rmode === 'caos') {
      const sq = { shape: poolItemById(CAOS_POOL, cell.shape), color: poolItemById(CAOS_POOL, cell.color), word: poolItemById(CAOS_POOL, cell.word) };
      renderCaosSquare(el, sq);
      if (cell.pairA) { pairA = poolItemById(CAOS_POOL, cell.pairA); pairB = poolItemById(CAOS_POOL, cell.pairB); }
    } else {
      const item = poolItemById(pool, cell.id);
      const paired = poolItemById(pool, cell.paired);
      if (rmode === 'shapes' || rmode === 'shapes-reverse') {
        const shapeSide = (rmode === 'shapes') ? item : paired;
        const wordSide  = (rmode === 'shapes') ? paired : item;
        el.classList.add('shape-square', shapeSide.shapeClass);
        // shapeSide.glyph: ver mesmo comentário em daily-challenge.js
        // (dailyNewRound) -- formas com override que usam glyph Unicode em
        // vez de clip-path (naipes de baralho, curvas complexas demais)
        const fillHtml = shapeSide.glyph
          ? `<span class="shape-fill shape-glyph">${shapeSide.glyph}</span>`
          : `<span class="shape-fill ${shapeSide.shapeClass}"></span>`;
        el.innerHTML = `${fillHtml}<span class="word">${cName(wordSide)}</span>`;
      } else {
        const bg   = (rmode === 'classic') ? item : paired;
        const word = (rmode === 'classic') ? paired : item;
        el.style.background = bg.pattern || bg.hex; // "zebra" (só no desafio diário) usa listras em vez de hex sólido
        el.style.boxShadow = `0 0 18px ${bg.hex}99, 0 0 40px ${bg.hex}55, inset 0 0 20px rgba(255,255,255,0.12)`;
        el.innerHTML = `<span class="word">${cName(word)}</span>`;
      }
      if (cell.isTarget) targetItem = item;
    }
    // não marca mais o quadrado certo o tempo todo (era um contorno
    // tracejado fixo) — agora o quadrado certo só se destaca no instante
    // exato do clique, via triggerReplayClickFlash abaixo
    if (cell.isTarget) replayTargetSquareEl = el;
    grid.appendChild(el);
  });
  // instrução igual à da partida de verdade (ver newRound/newTrioRound): na
  // primeira rodada (idx 0) nomeia o alvo (INSTR_FIRST — ainda não tem o que
  // memorizar); nas seguintes é genérica (INSTR_NEXT — supõe que quem jogou
  // memorizou o alvo no fim da rodada anterior), mesmo texto/i18n de sempre
  const INSTR_FIRST = {
    classic: () => T[state.lang].instr_first_classic(cName(targetItem)),
    reverse: () => T[state.lang].instr_first_reverse(cName(targetItem)),
    shapes: () => T[state.lang].instr_first_shapes(cName(targetItem)),
    'shapes-reverse': () => T[state.lang].instr_first_shapes_reverse(cName(targetItem)),
    // fallback pra replays gravados antes do fix do sanitizeReplayRounds no
    // servidor (pairA/pairB descartados por engano) — em vez de travar toda
    // a tela com cName(null), cai pra instrução genérica do modo Trio
    trio: () => (pairA && pairB) ? T[state.lang].instr_first_trio(cName(pairA), cName(pairB)) : T[state.lang].instr_next_trio,
    caos: () => (pairA && pairB) ? T[state.lang].instr_first_caos(cName(pairA), cName(pairB)) : T[state.lang].instr_next_caos,
  };
  const INSTR_NEXT = {
    classic: T[state.lang].instr_next_classic,
    reverse: T[state.lang].instr_next_reverse,
    shapes: T[state.lang].instr_next_shapes,
    'shapes-reverse': T[state.lang].instr_next_shapes_reverse,
    trio: T[state.lang].instr_next_trio,
    caos: T[state.lang].instr_next_caos,
  };
  $('replay-instruction').textContent = (idx === 0) ? INSTR_FIRST[rmode]() : INSTR_NEXT[rmode];
}

// dispara o "efeito de clique" (flash verde + som) no quadrado certo da
// rodada idx, no instante em que ela é sincronizada com o clique de verdade
// que a encerrou — ver chamada em renderReplayFrame. sfx vem de
// game-teste.js (ainda não é um módulo próprio — fase futura), exposta lá só
// pra essa ponte
function triggerReplayClickFlash(idx) {
  if (replayTargetSquareEl) {
    replayTargetSquareEl.classList.remove('replay-click-flash');
    void replayTargetSquareEl.offsetWidth; // força reflow pra poder retriggerar a animação se o elemento ainda tiver a classe de uma execução anterior
    replayTargetSquareEl.classList.add('replay-click-flash');
  }
  window.sfx.correct(idx + 1); // idx é a rodada que terminou; idx+1 é o placar resultante do clique — mesmo valor usado na partida real (ver handleClick)
}

function updateReplayCursor(ms) {
  const cursor = $('replay-cursor');
  const trail = replayData.mouseTrail;
  if (!trail || trail.length === 0) { cursor.style.display = 'none'; return; }
  cursor.style.display = '';
  // amostras vêm do Firestore como objetos {x,y,t} (arrays-de-array não são
  // permitidos como valor de campo — ver sanitizeReplayMouseTrail no servidor)
  if (replayMouseIdx > 0 && trail[replayMouseIdx].t > ms) replayMouseIdx = 0; // tempo voltou (arrastou a barra) — reescaneia
  while (replayMouseIdx < trail.length - 1 && trail[replayMouseIdx + 1].t <= ms) replayMouseIdx++;
  const a = trail[replayMouseIdx];
  const b = trail[Math.min(replayMouseIdx + 1, trail.length - 1)];
  let xPct = a.x, yPct = a.y;
  if (b !== a && b.t > a.t) {
    const frac = Math.max(0, Math.min(1, (ms - a.t) / (b.t - a.t)));
    xPct = a.x + (b.x - a.x) * frac;
    yPct = a.y + (b.y - a.y) * frac;
  }
  const grid = $('replay-grid');
  cursor.style.left = (xPct * grid.offsetWidth) + 'px';
  cursor.style.top = (yPct * grid.offsetHeight) + 'px';
}

function formatReplayTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// duração do cronômetro da rodada idx — não foi gravada em lugar nenhum,
// mas não precisa: é sempre 10s na primeira rodada e encolhe 5% a cada
// acerto (ver "duration *= 0.95" em handleClick/dailyHandleClick), uma regra
// fixa do jogo, então dá pra recalcular só a partir do índice da rodada
function replayRoundDuration(idx) {
  return 10000 * Math.pow(0.95, idx);
}

// ▶️ pausado no meio | ⏸️ tocando | 🔁 chegou ao fim (clicar recomeça do zero)
function updateReplayPlayIcon() {
  $('replay-play-btn').textContent = replayPlaying ? '⏸️' : (replayClockMs >= replayTotalMs ? '🔁' : '▶️');
}

function renderReplayFrame(ms) {
  if (!replayData) return;
  const rounds = replayData.rounds;
  let idx = 0;
  for (let i = 0; i < rounds.length; i++) { if (rounds[i].t <= ms) idx = i; else break; }
  if (idx !== replayRoundIdx) {
    renderReplaySquares(rounds[idx], idx);
    replayRoundIdx = idx;
  }
  // simula o clique (flash + som) perto do fim da rodada idx, no instante em
  // que a rodada seguinte de verdade começou (rounds[idx+1].t) — só existe
  // pra rodadas que realmente tiveram um acerto (a última rodada gravada
  // nunca teve, já que terminou em erro/tempo esgotado, sem gerar próxima)
  const nextRoundT = (idx + 1 < rounds.length) ? rounds[idx + 1].t : null;
  if (nextRoundT !== null && replayLastFlashIdx !== idx && ms >= nextRoundT - REPLAY_CLICK_FLASH_MS) {
    triggerReplayClickFlash(idx);
    replayLastFlashIdx = idx;
  }
  // barra de tempo da rodada — mesma lógica visual do jogo de verdade
  // (timer-fill encolhendo de 100% a 0%), só que aqui é 100% calculada a
  // partir do relógio da reprodução em vez de um requestAnimationFrame
  // próprio, pra ficar sempre sincronizada com o resto da tela
  const elapsedInRound = ms - rounds[idx].t;
  const roundPct = Math.max(0, 1 - elapsedInRound / replayRoundDuration(idx)) * 100;
  $('replay-timer-fill').style.width = roundPct + '%';
  $('replay-score').textContent = idx;
  $('replay-time-label').textContent = `${formatReplayTime(ms)} / ${formatReplayTime(replayTotalMs)}`;
  $('replay-scrub').value = String(Math.round(ms));
  updateReplayCursor(ms);
}

function replayTick(now) {
  if (!replayPlaying) return;
  const dt = now - replayLastFrameAt;
  replayLastFrameAt = now;
  replayClockMs += dt;
  if (replayClockMs >= replayTotalMs) {
    replayClockMs = replayTotalMs;
    renderReplayFrame(replayClockMs);
    replayPlaying = false;
    cancelAnimationFrame(replayAnimId);
    updateReplayPlayIcon(); // chegou ao fim — vira 🔁 (recomeçar)
    return;
  }
  renderReplayFrame(replayClockMs);
  replayAnimId = requestAnimationFrame(replayTick);
}

function startReplayClock() {
  replayPlaying = true;
  updateReplayPlayIcon();
  replayLastFrameAt = performance.now();
  replayAnimId = requestAnimationFrame(replayTick);
}
function stopReplayClock() {
  replayPlaying = false;
  cancelAnimationFrame(replayAnimId);
}

// "27/07/2026, 14:32" no idioma atual — mesmo padrão de fmtDateTime (painel
// de admin), mas com locale certo pra cada idioma (essa tela é pública, não
// só pra você) e sem depender de admin:true
function formatReplayDateTime(ts) {
  if (!ts || typeof ts.toMillis !== 'function') return '';
  const loc = state.lang === 'en' ? 'en-US' : state.lang === 'es' ? 'es-ES' : 'pt-BR';
  return new Date(ts.toMillis()).toLocaleString(loc, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

window.openReplay = async (sessionId, nick, stats) => {
  show('replay-screen');
  $('replay-meta').innerHTML = '';
  $('replay-loading').style.display = '';
  $('replay-error').style.display = 'none';
  $('replay-content').style.display = 'none';
  stopReplayClock();
  replayData = null;
  try {
    const snap = await getDoc(doc(db, 'replays', sessionId));
    if (!snap.exists()) throw new Error('not found');
    const data = snap.data();
    if (!Array.isArray(data.rounds) || data.rounds.length === 0) throw new Error('empty');
    replayData = data;
    if (!state.offline && state.currentUser && state.currentUser.uid !== data.uid) {
      callMarkReplayWatched({ sessionId }).catch(() => {});
    }
    // nick, nível, modo e data/hora tudo na mesma linha — nick clicável (igual
    // aos outros nicks de ranking) abre o perfil de quem jogou, e volta pra
    // esta mesma tela de replay ao fechar. "stats" vem da própria linha do
    // ranking que abriu o replay (ver rowData nos call sites), sem precisar
    // de leitura extra — e é o mesmo objeto que openProfileFromRanking espera
    const metaEl = $('replay-meta');
    const nickSpan = document.createElement('span');
    nickSpan.textContent = nick || '';
    nickSpan.className = 'nick-click';
    nickSpan.style.color = '#cfd8ff';
    nickSpan.style.fontWeight = '700';
    nickSpan.onclick = () => openProfileFromRanking({ uid: data.uid, nick, stats }, 'replay-screen');
    metaEl.appendChild(nickSpan);
    const rest = [lvChip(stats && stats.xp), modeLabel(data.mode), formatReplayDateTime(data.createdAt)].filter(Boolean);
    if (rest.length) {
      metaEl.appendChild(document.createTextNode(' · '));
      const restSpan = document.createElement('span');
      restSpan.innerHTML = rest.join(' · ');
      metaEl.appendChild(restSpan);
    }
    replayTotalMs = data.rounds[data.rounds.length - 1].t + 3000; // segura a última rodada na tela por mais um instante
    replayRoundIdx = -1;
    replayMouseIdx = 0;
    replayLastFlashIdx = -1;
    replayClockMs = 0;
    $('replay-scrub').max = String(Math.round(replayTotalMs));
    $('replay-scrub').value = '0';
    $('replay-loading').style.display = 'none';
    $('replay-content').style.display = 'flex';
    renderReplayFrame(0);
    startReplayClock();
  } catch (e) {
    console.error('[replay] falha ao carregar', e); // log temporário pra diagnóstico — remover depois
    $('replay-loading').style.display = 'none';
    $('replay-error').style.display = '';
  }
};

window.closeReplay = () => {
  stopReplayClock();
  replayData = null;
  show('ranking-screen');
};

window.toggleReplayPlayback = () => {
  if (!replayData) return;
  if (replayPlaying) {
    stopReplayClock();
    updateReplayPlayIcon();
  } else {
    if (replayClockMs >= replayTotalMs) replayClockMs = 0; // no fim, ▶️/🔁 sempre recomeça do zero
    startReplayClock();
  }
};

window.scrubReplay = (val) => {
  if (!replayData) return;
  stopReplayClock();
  replayClockMs = Math.max(0, Math.min(Number(val), replayTotalMs));
  updateReplayPlayIcon();
  replayRoundIdx = -1; // força redesenho mesmo se cair na mesma rodada de antes
  replayLastFlashIdx = -1; // permite o flash de clique disparar de novo se arrastar de volta pra essa janela
  renderReplayFrame(replayClockMs);
};
