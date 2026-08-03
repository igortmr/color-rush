import {
  doc, getDoc, collection, query, where, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db, callable } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { show } from './nav.js';
import { T, cName } from './i18n.js';
import { COLORS, COLORS_12, SHAPES, CAOS_POOL, ALL_MODES } from './constants.js';
import { avatarOrDefaultIcon, lvChip, myXp, blockIfBanned, modeLabel, MODE_ICON, modeUnlockedForXp } from './levels.js';
import { equippedAvatar } from './shop.js';
import { showFriendActionError } from './friends.js';
import { refreshBadgeNotifDot } from './badges.js';
import { renderTrioSquare, renderCaosSquare } from './replay.js';

// duelo ao vivo (PvP) — igual ao resto: quem decide o que aconteceu é sempre
// a function (o servidor), nunca o navegador direto
const callChallengeFriend = callable('challengeFriend');
const callRespondChallenge = callable('respondChallenge');
const callCancelChallenge = callable('cancelChallenge');
const callSubmitPvpAnswer = callable('submitPvpAnswer');
const callClaimTimeout = callable('claimTimeout');
const callForfeitMatch = callable('forfeitMatch');

/* ================== PvP (duelo ao vivo) ================== */
// Diferente do resto do jogo: aqui quem manda é sempre o servidor. O cliente
// nunca decide sozinho "eu acertei" ou "o tempo acabou" — ele só chama a
// function e espera o documento da partida em matches/{matchId} mudar (via
// onSnapshot, ao vivo) pra saber o que realmente aconteceu. Ver
// functions/index.js pra entender a autoridade do servidor sobre isso.
const PVP_TURN_BANK_MS = 20000; // tem que bater com o servidor
const PVP_COUNTDOWN_MS = 3000;  // idem — contagem "3, 2, 1" antes do duelo começar de vez

let pvpMatchesUnsub = null;   // cancela o listener (chamado no logout)
let pvpMatchesById = {};      // cache local: matchId -> dados do match
let pvpCurrentMatchId = null; // qual partida está aberta na tela de duelo agora
let pvpAnimFrame = null;      // rAF que desenha as barras de tempo
let pvpClaimedForTurn = null; // turnStartedAt (ms) da tentativa pra qual já tentamos reivindicar timeout (evita repetir)
let pvpLastBonusAt = null;    // overtimeBonusAt (ms) do último bônus de +5s que já mostramos na tela
let pvpBonusToastTimer = null;
let pvpLastAttemptAt = null;  // lastAttempt.at (ms) da última tentativa pra qual já tocamos som
let pvpClockOffsetMs = 0;     // diferença entre o relógio do navegador e o do servidor (ver updatePvpClockOffset)
let pvpCountdownAnimFrame = null; // rAF da contagem "3, 2, 1" antes do duelo começar
let pvpCountdownLastNum = null;   // último número (3, 2 ou 1) que já tocamos o beep, pra não repetir
let pvpResultSoundPlayed = false; // evita tocar o som de vitória/derrota/empate mais de uma vez pra mesma partida
let pvpOppXpCache = {};       // uid do adversário -> xp já buscado (pra mostrar o level dele na tela de duelo)
let pvpOppEquippedCache = {}; // uid do adversário -> equipped já buscado (pra mostrar o avatar dele na tela de duelo) — vem do MESMO getDoc de cima, sem leitura extra

// busca o XP (e o equipped, pro avatar) do adversário em scores/{uid}
// (público) só uma vez por uid, e reaproveita entre partidas/reaberturas da
// tela. Enquanto ainda não chegou, devolve undefined (o chip de nível some
// até a busca terminar).
function getPvpOppXp(uid) {
  const cached = pvpOppXpCache[uid];
  if (cached === undefined) ensurePvpOppXp(uid);
  return cached === null ? undefined : cached;
}
function getPvpOppEquipped(uid) {
  return pvpOppEquippedCache[uid] || {};
}
async function ensurePvpOppXp(uid) {
  if (uid in pvpOppXpCache) return; // já tem (ou já está buscando)
  pvpOppXpCache[uid] = null; // marca como "buscando" pra não disparar duas buscas
  let xp = 0;
  let equipped = {};
  try {
    const snap = await getDoc(doc(db, 'scores', uid));
    xp = (snap.exists() && snap.data().xp) || 0;
    equipped = (snap.exists() && snap.data().equipped) || {};
  } catch {}
  pvpOppXpCache[uid] = xp;
  pvpOppEquippedCache[uid] = equipped;
  // agora que já temos o nível, atualiza a tela de duelo se ainda for a
  // mesma partida aberta
  const cur = pvpMatchesById[pvpCurrentMatchId];
  if (cur) renderPvpScreen(cur);
}

// nick do participante + avatar e chip de nível ao lado — nick sempre via
// textContent/createTextNode (nunca interpolado em innerHTML, pode ter
// qualquer caractere), avatar e chip são HTML fixo/confiável
function setPvpNameWithLevel(el, labelText, xp, avatarId) {
  el.innerHTML = '';
  el.insertAdjacentHTML('beforeend', avatarOrDefaultIcon(avatarId, 32) + ' ');
  el.appendChild(document.createTextNode(labelText));
  if (xp !== undefined) el.insertAdjacentHTML('beforeend', ' ' + lvChip(xp));
}

export function startPvpListener() {
  stopPvpListener();
  if (state.offline || !state.currentUser) return;
  const q = query(collection(db, 'matches'), where('players', 'array-contains', state.currentUser.uid));
  pvpMatchesUnsub = onSnapshot(q, snapshot => {
    pvpMatchesById = {};
    snapshot.forEach(d => { pvpMatchesById[d.id] = { id: d.id, ...d.data() }; });
    updatePvpClockOffset();
    handlePvpMatchesUpdate();
  }, () => {}); // erro de rede etc.: o próprio listener tenta de novo sozinho
}

// o relógio do navegador pode estar um pouco adiantado ou atrasado em relação
// ao do servidor (comum principalmente em celulares) — sem corrigir isso, a
// barra de tempo de quem está na vez podia mostrar um valor errado logo no
// início do turno (ex: 15s em vez de 10s, se o relógio local estiver ~5s
// atrasado). Estimamos a diferença comparando "agora" no navegador com o
// carimbo de tempo do servidor (updatedAt) que acabou de chegar numa partida
// ativa, e usamos essa correção em vez do relógio local puro pra calcular
// quanto tempo já passou no turno atual.
function updatePvpClockOffset() {
  const ref = Object.values(pvpMatchesById).find(m => (m.status === 'active' || m.status === 'starting') && m.updatedAt);
  if (!ref) return;
  pvpClockOffsetMs = Date.now() - ref.updatedAt.toMillis();
}

export function stopPvpListener() {
  if (pvpMatchesUnsub) { pvpMatchesUnsub(); pvpMatchesUnsub = null; }
  pvpMatchesById = {};
  pvpCurrentMatchId = null;
  pvpLastBonusAt = null;
  pvpLastAttemptAt = null;
  pvpOppXpCache = {};
  clearTimeout(pvpBonusToastTimer);
  stopPvpTicker();
  stopPvpCountdownTicker();
  const banner = $('pvp-challenge-banner');
  if (banner) banner.style.display = 'none';
}

function handlePvpMatchesUpdate() {
  if (!state.currentUser) return;
  const all = Object.values(pvpMatchesById);
  const myUid = state.currentUser.uid;

  // desafio recebido (alguém me desafiou, ainda não respondi)
  const incoming = all.find(m => m.status === 'pending' && m.challengerUid !== myUid);
  renderPvpChallengeBanner(incoming);

  // partida ativa em que eu participo — se eu ainda não estiver vendo ela e
  // não estiver no meio de um jogo solo/tutorial (pra não interromper uma
  // partida em andamento), abre a tela de duelo sozinho
  const active = all.find(m => m.status === 'active' || m.status === 'starting');
  const safeToInterrupt = ['menu-screen', 'friends-screen', 'ranking-screen', 'pvp-screen'].some(id => $(id).classList.contains('active'));
  if (active && safeToInterrupt && pvpCurrentMatchId !== active.id) {
    openPvpScreen(active.id);
  }

  // mantém a tela de duelo aberta sempre sincronizada com o próprio match
  if (pvpCurrentMatchId && pvpMatchesById[pvpCurrentMatchId]) {
    renderPvpScreen(pvpMatchesById[pvpCurrentMatchId]);
  }
}

function renderPvpChallengeBanner(m) {
  const box = $('pvp-challenge-banner');
  if (!box) return;
  if (!m) { box.style.display = 'none'; box.dataset.matchId = ''; return; }
  const fromNick = (m.nicks && m.nicks[m.challengerUid]) || '';
  box.style.display = '';
  box.dataset.matchId = m.id;
  // "|| 'classic'" cobre duelos criados antes desse campo existir (sem
  // mode salvo) — era sempre esse o comportamento de qualquer forma
  $('pvp-challenge-text').textContent = T[state.lang].pvp_challenge_received(fromNick, modeLabel(m.mode || 'classic'));
}

window.uiAcceptChallenge = async () => {
  const matchId = $('pvp-challenge-banner').dataset.matchId;
  if (!matchId) return;
  if (blockIfBanned()) return; // conta suspensa não joga nenhum modo
  $('pvp-challenge-banner').style.display = 'none';
  try {
    await callRespondChallenge({ matchId, accept: true });
    openPvpScreen(matchId);
  } catch {}
};

window.uiDeclineChallenge = async () => {
  const matchId = $('pvp-challenge-banner').dataset.matchId;
  if (!matchId) return;
  $('pvp-challenge-banner').style.display = 'none';
  try { await callRespondChallenge({ matchId, accept: false }); } catch {}
};

// popup de escolha de modo do duelo, aberta ao clicar em "desafiar" na tela
// de amigos (ver friendRow em js/friends.js) — só mostra os modos que os
// DOIS jogadores já desbloquearam (ex.: alguém level 30 desafiando um level
// 1 só vê Clássico, único modo que o nível 1 ainda tem). "classic" nunca tem
// entrada em MODE_UNLOCK, então está sempre disponível pros dois — a lista
// nunca fica vazia. O servidor reconfere tudo de novo em challengeFriend,
// isso aqui é só pra não nem oferecer uma opção que ia ser recusada.
window.openChallengeModeModal = (toUid, nick, theirXp, theirAdmin) => {
  if (blockIfBanned()) return; // conta suspensa não joga nenhum modo
  $('challenge-mode-title').textContent = T[state.lang].challenge_mode_title(nick);
  const myAdmin = state.myData.admin === true;
  const body = $('challenge-mode-body');
  body.innerHTML = '';
  ALL_MODES.forEach(m => {
    if (!modeUnlockedForXp(m, myXp(), myAdmin) || !modeUnlockedForXp(m, theirXp, theirAdmin === true)) return;
    const btn = document.createElement('button');
    btn.textContent = `${MODE_ICON[m]} ${modeLabel(m)}`;
    btn.onclick = () => sendChallenge(toUid, m);
    body.appendChild(btn);
  });
  $('challenge-mode-modal').style.display = 'flex';
};
window.closeChallengeModeModal = () => {
  $('challenge-mode-modal').style.display = 'none';
};
async function sendChallenge(toUid, mode) {
  closeChallengeModeModal();
  try {
    const res = await callChallengeFriend({ toUid, mode });
    const data = res.data || {};
    if (data.matchId) { openPvpScreen(data.matchId); return; }
  } catch {}
  showFriendActionError(); // "já existe um desafio" ou erro genérico — mesmo aviso da tela de amigos
}

window.uiCancelChallenge = async () => {
  if (!pvpCurrentMatchId) return;
  try { await callCancelChallenge({ matchId: pvpCurrentMatchId }); } catch {}
  pvpBackToMenu();
};

window.uiForfeitMatch = async () => {
  if (!pvpCurrentMatchId) return;
  try { await callForfeitMatch({ matchId: pvpCurrentMatchId }); } catch {}
  // não navega ainda — o onSnapshot traz o status 'finished' e a tela mostra o resultado sozinha
};

window.uiSubmitPvpAnswer = async (squareIndex) => {
  if (!pvpCurrentMatchId) return;
  // desabilita o grid na hora, pra não dar pra clicar duas vezes enquanto espera o servidor
  Array.from($('pvp-grid').children).forEach(el => { el.onclick = null; el.style.opacity = '0.5'; });
  try {
    await callSubmitPvpAnswer({ matchId: pvpCurrentMatchId, squareIndex });
  } catch {}
  // o resultado de verdade vem pelo onSnapshot, não por essa resposta
};

window.pvpBackToMenu = () => {
  pvpCurrentMatchId = null;
  stopPvpTicker();
  window.showMenu();
};

function openPvpScreen(matchId) {
  pvpCurrentMatchId = matchId;
  pvpLastBonusAt = null;      // partida nova (ou reaberta) — ainda não mostramos nenhum aviso de bônus dela
  pvpLastAttemptAt = null;    // idem pro som — evita tocar som de uma tentativa antiga ao reabrir a tela
  pvpResultSoundPlayed = false; // idem pro som de vitória/derrota/empate
  show('pvp-screen');
  const m = pvpMatchesById[matchId];
  if (m) renderPvpScreen(m);
}

// toca o som de acerto/erro/tempo esgotado assim que uma tentativa nova é
// resolvida no servidor (ver lastAttempt) — os dois jogadores ouvem o mesmo
// som no mesmo instante, sincronizados pelo próprio documento da partida,
// não por cada cliente decidindo sozinho o que aconteceu. sfx vem de
// game-teste.js (ainda não é um módulo próprio — fase futura), exposta lá só
// pra essa ponte
function checkPvpAttemptSound(m) {
  const la = m.lastAttempt;
  if (!la || !la.at) return;
  const at = la.at.toMillis();
  if (at === pvpLastAttemptAt) return;
  pvpLastAttemptAt = at;
  if (la.success) window.sfx.correct(0);
  else if (la.reason === 'timeout') window.sfx.timeout();
  else window.sfx.wrong();
}

function renderPvpScreen(m) {
  checkPvpAttemptSound(m);
  const myUid = state.currentUser.uid;
  const oppUid = m.players.find(p => p !== myUid);

  $('pvp-waiting').style.display = 'none';
  $('pvp-countdown').style.display = 'none';
  $('pvp-active').style.display = 'none';
  $('pvp-result').style.display = 'none';

  if (m.status === 'pending') {
    stopPvpTicker();
    stopPvpCountdownTicker();
    $('pvp-waiting').style.display = '';
    $('pvp-waiting-text').textContent = T[state.lang].pvp_waiting_text((m.nicks && m.nicks[oppUid]) || '', modeLabel(m.mode || 'classic'));
    return;
  }

  if (m.status === 'starting') {
    stopPvpTicker();
    $('pvp-countdown').style.display = '';
    if (!pvpCountdownAnimFrame) startPvpCountdownTicker();
    return;
  }

  if (m.status === 'active') {
    stopPvpCountdownTicker();
    $('pvp-active').style.display = 'flex';
    setPvpNameWithLevel($('pvp-my-name'), T[state.lang].pvp_you_label((m.nicks && m.nicks[myUid]) || ''), myXp(), equippedAvatar);
    setPvpNameWithLevel($('pvp-opp-name'), (m.nicks && m.nicks[oppUid]) || '', getPvpOppXp(oppUid), getPvpOppEquipped(oppUid).avatar);
    $('pvp-turn-label').textContent = (m.turnUid === myUid) ? T[state.lang].pvp_your_turn : T[state.lang].pvp_opp_turn((m.nicks && m.nicks[oppUid]) || '');
    checkPvpBonusToast(m);
    renderPvpBoard(m, myUid);
    if (!pvpAnimFrame) startPvpTicker();
    return;
  }

  // finished / declined / cancelled / draw
  stopPvpTicker();
  stopPvpCountdownTicker();
  $('pvp-result').style.display = '';
  renderPvpResult(m, myUid, oppUid);
}

// mostra rapidamente "+5 segundos adicionados" quando o servidor concede o
// bônus de desempate (os dois falharam no mesmo ciclo) — overtimeBonusAt só
// muda de valor quando isso realmente acontece de novo, então comparar com
// o último valor já visto evita mostrar o aviso repetido à toa
function checkPvpBonusToast(m) {
  if (!m.overtimeBonusAt) return;
  const at = m.overtimeBonusAt.toMillis();
  if (at === pvpLastBonusAt) return;
  pvpLastBonusAt = at;
  const el = $('pvp-bonus-toast');
  if (!el) return;
  el.style.display = '';
  clearTimeout(pvpBonusToastTimer);
  pvpBonusToastTimer = setTimeout(() => { el.style.display = 'none'; }, 2800);
}

// caixa de prompt acima da grade — mostra o que a pessoa precisa achar. Pra
// clássico/reverso é uma cor (o retângulo colorido é só decoração, o que
// vale é a palavra); pra formas/formas reverso é o nome da forma-alvo; pra
// trio/caos são as DUAS informações a memorizar (ver generatePvpTrioRound/
// generatePvpCaosRound em functions/index.js) — diferente do modo solo, aqui
// elas ficam sempre visíveis (não precisa decorar sem lembrete), pra caber
// no ritmo mais rápido e simultâneo do duelo.
function renderPvpPromptBox(mode, round) {
  const box = $('pvp-prompt-box');
  if (mode === 'trio' || mode === 'caos') {
    const pool = mode === 'trio' ? COLORS : CAOS_POOL;
    const itemA = pool[round.pairA] || pool[0], itemB = pool[round.pairB] || pool[0];
    box.textContent = T[state.lang].pvp_pair_prompt(cName(itemA), cName(itemB));
    box.style.background = 'linear-gradient(135deg, var(--bg-panel-2), var(--bg-panel))';
    box.style.boxShadow = 'inset 0 0 14px rgba(255,255,255,0.08)';
    return;
  }
  if (mode === 'shapes' || mode === 'shapes-reverse') {
    const targetShape = SHAPES[round.promptShapeIdx] || SHAPES[0];
    box.textContent = cName(targetShape);
    box.style.background = 'linear-gradient(135deg, var(--bg-panel-2), var(--bg-panel))';
    box.style.boxShadow = 'inset 0 0 14px rgba(255,255,255,0.08)';
    return;
  }
  // clássico/reverso/mosaico: a cor do RETÂNGULO é só distração — o que vale
  // é a cor que a PALAVRA diz. Mosaico usa a paleta de 12 cores (COLORS_12)
  // em vez das 8 normais (ver generatePvpMosaicRound em functions/index.js)
  const pool = (mode === 'mosaic') ? COLORS_12 : COLORS;
  const boxColor = pool[round.promptColorIdx] || pool[0];
  const targetColor = pool[round.promptWordIdx] || pool[0];
  box.textContent = cName(targetColor); // conteúdo fixo (tabela COLORS/COLORS_12), sem dado de usuário
  box.style.background = boxColor.hex;
  box.style.boxShadow = `0 0 18px ${boxColor.hex}99, 0 0 40px ${boxColor.hex}55, inset 0 0 14px rgba(255,255,255,0.15)`;
}
// desenha um quadrado da grade de acordo com a mecânica do modo do duelo —
// espelha exatamente a lógica do modo solo equivalente (newRound/
// newTrioRound/newCaosRound em js/game-core.js), só que a partir dos ÍNDICES
// que o servidor manda (ver generatePvpColorRound/generatePvpShapeRound/
// generatePvpTrioRound/generatePvpCaosRound em functions/index.js) em vez de
// sortear no cliente — quem decide o que é certo continua sendo sempre o
// servidor (ver submitPvpAnswer/isPvpAnswerCorrect lá).
function renderPvpSquare(el, mode, sq) {
  if (mode === 'shapes' || mode === 'shapes-reverse') {
    const shapeSide = SHAPES[sq.shapeIdx] || SHAPES[0];
    const wordSide = SHAPES[sq.wordIdx] || SHAPES[0];
    el.className = `square shape-square ${shapeSide.shapeClass}`;
    el.innerHTML = `<span class="shape-fill ${shapeSide.shapeClass}"></span><span class="word">${cName(wordSide)}</span>`;
    return;
  }
  if (mode === 'trio') {
    el.className = 'square';
    renderTrioSquare(el, { bg: COLORS[sq.bg] || COLORS[0], tc: COLORS[sq.tc] || COLORS[0], word: COLORS[sq.word] || COLORS[0] });
    return;
  }
  if (mode === 'caos') {
    renderCaosSquare(el, { shape: CAOS_POOL[sq.shape] || CAOS_POOL[0], color: CAOS_POOL[sq.color] || CAOS_POOL[0], word: CAOS_POOL[sq.word] || CAOS_POOL[0] });
    return;
  }
  // clássico/reverso/mosaico (Mosaico usa a paleta de 12 cores, COLORS_12)
  const pool = (mode === 'mosaic') ? COLORS_12 : COLORS;
  const bg = pool[sq.bgIdx] || pool[0];
  const word = pool[sq.wordIdx] || pool[0];
  el.className = 'square';
  el.style.background = bg.hex;
  el.style.boxShadow = `0 0 18px ${bg.hex}99, 0 0 40px ${bg.hex}55, inset 0 0 20px rgba(255,255,255,0.12)`;
  el.innerHTML = `<span class="word">${cName(word)}</span>`; // conteúdo fixo (tabelas COLORS/COLORS_12/SHAPES/CAOS_POOL), sem dado de usuário
}
function renderPvpBoard(m, myUid) {
  const round = m.round;
  if (!round) return;
  const mode = m.mode || 'classic'; // duelos criados antes desse campo existir eram sempre esse comportamento
  renderPvpPromptBox(mode, round);
  // instrução muda de acordo com a mecânica do modo (ver pvp_explain em
  // js/i18n.js) — não usa mais data-i18n-html porque agora é uma função,
  // não um texto fixo
  $('pvp-explain').innerHTML = T[state.lang].pvp_explain(mode);

  const myTurn = m.turnUid === myUid;
  const grid = $('pvp-grid');
  grid.classList.toggle('grid-3x3', mode === 'mosaic'); // ver mesmo toggle em window.startGame (js/game-core.js)
  grid.innerHTML = '';
  round.squares.forEach((sq, i) => {
    const el = document.createElement('div');
    renderPvpSquare(el, mode, sq);
    if (myTurn) {
      el.onclick = () => uiSubmitPvpAnswer(i);
    } else {
      el.style.cursor = 'default';
      el.style.opacity = '0.75';
    }
    grid.appendChild(el);
  });
}

// toca o som de vitória/derrota/empate uma única vez por partida (o
// resultado pode ser renderizado de novo por outros motivos — ex: reabrir a
// tela — e não queremos repetir o som toda vez)
function playPvpResultSound(kind) {
  if (pvpResultSoundPlayed) return;
  pvpResultSoundPlayed = true;
  if (kind === 'win') window.sfx.pvpWin();
  else if (kind === 'lose') window.sfx.pvpLose();
  else window.sfx.pvpDraw();
  // o servidor já incrementou pvpWins/pvpLosses/pvpDraws em scores/{uid} (ver
  // applyPvpResultStats em functions/index.js), mas state.myData só
  // é buscado de novo no próximo login (proceedAfterLogin) — sem espelhar
  // aqui, a medalha "Vitórias em Duelo" (BADGE_DEFS.pvp em js/badges.js) e a
  // bolinha de "medalha nova" só refletiam o duelo depois de sair/entrar de
  // novo no jogo. Reaproveita o mesmo guard de pvpResultSoundPlayed acima —
  // roda uma única vez por partida.
  const field = kind === 'win' ? 'pvpWins' : kind === 'lose' ? 'pvpLosses' : 'pvpDraws';
  state.myData[field] = (state.myData[field] || 0) + 1;
  refreshBadgeNotifDot();
}

function renderPvpResult(m, myUid, oppUid) {
  const titleEl = $('pvp-result-title');
  const subEl = $('pvp-result-sub');
  const playersEl = $('pvp-result-players');
  const roundsEl = $('pvp-result-rounds');
  const oppNick = (m.nicks && m.nicks[oppUid]) || '';
  const myNick = (m.nicks && m.nicks[myUid]) || '';
  playersEl.innerHTML = '';
  roundsEl.textContent = '';

  if (m.status === 'declined') {
    titleEl.textContent = T[state.lang].pvp_declined_title;
    subEl.textContent = '';
    return;
  }
  if (m.status === 'cancelled') {
    titleEl.textContent = T[state.lang].pvp_cancelled_title;
    subEl.textContent = '';
    return;
  }
  if (m.status === 'draw') {
    playPvpResultSound('draw');
    titleEl.textContent = T[state.lang].pvp_draw_title;
    subEl.textContent = T[state.lang].pvp_draw_sub;
    const finalBank = m.finalBank || m.bank || {};
    playersEl.appendChild(pvpPlayerRow(myNick, finalBank[myUid] || 0, null));
    playersEl.appendChild(pvpPlayerRow(oppNick, finalBank[oppUid] || 0, null));
    roundsEl.textContent = T[state.lang].pvp_rounds_played(m.cycleNumber || 1);
    return;
  }

  const won = m.winnerUid === myUid;
  playPvpResultSound(won ? 'win' : 'lose');
  titleEl.textContent = won ? T[state.lang].pvp_win_title : T[state.lang].pvp_lose_title;
  const reasonFn = { timeout: T[state.lang].pvp_reason_timeout, wrong_click: T[state.lang].pvp_reason_wrong, forfeit: T[state.lang].pvp_reason_forfeit }[m.loseReason];
  subEl.textContent = reasonFn ? reasonFn(won, oppNick) : '';

  // placar final: os dois participantes, com quanto tempo sobrou no banco
  // de cada um no instante em que o duelo acabou (ver finalBank no servidor)
  const finalBank = m.finalBank || m.bank || {};
  const winnerNick = (m.winnerUid === myUid) ? myNick : oppNick;
  const loserNick = (m.loseUid === myUid) ? myNick : oppNick;
  playersEl.appendChild(pvpPlayerRow(winnerNick, finalBank[m.winnerUid] || 0, true));
  playersEl.appendChild(pvpPlayerRow(loserNick, finalBank[m.loseUid] || 0, false));

  roundsEl.textContent = T[state.lang].pvp_rounds_played(m.cycleNumber || 1);
}

// linha do placar final — nick sempre via textContent (nunca innerHTML),
// mesmo cuidado de sempre com dado de jogador. isWinner: true (venceu),
// false (perdeu) ou null (empate — estilo neutro, sem cor de vitória/derrota)
function pvpPlayerRow(nick, remainingMs, isWinner) {
  const row = document.createElement('div');
  const bg = isWinner === null ? 'rgba(255,255,255,0.06)' : (isWinner ? 'rgba(33,230,161,0.12)' : 'rgba(255,45,107,0.10)');
  const border = isWinner === null ? 'rgba(255,255,255,0.18)' : (isWinner ? 'rgba(33,230,161,0.4)' : 'rgba(255,45,107,0.35)');
  row.style.cssText = `display:flex; justify-content:space-between; align-items:center; padding:10px 14px; border-radius:10px; background:${bg}; border:1px solid ${border};`;

  const left = document.createElement('span');
  left.style.cssText = "display:flex; align-items:center; gap:8px; font-family:'Orbitron',sans-serif; font-weight:700;";
  const icon = document.createElement('span');
  icon.textContent = isWinner === null ? '🤝' : (isWinner ? '🏆' : '💀');
  left.appendChild(icon);
  const nickSpan = document.createElement('span');
  nickSpan.textContent = nick;
  if (isWinner === true) nickSpan.classList.add('pvp-winner-nick');
  left.appendChild(nickSpan);
  row.appendChild(left);

  const timeSpan = document.createElement('span');
  timeSpan.style.cssText = "font-family:'Orbitron',sans-serif; font-weight:800; color:#fff;";
  timeSpan.textContent = (remainingMs / 1000).toFixed(1) + 's';
  row.appendChild(timeSpan);

  return row;
}

function startPvpTicker() {
  stopPvpTicker();
  pvpClaimedForTurn = null;
  function tick() {
    const cur = pvpMatchesById[pvpCurrentMatchId];
    if (!cur || cur.status !== 'active') { pvpAnimFrame = null; return; }
    renderPvpBars(cur);
    pvpAnimFrame = requestAnimationFrame(tick);
  }
  tick();
}
function stopPvpTicker() {
  if (pvpAnimFrame) cancelAnimationFrame(pvpAnimFrame);
  pvpAnimFrame = null;
}

// contagem "3, 2, 1" mostrada assim que o desafio é aceito, antes do
// cronômetro de verdade ligar (o servidor só começa a descontar tempo depois
// desse período — ver countdownStartedAt/PVP_COUNTDOWN_MS em respondChallenge)
function startPvpCountdownTicker() {
  stopPvpCountdownTicker();
  pvpCountdownLastNum = null;
  function tick() {
    const cur = pvpMatchesById[pvpCurrentMatchId];
    if (!cur || cur.status !== 'starting') { pvpCountdownAnimFrame = null; return; }
    renderPvpCountdown(cur);
    pvpCountdownAnimFrame = requestAnimationFrame(tick);
  }
  tick();
}
function stopPvpCountdownTicker() {
  if (pvpCountdownAnimFrame) cancelAnimationFrame(pvpCountdownAnimFrame);
  pvpCountdownAnimFrame = null;
}
function renderPvpCountdown(m) {
  const startedMs = m.countdownStartedAt ? m.countdownStartedAt.toMillis() : Date.now();
  const elapsed = Math.max(0, (Date.now() - pvpClockOffsetMs) - startedMs);
  const remaining = PVP_COUNTDOWN_MS - elapsed;
  const num = Math.max(1, Math.ceil(remaining / 1000));

  if (remaining <= 0) {
    $('pvp-countdown-num').textContent = T[state.lang].pvp_go;
    if (pvpCountdownLastNum !== 'go') { pvpCountdownLastNum = 'go'; window.sfx.countdown(true); }
  } else {
    $('pvp-countdown-num').textContent = String(num);
    if (pvpCountdownLastNum !== num) { pvpCountdownLastNum = num; window.sfx.countdown(false); }
  }
}

function renderPvpBars(m) {
  const myUid = state.currentUser.uid;
  const oppUid = m.players.find(p => p !== myUid);
  const turnStartedMs = m.turnStartedAt ? m.turnStartedAt.toMillis() : Date.now();
  const elapsed = Math.max(0, (Date.now() - pvpClockOffsetMs) - turnStartedMs);

  const myBank = (m.bank && m.bank[myUid]) || 0;
  const oppBank = (m.bank && m.bank[oppUid]) || 0;
  const myRemaining = (m.turnUid === myUid) ? Math.max(0, myBank - elapsed) : myBank;
  const oppRemaining = (m.turnUid === oppUid) ? Math.max(0, oppBank - elapsed) : oppBank;

  // depois de ciclos com bônus de +5s, o banco pode passar de 10s — a barra
  // usa o maior valor em jogo como referência, senão ficaria sempre "cheia"
  const maxBank = Math.max(PVP_TURN_BANK_MS, myBank, oppBank);

  $('pvp-my-bar').style.width = Math.max(0, Math.min(100, myRemaining / maxBank * 100)) + '%';
  $('pvp-opp-bar').style.width = Math.max(0, Math.min(100, oppRemaining / maxBank * 100)) + '%';
  $('pvp-my-time').textContent = (myRemaining / 1000).toFixed(1) + 's';
  $('pvp-opp-time').textContent = (oppRemaining / 1000).toFixed(1) + 's';

  // ninguém autodeclara "acabou o tempo" — só pede pro servidor conferir de
  // novo com o próprio relógio dele (claimTimeout) antes de aceitar. Usa o
  // instante em que a tentativa atual começou como identidade (cada
  // tentativa tem um turnStartedAt novo), pra não repetir a reivindicação
  // várias vezes seguidas pra mesma tentativa.
  if (pvpClaimedForTurn !== turnStartedMs && (myRemaining <= 0 || oppRemaining <= 0)) {
    pvpClaimedForTurn = turnStartedMs;
    // se o servidor recusar (relógio dele ainda não concorda que acabou —
    // possível defasagem entre o relógio do navegador e o do servidor),
    // libera pra tentar de novo no próximo tick em vez de travar pra sempre
    callClaimTimeout({ matchId: m.id }).catch(() => { pvpClaimedForTurn = null; });
  }
}
