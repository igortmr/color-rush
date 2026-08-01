import {
  onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, GoogleAuthProvider, OAuthProvider, signInWithPopup,
  signInWithCredential, signOut, sendEmailVerification
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  doc, getDoc, setDoc, collection, query, orderBy, limit, getDocs,
  serverTimestamp, writeBatch, where, onSnapshot, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { app, auth, db, functions, callable } from './firebase.js';
import {
  COLORS, CONFETTI_COLORS, SQUARES, SHAPES, poolFor, CAOS_POOL, isColorItem,
  poolItemId, poolItemById, PLAYED_FIELD, ALL_MODES, DAILY_ROTATION_MODES,
  DAILY_COLORS, DAILY_PALETTE_OVERRIDE, DAILY_MAX_ATTEMPTS
} from './constants.js';
import {
  shuffle, pick, mulberry32, hashSeed, seededPick, seededShuffle,
  getLocalRecord, setLocalRecord, isMuted, setMuted, audioContext, tone,
  playCorrectSfxVariant, track
} from './utils.js';
import { $ } from './dom.js';
import { state } from './state.js';
import {
  show, resetScroll, pushScreenAndShow, popScreenBack, resetScreenBackStack
} from './nav.js';
import { T, cName } from './i18n.js';
import {
  MODE_UNLOCK, levelFromXp, lvChip, applyNickFrame, applyRowTheme, avatarSvg,
  avatarOrDefaultIcon, pigmentIconSvg, renderDailyPrizesLegend, modeLabel,
  xpInfo, xpStreakMultiplier, totalXpForLevel, myXp, modeUnlocked, isBanned,
  blockIfBanned
} from './levels.js';
import {
  TIER_COLORS, BADGE_DEFS, BADGE_ORDER, unlockedTier, badgePillHtml,
  equippedBadgeLabel, sharerTierLabel, hasNewBadgeFor, newBadgeCountFor,
  hasAnyNewBadge, totalNewBadgeCount, markAllBadgesSeen, refreshBadgeNotifDot
} from './badges.js';
import { tutMode, tutStep, showTutStep } from './tutorial.js';
import {
  fetchAllScores, rowData, compareRankRows, invalidateScoresCache
} from './ranking-cache.js';
import { RANK_FIELDS } from './ranking.js';
import {
  openProfileFromRanking, computeModeRanks, renderPublicProfileBadges,
  renderPublicProfileRanks, profileSectionLabel
} from './profile-public.js';
import {
  fetchMyFriendRequests, showFriendActionError
} from './friends.js';
import { submitPendingScore } from './profile.js';
import { saveMatchReplayWithRetry, renderTrioSquare, renderCaosSquare } from './replay.js';
import {
  equippedSfx, equippedConfetti, equippedAvatar, applyEquippedCosmetics,
  renderMenuPigmentosBar, renderUserPigmentos
} from './shop.js';
import { startPvpListener, stopPvpListener } from './pvp.js';

// chamadas ao servidor: a pontuação final agora é validada lá,
// não é mais um simples write direto no Firestore vindo do navegador.
const callStartSession = callable('startGameSession');
const callSubmitResult = callable('submitGameResult');
const callCreditReferral = callable('creditReferral');
const callSuggestFriendFromRef = callable('suggestFriendFromRef');
const callRecomputeTotal = callable('recomputeMyTotal');
const callDeleteMyAccount = callable('deleteMyAccount');
// troca o authorization code do login com Apple por um refresh token que o
// servidor guarda pra poder revogar na exclusão de conta (exigência da Apple,
// ver doApple/registerAppleAuthCode mais abaixo e functions/index.js)
const callRegisterAppleAuthCode = httpsCallable(functions, 'registerAppleAuthCode');
const callTouchActivity = httpsCallable(functions, 'touchActivity'); // batimento automático — não conta pro travamento de clique
// chamada "dispare e esqueça" a cada acerto, igual ao touchActivity acima:
// roda em segundo plano, não passa pelo wrapper callable() de propósito
// (senão uma sequência rápida de acertos deixaria pendingServerCalls sempre
// positivo, travando outros cliques da interface à toa). O jogo continua
// 100% local e instantâneo.
const callSyncProgress = httpsCallable(functions, 'syncRoundProgress');
// recarimba o início real da tentativa do desafio diário pro instante em que
// a contagem "3, 2, 1, Vai!" termina e o tabuleiro libera de vez — mesmo
// padrão "dispare e esqueça" acima, não passa pelo wrapper callable() pelo
// mesmo motivo.
const callArmDailySession = httpsCallable(functions, 'armDailySession');
// desafio diário — mesmo esquema de sessão/validação de tempo do modo normal
// (ver startDailyAttempt/submitDailyResult em functions/index.js)
const callStartDailyAttempt = callable('startDailyAttempt');
const callSubmitDailyResult = callable('submitDailyResult');
const callClaimDailyReward = callable('claimDailyReward');

/* ================== idioma ================== */
// detecção inicial (URL/localStorage) agora mora em js/state.js, já que o
// idioma é lido por quase toda função de renderização em vários módulos
auth.languageCode = (state.lang === 'en' || state.lang === 'es') ? state.lang : 'pt'; // e-mails do Firebase (verificação etc.) saem no idioma do jogo

function applyLanguage() {
  const dict = T[state.lang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key] != null) el.textContent = dict[key];
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    if (dict[key] != null) el.innerHTML = dict[key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (dict[key] != null) el.placeholder = dict[key];
  });
  document.documentElement.lang = (state.lang === 'en') ? 'en' : (state.lang === 'es') ? 'es' : 'pt-BR';
  $('lang-select').value = state.lang;

  // re-renderiza a tela dinâmica que já estava aberta, se aplicável
  if ($('menu-screen').classList.contains('active')) showMenu();
  if ($('profile-screen').classList.contains('active')) renderProfile();
  if ($('ranking-screen').classList.contains('active')) window.loadRanking(window.getRankingTab() || 'geral');
  if ($('tutorial-screen').classList.contains('active')) {
    $('tut-title-el').textContent = T[state.lang].tut_title[tutMode];
    showTutStep(tutStep);
  }
}

window.setLang = (l) => {
  state.lang = l;
  try { localStorage.setItem('colorRushLang', l); } catch {}
  auth.languageCode = (l === 'en' || l === 'es') ? l : 'pt';
  // reflete o idioma na URL da barra de endereço (sem recarregar a página), pra
  // quem copiar o link diretamente dali — não só pelo botão de compartilhar — já
  // levar o idioma junto. Mantém outros parâmetros existentes (ex.: ?ref=)
  try {
    const params = new URLSearchParams(location.search);
    if (l === 'pt') params.delete('state.lang'); else params.set('state.lang', l);
    const qs = params.toString();
    const newUrl = location.pathname + (qs ? `?${qs}` : '') + location.hash;
    history.replaceState(null, '', newUrl);
  } catch {}
  applyLanguage();
};

/* ================== versão (commit real do GitHub) + auto-atualização ================== */
let loadedSha = null;
async function fetchLatestSha() {
  const res = await fetch('https://api.github.com/repos/igortmr/color-rush/commits?path=index.html&per_page=1');
  const data = await res.json();
  return (data && data[0]) ? data[0].sha : null;
}
(async () => {
  const el = document.getElementById('version-tag');
  try {
    loadedSha = await fetchLatestSha();
    el.textContent = loadedSha ? `#${loadedSha.slice(0, 7)}` : '';
  } catch {
    el.textContent = '';
  }
})();

// confere se o client está na versão mais nova antes de liberar o desafio
// diário — o desafio precisa que todo mundo rode a MESMA lógica (paleta de
// cores do dia, modo sorteado, RNG determinística etc. — ver DAILY_COLORS/
// dailyModeForToday), então uma versão desatualizada pode mostrar um desafio
// diferente do que o servidor espera. Fail-open: se não der pra confirmar
// (1ª busca do load ainda não terminou, ou a requisição falha agora), deixa
// jogar — só barra quando dá pra confirmar de verdade que saiu versão nova.
async function isDailyClientUpToDate() {
  try {
    const sha = await fetchLatestSha();
    if (!sha || !loadedSha) return true;
    return sha === loadedSha;
  } catch {
    return true;
  }
}

// se sair versão nova no GitHub, recarrega sozinho — mas nunca no meio de uma partida
async function checkForUpdate() {
  if (playing || document.hidden) return;
  try {
    const sha = await fetchLatestSha();
    if (!sha) return;
    if (!loadedSha) { loadedSha = sha; return; } // primeira busca falhou no load; só registra
    if (sha !== loadedSha) {
      document.getElementById('version-tag').textContent = '🔄 atualizando...';
      // ?v= força o navegador a buscar o HTML novo em vez do cache
      setTimeout(() => location.replace(`${location.pathname}?v=${sha.slice(0, 7)}`), 1000);
    }
  } catch {}
}
setInterval(checkForUpdate, 5 * 60 * 1000); // a cada 5 minutos
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });

/* ================== indicação (referral) ================== */
// captura ?ref=<código curto> da URL de compartilhamento e guarda até o cadastro terminar
let referrerCode = new URLSearchParams(location.search).get('ref') || null;
if (referrerCode) {
  try { sessionStorage.setItem('colorRushRef', referrerCode); } catch {}
} else {
  try { referrerCode = sessionStorage.getItem('colorRushRef'); } catch {}
}
if (location.search) history.replaceState({}, '', location.pathname); // limpa ?ref= / ?v= da URL visível

const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I/L, pra não confundir
async function generateUniqueRefCode() {
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += REF_CHARS[Math.floor(Math.random() * REF_CHARS.length)];
    const snap = await getDoc(doc(db, 'refcodes', code));
    if (!snap.exists()) return code;
  }
  return Math.random().toString(36).slice(2, 8).toUpperCase(); // fallback improvável
}
async function ensureRefCode() {
  if (state.myData.refCode) return state.myData.refCode;
  try {
    const code = await generateUniqueRefCode();
    await setDoc(doc(db, 'refcodes', code), { uid: state.currentUser.uid });
    await setDoc(doc(db, 'scores', state.currentUser.uid), { refCode: code, updatedAt: serverTimestamp() }, { merge: true });
    state.myData.refCode = code;
  } catch {}
  return state.myData.refCode;
}

/* ================== state ================== */
// confete cosmético da loja ao bater um novo recorde — camada leve (sem
// biblioteca), some sozinha depois da animação. "confettiId" explícito permite
// reusar a mesma função tanto pro confete realmente equipado quanto pra prévia
// da loja (que precisa funcionar mesmo sem nada equipado ainda).
function spawnConfettiVariant(confettiId) {
  if (!confettiId) return;
  const colors = CONFETTI_COLORS[confettiId] || ['#ffd700'];
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  for (let i = 0; i < 28; i++) {
    const bit = document.createElement('span');
    bit.className = 'confetti-bit';
    bit.style.left = Math.random() * 100 + '%';
    bit.style.background = colors[i % colors.length];
    bit.style.animationDelay = (Math.random() * 0.5) + 's';
    bit.style.animationDuration = (1.6 + Math.random() * 0.9) + 's';
    bit.style.setProperty('--drift', Math.round(Math.random() * 70 - 35) + 'px');
    layer.appendChild(bit);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 2800);
}
// exposta em window pra js/shop.js poder disparar a mesma animação na prévia
// do item "confete", sem esperar os efeitos visuais ganharem seu próprio
// módulo (fase futura)
window.spawnConfettiVariant = spawnConfettiVariant;
function spawnConfetti() { spawnConfettiVariant(equippedConfetti); }

// mesma ideia de poolFor, mas pro desafio diário: Clássico/Reverso usam a
// paleta estendida (DAILY_COLORS, ou o override do dia — ver
// DAILY_PALETTE_OVERRIDE acima); qualquer outro valor cai no poolFor normal
// (dead code hoje, já que DAILY_ROTATION_MODES só tem esses 2, mas mantém a
// função segura se um modo de forma voltar a entrar no sorteio um dia)
const dailyPoolFor = m => (m === 'classic' || m === 'reverse')
  ? (DAILY_PALETTE_OVERRIDE[dailyLocalDateStr()] || DAILY_COLORS)
  : poolFor(m);
// Geral = soma dos recordes em TODOS os modos (conta 0 pro modo ainda não jogado)
const computeTotal = (overrideMode, overrideScore) =>
  ALL_MODES.reduce((sum, k) => sum + (k === overrideMode ? overrideScore : (state.myData[k] || 0)), 0);

/* ================== conquistas (badges) ================== */
// pill com ícone + nome da ÚNICA medalha escolhida pra aparecer ao lado do
// nick no ranking (ver setEquippedBadgeTier, no perfil próprio). Sem escolha
// feita ainda, não mostra nada — só passa a exibir depois que a própria
// pessoa vai no perfil e equipa uma. Sempre reconfere unlockedTier() contra
// as stats REAIS, então forjar equippedBadge/equippedBadgeTier não mostra
// nada que a pessoa não tenha de verdade — equippedBadgeTier escolhe QUAL
// nível já desbloqueado aparece (não precisa ser o mais alto: alguém que já
// tem "Imortal" pode preferir mostrar "Lenda"), null cai no comportamento
// antigo (sempre o mais alto).
// pill exata que aparece no ranking pra um nível de uma categoria — extraída
// à parte pra poder reusar a MESMA marcação como prévia no perfil (ver
// renderBadgeCard), assim a pessoa vê exatamente como vai aparecer antes de
// equipar.
function todayStr() { return new Date().toLocaleDateString('sv-SE'); } // YYYY-MM-DD local

let mode, score, target, nextTarget, duration, timerStart, rafId, playing;
// estado do modo Trio (ver newTrioRound/handleTrioClick): trioColorA/trioColorB
// são as 2 cores ATIVAS (o par que a pessoa precisa achar nesta rodada — ou
// já decorado na rodada anterior, ou sorteado do zero na primeira rodada).
// trioNextPairA/trioNextPairB são os 2 novos valores (tirados dos atributos
// que NÃO deram o match no quadrado certo desta rodada) que virão a ser o
// próximo par assim que o clique certo acontecer (ver handleTrioClick)
let trioColorA, trioColorB, trioNextPairA, trioNextPairB;
// estado do modo Caos (ver newCaosRound/handleCaosClick): mesma ideia do Trio
// acima, só que os itens podem ser cor OU forma (CAOS_POOL) em vez de só cor
let caosItemA, caosItemB, caosNextPairA, caosNextPairB;
let xpGain = 0; // XP acumulada na partida atual
// promessas dos sinais de progresso (ver callSyncProgress) desta
// partida — gameOver() espera todas "assentarem" no servidor antes de
// mandar o resultado final, senão o envio pode chegar antes de alguns
// sinais ainda em trânsito (ver conversa sobre a corrida entre os dois)
let pendingRoundSync = [];

// "filme" da partida atual (modo livre), pra tela de "assistir replay" —
// só é enviado ao servidor se a partida bater recorde pessoal (ver
// persistGameResult mais abaixo); senão fica só em memória e some quando a
// pessoa sai da tela. replayRounds guarda o que apareceu em cada rodada
// (ver newRound); replayMouse guarda o rastro do mouse (ver o listener de
// mousemove mais abaixo), em % do tamanho do tabuleiro — assim funciona em
// qualquer tamanho de tela na hora de reproduzir.
let replayRounds = [];
let replayMouse = [];
let replayStartMs = 0; // referência (performance.now()) pro tempo relativo de cada amostra do rastro

// desafio diário — estado separado do jogo normal (não usa "mode"/"score" etc.
// acima, pra não arriscar misturar com uma partida solo aberta em paralelo)
// dia (fuso de Brasília) em que o desafio diário estreia — até lá o card no
// menu fica só com título + cronômetro "Inicia em", sem descrição nem dados
const DAILY_CHALLENGE_LAUNCH_DATE = '2026-07-25';
function dailyLaunchAtMs() {
  const [y, m, d] = DAILY_CHALLENGE_LAUNCH_DATE.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 3, 0, 0, 0); // meia-noite de Brasília desse dia
}
function isDailyChallengeLive() { return dailyLocalDateStr() >= DAILY_CHALLENGE_LAUNCH_DATE; }
// nível mínimo pra jogar o desafio — quem está no nível 1 vê o mesmo
// tratamento de "ainda bloqueado" (só título + cronômetro) usado antes da
// estreia, até subir pro nível 2
const DAILY_MIN_LEVEL = 2;
function dailyLevelUnlocked() { return state.myData.admin === true || levelFromXp(myXp()) >= DAILY_MIN_LEVEL; }
let dailyMode = 'classic';    // modo sorteado do dia (ver dailyModeForToday) — definido ao mostrar a tela de introdução/iniciar tentativa
let dailyRng = null;          // gerador determinístico da rodada de hoje
let dailyPlaying = false;
let dailyPendingRoundSync = []; // mesma ideia de pendingRoundSync (modo livre), mas pra tentativa do
                                 // desafio diário — também guarda a chamada que recarimba o início real
                                 // da tentativa depois do "Vai!" (ver callArmDailySession)
// mesma ideia de replayRounds/replayMouse/replayStartMs (modo livre), mas
// pra tentativa do desafio diário — só sobe se bater a melhor pontuação do
// dia (ver dailyGameOver mais abaixo)
let dailyReplayRounds = [];
let dailyReplayMouse = [];
let dailyReplayStartMs = 0;
let dailyScore = 0;
let dailyTarget = null, dailyNextTarget = null;
let dailyDuration = 10000, dailyTimerStart = 0, dailyRafId = null;
let dailyCountdownTimerId = null; // contagem "3, 2, 1" antes da tentativa começar de vez
let dailySessionId = null;
let dailyDateStrCache = null;   // dia (AAAA-MM-DD) da tentativa em andamento
let dailyClosesAtMs = null;     // quando o desafio de hoje fecha (mesmo instante em que o de amanhã abre)
// tentativas usadas do desafio diário hoje — precisa ser lido/escrito tanto
// pelo desafio diário em si quanto por js/daily-ranking.js (mostra/esconde
// botão de replay conforme já usou as 3 tentativas), então tem um getter/
// setter em vez de exportado direto (ver comentário equivalente em
// screenBackStack, js/nav.js, sobre por que reassign direto de import não
// funciona em ES modules)
let dailyAttemptsUsed = 0;
window.getDailyAttemptsUsed = () => dailyAttemptsUsed;
window.setDailyAttemptsUsed = (n) => { dailyAttemptsUsed = n; };
let dailyBestScore = 0;


// modo sorteado do desafio diário — determinístico por dia (mesmo modo pra
// TODO MUNDO, e igual nas 3 tentativas), sorteado entre os modos de
// DAILY_ROTATION_MODES, SEM olhar nível desbloqueado: o desafio diário
// sempre foi acessível a qualquer um independente do modo normal estar
// bloqueado ou não pro nível da pessoa.
// DAILY_MODE_OVERRIDE: força um dia específico pra um modo em particular,
// sem mexer no sorteio de verdade dos outros dias (fica igual pra quem olhar
// de fora — "🎲 modo sorteado de hoje" continua fazendo sentido). Hoje
// (31/07/2026) é Reverso, com a paleta estendida de 12 cores; amanhã
// (01/08/2026) será Clássico, reaproveitando a MESMA paleta de 12 cores de
// hoje (ver DAILY_PALETTE_OVERRIDE).
const DAILY_MODE_OVERRIDE = { '2026-07-28': 'reverse', '2026-07-29': 'classic', '2026-07-30': 'classic', '2026-07-31': 'reverse', '2026-08-01': 'classic' };
function dailyModeForToday(dateStr) {
  if (DAILY_MODE_OVERRIDE[dateStr]) return DAILY_MODE_OVERRIDE[dateStr];
  return seededPick(mulberry32(hashSeed(dateStr + '|daily-mode-v1')), DAILY_ROTATION_MODES);
}
// mesma regra de fuso do servidor (America/Sao_Paulo, sempre UTC-3 — sem
// horário de verão desde 2019): dia do desafio + horário em que ele fecha
function dailyLocalDateStr(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD
}
// exposta em window pra js/daily-ranking.js poder usar sem esperar o
// desafio diário inteiro ganhar seu próprio módulo (fase futura)
window.dailyLocalDateStr = dailyLocalDateStr;
// mostra a data da mensagem da caixa de entrada como dd/mm/aa (msg.dateStr
// vem sempre como AAAA-MM-DD, ver dailyLocalDateStr acima)
function formatDailyDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}
function dailyNextMidnightSaoPauloMs(now = new Date()) {
  const [y, m, d] = dailyLocalDateStr(now).split('-').map(Number);
  const midnightTodayUtcMs = Date.UTC(y, m - 1, d, 3, 0, 0, 0);
  return midnightTodayUtcMs + 24 * 60 * 60 * 1000;
}
// o desafio de cada dia só abre 5min depois da virada (00:05, não 00:00 em
// ponto — ver DAILY_START_DELAY_MS/todayStartAtSaoPauloMs no
// functions/index.js, que é quem realmente barra; isso aqui é só pra saber
// quando mostrar o cronômetro "Inicia em" em vez de "Termina em")
const DAILY_START_DELAY_MS = 5 * 60 * 1000;
function dailyTodayStartsAtMs(now = new Date()) {
  const [y, m, d] = dailyLocalDateStr(now).split('-').map(Number);
  const midnightTodayUtcMs = Date.UTC(y, m - 1, d, 3, 0, 0, 0);
  return midnightTodayUtcMs + DAILY_START_DELAY_MS;
}
// true só na janela 00:00–00:05 de Brasília, quando o dia já virou mas o
// desafio de hoje ainda não abriu
function isDailyStartDelay(now = new Date()) { return now.getTime() < dailyTodayStartsAtMs(now); }

/* ================== recordes locais (modo sem conta) ================== */
function myRecord(m) {
  return state.offline ? getLocalRecord(m) : (state.myData[m] || 0);
}

/* ================== sons (Web Audio, sem arquivos) ================== */
const sfx = {
  correct(n) { playCorrectSfxVariant(equippedSfx, n); },
  wrong()   { tone(160, 0.3, 'sawtooth', 0.15); tone(110, 0.4, 'sawtooth', 0.15, 0.08); },
  timeout() { tone(300, 0.2, 'triangle', 0.15); tone(200, 0.3, 'triangle', 0.15, 0.15); tone(120, 0.5, 'triangle', 0.15, 0.3); },
  record()  { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'square', 0.1, 0.4 + i * 0.12)); },
  tick()    { tone(1000, 0.03, 'sine', 0.05); },
  levelUp() { [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.16, 'square', 0.12, i * 0.09)); },
  pvpWin()  { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.16, 'square', 0.12, i * 0.1)); }, // fanfarra de vitória do duelo
  pvpLose() { [300, 240, 190, 140].forEach((f, i) => tone(f, 0.22, 'sawtooth', 0.12, i * 0.14)); }, // tom descendente de derrota
  pvpDraw() { tone(440, 0.18, 'triangle', 0.12); tone(440, 0.18, 'triangle', 0.12, 0.22); }, // dois bipes iguais = empate
  countdown(isGo) { isGo ? tone(880, 0.2, 'square', 0.16) : tone(660, 0.12, 'square', 0.14); }, // bipe da contagem 3-2-1 (mais agudo/comprido no "Vai!")
};
// exposta em window pra js/replay.js poder tocar o som de acerto simulado ao
// reproduzir um replay, sem esperar os sons ganharem seu próprio módulo
// (fase futura)
window.sfx = sfx;
window.toggleMute = () => {
  setMuted(!isMuted());
  $('mute-btn').classList.toggle('on', !isMuted());
  $('mute-btn').querySelector('.tgl-icon').textContent = isMuted() ? '🔇' : '🔊';
};

/* ================== compartilhar ================== */
// monta o link de compartilhamento — ?ref= só existe pra quem tem conta (conta pro
// badge Divulgador) e &state.lang= só é incluído quando o idioma não é o padrão (pt), pra
// quem clicar já abrir o site traduzido em vez de cair sempre em português
async function buildShareLink() {
  let link = `${location.origin}${location.pathname}`;
  const params = [];
  if (!state.offline && state.currentUser) {
    const code = await ensureRefCode();
    if (code) params.push(`ref=${code}`);
  }
  if (state.lang !== 'pt') params.push(`state.lang=${state.lang}`);
  if (params.length) link += `?${params.join('&')}`;
  return link;
}

window.shareScore = async () => {
  track('share', { content_type: 'score', mode });
  const modeName = modeLabel(mode);
  const rec = $('new-record').classList.contains('show') ? T[state.lang].share_new_record_suffix : '';
  const link = await buildShareLink();
  const text = T[state.lang].share_text(score, modeName, rec, link);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  try {
    if (isMobile && navigator.share) {
      await navigator.share({ text });
    } else {
      await navigator.clipboard.writeText(text);
      $('share-status').textContent = T[state.lang].share_copied;
      setTimeout(() => { $('share-status').textContent = ''; }, 3000);
    }
  } catch {}
};

/* ================== convidar amigos (sem precisar terminar partida) ================== */
window.inviteFriends = async (statusElId = 'invite-status') => {
  track('share', { content_type: 'invite' });
  const link = await buildShareLink();
  const text = T[state.lang].invite_text(link);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const statusEl = $(statusElId);
  try {
    if (isMobile && navigator.share) {
      await navigator.share({ text });
    } else {
      await navigator.clipboard.writeText(text);
      if (statusEl) {
        // esses status ficam "display:none" quando vazios (ver HTML) — só
        // um textContent sozinho deixava um espaço fantasma reservado pelo
        // gap do flex mesmo sem nenhum texto aparecendo (esticava, por
        // exemplo, o espaço entre o nick e o botão de amizade no perfil)
        statusEl.style.display = '';
        statusEl.textContent = T[state.lang].share_copied;
        setTimeout(() => { statusEl.textContent = ''; statusEl.style.display = 'none'; }, 3000);
      }
    }
  } catch {}
};

// copia só o código puro (não o link inteiro) — pra passar de viva voz/
// WhatsApp e o amigo colar direto no campo de indicação da tela de nick (ver
// ref-code-input/syncRefCodeField)
window.copyRefCode = async (statusElId) => {
  if (!state.myData.refCode) return;
  try {
    await navigator.clipboard.writeText(state.myData.refCode);
    const el = $(statusElId);
    if (el) {
      el.style.display = ''; // ver comentário equivalente em inviteFriends
      el.textContent = T[state.lang].share_copied;
      setTimeout(() => { el.textContent = ''; el.style.display = 'none'; }, 3000);
    }
  } catch {}
};

/* ================== autenticação ================== */
const AUTH_ERRORS = {
  pt: {
    'auth/invalid-email': 'E-mail inválido.',
    'auth/missing-password': 'Digite a senha.',
    'auth/weak-password': 'Senha muito fraca (mínimo 6 caracteres).',
    'auth/email-already-in-use': 'Este e-mail já tem conta. Use ENTRAR.',
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/wrong-password': 'E-mail ou senha incorretos.',
    'auth/user-not-found': 'Conta não encontrada. Use CRIAR CONTA.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco.',
    'auth/popup-closed-by-user': 'Login cancelado.',
    'auth/popup-blocked': 'Popup bloqueado pelo navegador. Permita popups.',
  },
  en: {
    'auth/invalid-email': 'Invalid email.',
    'auth/missing-password': 'Enter your password.',
    'auth/weak-password': 'Password too weak (minimum 6 characters).',
    'auth/email-already-in-use': 'This email already has an account. Use LOG IN.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/user-not-found': 'Account not found. Use SIGN UP.',
    'auth/too-many-requests': 'Too many attempts. Please wait a moment.',
    'auth/popup-closed-by-user': 'Login canceled.',
    'auth/popup-blocked': 'Popup blocked by the browser. Please allow popups.',
  },
  es: {
    'auth/invalid-email': 'Correo electrónico inválido.',
    'auth/missing-password': 'Escribe la contraseña.',
    'auth/weak-password': 'Contraseña muy débil (mínimo 6 caracteres).',
    'auth/email-already-in-use': 'Este correo ya tiene una cuenta. Usa INICIAR SESIÓN.',
    'auth/invalid-credential': 'Correo o contraseña incorrectos.',
    'auth/wrong-password': 'Correo o contraseña incorrectos.',
    'auth/user-not-found': 'Cuenta no encontrada. Usa CREAR CUENTA.',
    'auth/too-many-requests': 'Demasiados intentos. Espera un momento.',
    'auth/popup-closed-by-user': 'Inicio de sesión cancelado.',
    'auth/popup-blocked': 'Popup bloqueado por el navegador. Permite los popups.',
  },
};
const authErrMsg = e => (AUTH_ERRORS[state.lang][e.code]) || (state.lang === 'pt' ? 'Erro: ' : 'Error: ') + (e.code || e.message);

window.doLogin = async () => {
  $('auth-error').textContent = '';
  try {
    await signInWithEmailAndPassword(auth, $('auth-email').value.trim(), $('auth-pass').value);
    track('login', { method: 'password' });
  } catch (e) { $('auth-error').textContent = authErrMsg(e); }
};
window.doSignup = async () => {
  $('auth-error').textContent = '';
  try {
    const cred = await createUserWithEmailAndPassword(auth, $('auth-email').value.trim(), $('auth-pass').value);
    await sendEmailVerification(cred.user);
  } catch (e) { $('auth-error').textContent = authErrMsg(e); }
};
window.resendVerification = async () => {
  $('verify-status').textContent = '';
  try {
    await sendEmailVerification(auth.currentUser);
    $('verify-status').textContent = T[state.lang].verify_resent;
  } catch (e) { $('verify-status').textContent = authErrMsg(e); }
};
window.checkVerification = async () => {
  $('verify-status').textContent = '';
  await auth.currentUser.reload();
  if (auth.currentUser.emailVerified) {
    await auth.currentUser.getIdToken(true); // atualiza o token para as regras do banco
    state.currentUser = auth.currentUser;
    await proceedAfterLogin(state.currentUser);
  } else {
    $('verify-status').textContent = T[state.lang].verify_not_confirmed;
  }
};
// true só quando a página está rodando dentro do app nativo (Capacitor,
// iOS/Android); no navegador comum (mesmo mobile) window.Capacitor não
// existe, então isso nunca chega a ser true fora do app publicado nas lojas.
// (mesma função de index.html — teste.html não tinha nenhum código ciente
// de Capacitor até agora)
function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}
// "Sign in with Apple" só aparece dentro do app empacotado — a Apple só
// exige isso no APP (guideline 4.8), não no site avulso, e no navegador
// solto o login com Apple não completa (WebKit derruba o resultado do
// popup/redirect fora do app nativo). Fora do app, só Google/e-mail mesmo.
if (!isNativeApp()) {
  const appleBtn = $('btn-apple');
  if (appleBtn) appleBtn.style.display = 'none';
}
// dentro do app nativo (Capacitor) o login precisa ser NATIVO, não WebView —
// o Google recusa completar OAuth dentro de uma WebView embutida genérica
// (detecta como "disallowed_useragent") e empurra pro Safari de verdade, que
// não devolve resultado nenhum pro app (são sessões/contextos separados). O
// plugin @capacitor-firebase/authentication (window.Capacitor.Plugins.
// FirebaseAuthentication) usa a tela nativa de verdade do SDK do Google —
// sem WebView — e devolve um idToken que a gente entrega pro Firebase JS via
// signInWithCredential. Fora do app, popup no navegador continua funcionando
// normal (era só dentro do WebView do app que isso quebrava).
window.doGoogle = async () => {
  $('auth-error').textContent = '';
  try {
    if (isNativeApp()) {
      const { FirebaseAuthentication } = window.Capacitor.Plugins;
      const result = await FirebaseAuthentication.signInWithGoogle();
      await signInWithCredential(auth, GoogleAuthProvider.credential(result.credential.idToken));
      track('login', { method: 'google' });
      return;
    }
    await signInWithPopup(auth, new GoogleAuthProvider());
    track('login', { method: 'google' });
  } catch (e) { $('auth-error').textContent = authErrMsg(e); }
};
// exigido pela guideline 4.8 da Apple: como já oferecemos login de terceiro
// (Google), precisamos oferecer "Sign in with Apple" como opção equivalente
// — só que aqui SEMPRE é o login nativo (ASAuthorizationController, mesmo
// mecanismo do doGoogle acima), porque o botão nem aparece fora do app
// nativo (ver isNativeApp() lá embaixo) — no navegador solto o login com
// Apple nunca completa (WebKit derruba o resultado do popup/redirect fora
// do app), então preferimos nem oferecer a opção ali.
window.doApple = async () => {
  $('auth-error').textContent = '';
  try {
    const { FirebaseAuthentication } = window.Capacitor.Plugins;
    const result = await FirebaseAuthentication.signInWithApple();
    const provider = new OAuthProvider('apple.com');
    const credential = provider.credential({
      idToken: result.credential.idToken,
      rawNonce: result.credential.nonce,
    });
    await signInWithCredential(auth, credential);
    registerAppleAuthCodeIfPresent(result.credential.authorizationCode);
    track('login', { method: 'apple' });
  } catch (e) { $('auth-error').textContent = authErrMsg(e); }
};
// a Apple exige (guideline 5.1.1(v)) revogar o token junto a ELES quando a
// conta é excluída — isso precisa de um refresh token da Apple, que só dá pra
// conseguir trocando o authorization code (devolvido pelo login nativo acima)
// pelo token de verdade, no servidor (ver registerAppleAuthCode em
// functions/index.js — troca feita com client_id = bundle ID do app, sem
// redirect_uri, por ser um authorization code de login NATIVO, diferente do
// fluxo web por Services ID). Melhor esforço: se falhar, o login em si já
// aconteceu normalmente por fora desta função.
function registerAppleAuthCodeIfPresent(code) {
  if (!code) return;
  callRegisterAppleAuthCode({ code, native: true }).catch(() => {});
}
window.doLogout = async () => {
  state.offline = false;
  stopPvpListener();
  await signOut(auth);
  show('auth-screen');
};
// em vez de window.confirm (um "OK" genérico que ninguém lê), a exclusão de
// conta usa a popup temática #delete-account-modal — o botão de lá tem o
// texto explícito "Confirmo a exclusão da conta" pra garantir que a pessoa
// sabe o que está clicando antes da conta ser desativada
let deleteAccountBtnRef = null;
window.startDeleteMyAccount = (btn) => {
  if (state.offline || !state.currentUser) return;
  deleteAccountBtnRef = btn;
  $('delete-account-modal').style.display = 'flex';
};
window.closeDeleteAccountModal = () => {
  $('delete-account-modal').style.display = 'none';
};
window.confirmDeleteAccount = async () => {
  closeDeleteAccountModal();
  const btn = deleteAccountBtnRef;
  const statusEl = $('delete-account-status');
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = T[state.lang].delete_account_progress;
  try {
    await callDeleteMyAccount();
    stopPvpListener();
    state.offline = false;
    state.currentUser = null;
    await signOut(auth);
    show('auth-screen');
    alert(T[state.lang].delete_account_done);
  } catch (e) {
    if (btn) btn.disabled = false;
    if (statusEl) statusEl.textContent = T[state.lang].delete_account_error;
  }
};
window.playOffline = () => {
  track('play_offline');
  stopPvpListener(); // duelo exige conta — não faz sentido continuar ouvindo partidas jogando sem login
  state.offline = true;
  state.currentUser = null;
  state.myData = {
    nick: null, classic: 0, reverse: 0, shapes: 0, 'shapes-reverse': 0,
    gamesPlayed: 0, totalPoints: 0, bestStreak: 0, currentStreak: 0, lastPlayedDate: null,
    playedClassic: false, playedReverse: false, playedShapes: false, playedShapesReverse: false, playedTrio: false, playedCaos: false, referrals: 0, bestRank: null, refCode: null, total: 0, xp: 0, dailyWins: 0, pigmentos: 0, ownedItems: [], equipped: {}, equippedBadge: null, equippedBadgeTier: null, badgesSeenTiers: {},
  };
  showMenu();
};

// "última vez online" — a sessão do Firebase Auth persiste sozinha, então só
// registrar o momento do login não conta a história toda (alguém pode abrir o
// jogo, deixar a aba aberta e nunca mais tocar em nada). Por isso, além do
// toque na hora do login, isso aqui manda um "sinal de vida" periódico
// enquanto a aba fica visível/em uso — só usado hoje pela ferramenta de admin.
const ACTIVITY_HEARTBEAT_MS = 5 * 60 * 1000; // a cada 5 minutos
let activityHeartbeatStarted = false;
function touchActivityTick() {
  if (!state.offline && state.currentUser) callTouchActivity().catch(() => {});
}
function startActivityHeartbeat() {
  if (activityHeartbeatStarted) return;
  activityHeartbeatStarted = true;
  setInterval(touchActivityTick, ACTIVITY_HEARTBEAT_MS);
  // se a pessoa deixar a aba em segundo plano por horas e voltar, não espera
  // o próximo tique do intervalo — atualiza na hora que ela volta a olhar
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') touchActivityTick();
  });
}
startActivityHeartbeat();

onAuthStateChanged(auth, async user => {
  if (user) {
    state.offline = false;
    state.currentUser = user;
    // conta por e-mail/senha precisa confirmar o e-mail (Google já vem verificado)
    const isPassword = user.providerData.some(p => p.providerId === 'password');
    if (isPassword && !user.emailVerified) {
      $('verify-email-label').textContent = user.email;
      show('verify-screen');
      return;
    }
    await proceedAfterLogin(user);
  } else {
    state.currentUser = null;
    if (!state.offline) show('auth-screen');
  }
});

const EMPTY_PROFILE = {
  nick: null, classic: 0, reverse: 0, shapes: 0, 'shapes-reverse': 0,
  gamesPlayed: 0, totalPoints: 0, bestStreak: 0, currentStreak: 0, lastPlayedDate: null,
  playedClassic: false, playedReverse: false, playedShapes: false, playedShapesReverse: false, playedTrio: false, playedCaos: false, referrals: 0, bestRank: null, refCode: null, total: 0, xp: 0, dailyWins: 0, pigmentos: 0, ownedItems: [], equipped: {}, equippedBadge: null, equippedBadgeTier: null, badgesSeenTiers: {},
};

async function proceedAfterLogin(user) {
  try {
    const snap = await getDoc(doc(db, 'scores', user.uid));
    state.myData = snap.exists() ? { ...EMPTY_PROFILE, ...snap.data() } : { ...EMPTY_PROFILE };
  } catch { state.myData = { ...EMPTY_PROFILE }; }
  applyEquippedCosmetics();
  if (!state.myData.nick) { syncRefCodeField(); resetNickConsent(); show('nick-screen'); }
  else {
    await backfillTotal();
    await submitPendingScore();
    startPvpListener();
    touchActivityTick(); // atualiza "última vez online" na hora (o heartbeat cuida do resto enquanto a aba ficar aberta)
    // já tem conta — se chegou (ou já estava logada) com o link de convite de
    // alguém, sugere amizade em segundo plano, sem travar a entrada no menu
    // (mesmo caso de quem acabou de criar a conta, ver saveNick/creditReferral)
    if (referrerCode) {
      callSuggestFriendFromRef({ refCode: referrerCode }).catch(() => {});
      referrerCode = null;
      try { sessionStorage.removeItem('colorRushRef'); } catch {}
    }
    showMenu();
  }
}

// corrige (silenciosamente) contas antigas que ainda não têm o campo "total" calculado,
// sem precisar esperar a pessoa bater um novo recorde — roda sozinho ao abrir o jogo
async function backfillTotal() {
  if (computeTotal() === (state.myData.total || 0)) return; // já está correto, nem precisa chamar o servidor
  // o total agora é sempre recalculado no servidor a partir dos recordes que ELE gravou —
  // o cliente não manda nenhum valor, só pede pra recalcular
  try {
    const res = await callRecomputeTotal();
    if (res.data && res.data.updated) state.myData.total = res.data.total;
  } catch {}
}

/* ================== nick ================== */
// sincroniza o campo de código de indicação na tela de nick com referrerCode
// (capturado de ?ref= na URL). Veio de link: trava o campo (não dá pra
// "roubar" a indicação de outra pessoa trocando o valor). Não veio de link:
// deixa livre pra digitar o código de um amigo manualmente.
function syncRefCodeField() {
  const row = $('ref-code-row');
  const input = $('ref-code-input');
  if (!row || !input) return;
  // já veio por link de convite: crédito automático (ver saveNick), esconde o
  // campo de vez — não faz sentido pedir de novo o que já foi capturado
  row.style.display = referrerCode ? 'none' : 'flex';
  if (!referrerCode) input.value = '';
}
// zera a caixinha de consentimento (guideline 5.1.2) toda vez que a tela de
// nick é mostrada — precisa ser marcada de novo a cada visita, não fica
// "lembrada" de uma tentativa anterior
function resetNickConsent() {
  const cb = $('nick-consent-checkbox');
  if (cb) cb.checked = false;
  const btn = $('nick-confirm-btn');
  if (btn) btn.disabled = true;
}
window.updateNickConfirmState = () => {
  const cb = $('nick-consent-checkbox');
  const btn = $('nick-confirm-btn');
  if (cb && btn) btn.disabled = !cb.checked;
};
window.saveNick = async () => {
  const nick = $('nick-input').value.trim();
  $('nick-error').textContent = '';
  // reforço além do botão desabilitado (que já impede o clique via UI) — só
  // por garantia, caso algo force o clique sem a caixinha marcada
  if (!$('nick-consent-checkbox').checked) {
    $('nick-error').textContent = T[state.lang].err_nick_consent;
    return;
  }
  if (nick.length < 3 || nick.length > 16) {
    $('nick-error').textContent = T[state.lang].err_nick_length;
    return;
  }
  if (/\s/.test(nick)) {
    $('nick-error').textContent = T[state.lang].err_nick_spaces;
    return;
  }
  const nickKey = nick.toLowerCase(); // "Igor" e "IGOR" contam como o mesmo nick
  try {
    const taken = await getDoc(doc(db, 'nicks', nickKey));
    if (taken.exists()) {
      $('nick-error').textContent = T[state.lang].err_nick_taken;
      return;
    }
    const refCode = await generateUniqueRefCode();

    const batch = writeBatch(db);
    batch.set(doc(db, 'nicks', nickKey), { uid: state.currentUser.uid });
    batch.set(doc(db, 'refcodes', refCode), { uid: state.currentUser.uid });
    batch.set(doc(db, 'scores', state.currentUser.uid), {
      nick,
      refCode,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    await batch.commit();
    track('sign_up');
    state.myData.nick = nick;
    state.myData.refCode = refCode;

    // credita a indicação para quem trouxe esse jogador (feito no servidor,
    // já que é uma escrita no documento de OUTRO usuário). referrerCode (de um
    // link ?ref=) tem prioridade; sem link, usa o que a pessoa digitou à mão
    // no campo — um código inválido/inexistente simplesmente não credita nada
    // (ver creditReferral em functions/index.js), sem erro pra pessoa.
    const typedRefCode = ($('ref-code-input').value || '').trim().toUpperCase();
    const codeToCredit = referrerCode || typedRefCode || null;
    if (codeToCredit) {
      try { await callCreditReferral({ refCode: codeToCredit }); } catch {}
      referrerCode = null;
      try { sessionStorage.removeItem('colorRushRef'); } catch {}
    }

    await submitPendingScore();
    startPvpListener();
    showMenu();
  } catch (e) { $('nick-error').textContent = T[state.lang].err_nick_save(e.message); }
};

/* ================== menu ================== */
window.showMenu = () => {
  $('record-classic').textContent = myRecord('classic');
  $('record-reverse').textContent = myRecord('reverse');
  $('record-shapes').textContent = myRecord('shapes');
  $('record-shapes-reverse').textContent = myRecord('shapes-reverse');
  $('record-trio').textContent = myRecord('trio');
  $('record-caos').textContent = myRecord('caos');
  $('mute-btn').classList.toggle('on', !isMuted());
  $('mute-btn').querySelector('.tgl-icon').textContent = isMuted() ? '🔇' : '🔊';

  // nível e barra de XP (só aparece pra quem tem conta)
  $('menu-xp-wrap').style.display = state.offline ? 'none' : '';
  const xi = xpInfo(myXp());
  $('menu-xp-lv').textContent = `Lv ${xi.lv}`;
  $('menu-xp-nums').textContent = `${xi.into}/${xi.need}`;
  $('menu-xp-fill').style.width = Math.min(100, (xi.into / xi.need) * 100) + '%';

  // amigos precisam de conta — botão some jogando sem login; a bolinha
  // vermelha avisa quando tem pedido de amizade esperando resposta
  $('menu-quick-friends-btn').style.display = state.offline ? 'none' : '';
  if (!state.offline && state.currentUser) {
    fetchMyFriendRequests().then(reqs => {
      const n = Object.keys(reqs.incoming || {}).length;
      const badge = $('menu-quick-friends-badge');
      badge.textContent = n;
      badge.style.display = n > 0 ? '' : 'none';
    }).catch(() => {});
  }
  refreshInboxBadge();
  updateDailyMenuCard();
  renderMenuPigmentosBar();
  renderUserPigmentos();
  refreshBadgeNotifDot();

  // bloqueio dos modos por nível
  for (const [m, minLv] of Object.entries(MODE_UNLOCK)) {
    const locked = !modeUnlocked(m);
    $('card-' + m).classList.toggle('locked', locked);
    const lockEl = $('lock-' + m);
    lockEl.style.display = locked ? '' : 'none';
    if (locked) lockEl.textContent = T[state.lang].unlock_at(minLv);
  }
  if (state.offline) {
    $('user-label').textContent = T[state.lang].offline_label;
    $('menu-logout-btn').textContent = T[state.lang].entrar_label;
  } else {
    // avatar (markup fixo/confiável) vai por innerHTML; o nick sempre por
    // textContent/createTextNode (pode ter qualquer caractere não-espaço)
    const labelEl = $('user-label');
    labelEl.innerHTML = '';
    labelEl.insertAdjacentHTML('beforeend', avatarOrDefaultIcon(equippedAvatar, 32) + ' ');
    labelEl.appendChild(document.createTextNode(T[state.lang].user_greeting(state.myData.nick || '')));
    $('menu-logout-btn').textContent = T[state.lang].sair_label;
  }
  // menu é a "raiz" da navegação — zera a pilha de "voltar" (ver
  // pushScreenAndShow/popScreenBack) toda vez que ela é mostrada de
  // verdade, pra nunca ir acumulando entradas órfãs de sessões de
  // perfil/ranking anteriores
  resetScreenBackStack();
  show('menu-screen');
};

/* ================== jogo ================== */
window.playAgain = () => window.startGame(mode);

window.startGame = (m) => {
  if (blockIfBanned()) return; // conta suspensa não joga nenhum modo
  if (!modeUnlocked(m)) return; // modo ainda bloqueado pelo nível
  track('game_start', { mode: m });
  mode = m;
  score = 0;
  xpGain = 0;
  duration = 10000;
  playing = true;
  target = pick(poolFor(mode));
  $('score').textContent = 0;
  $('record-hud').textContent = myRecord(mode);
  replayRounds = [];
  replayMouse = [];
  replayStartMs = performance.now();
  show('game-screen');
  newRound(true);

  // abre uma sessão no servidor (timestamp confiável) pra poder validar a
  // pontuação no fim da partida — só quem tem conta precisa disso
  state.currentSessionId = null;
  if (!state.offline && state.currentUser && state.myData.nick) {
    callStartSession({ mode: m }).then(res => {
      state.currentSessionId = res.data.sessionId;
    }).catch(() => { state.currentSessionId = null; });
  }
};

// rastro do mouse pra tela de replay — throttlado (não grava cada micro-
// movimento) e guardado em % do tamanho do tabuleiro (não pixel bruto), pra
// funcionar igual em qualquer tamanho de tela na hora de reproduzir. É só
// cosmético, nunca entra na validação de pontuação. No celular não existe
// "mousemove" contínuo (só toque discreto), então esse rastro simplesmente
// fica vazio lá — o replay
// mostra os cliques certos, sem cursor se movendo entre eles.
const REPLAY_MOUSE_SAMPLE_MS = 30; // ~33 amostras/seg
const REPLAY_MOUSE_CAP = 8000; // mesmo teto do servidor (MAX_REPLAY_MOUSE_SAMPLES) — a ~33/seg dá pra guardar uns 4min de rastro, e o documento final fica bem abaixo do limite de 1MB do Firestore mesmo assim
let lastReplayMouseSampleAt = 0;
function recordReplayMouseSample(clientX, clientY) {
  const now = performance.now();
  if (now - lastReplayMouseSampleAt < REPLAY_MOUSE_SAMPLE_MS) return;
  lastReplayMouseSampleAt = now;
  let gridEl = null, arr = null, startMs = 0;
  if (playing) { gridEl = $('grid'); arr = replayMouse; startMs = replayStartMs; }
  else if (dailyPlaying) { gridEl = $('daily-grid'); arr = dailyReplayMouse; startMs = dailyReplayStartMs; }
  else return;
  if (!gridEl || arr.length >= REPLAY_MOUSE_CAP) return;
  const rect = gridEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const xPct = (clientX - rect.left) / rect.width;
  const yPct = (clientY - rect.top) / rect.height;
  arr.push([Math.round(xPct * 1000) / 1000, Math.round(yPct * 1000) / 1000, Math.round(now - startMs)]);
}
window.addEventListener('mousemove', e => recordReplayMouseSample(e.clientX, e.clientY));

// Modo Trio: cada quadrado tem 3 cores independentes (fundo/bg, cor da
// palavra/tc, e a palavra em si/word — que também é o nome de uma cor). A
// pessoa decora um PAR de cores (trioColorA/trioColorB); o quadrado certo é
// o ÚNICO em que uma dessas 2 cores aparece em QUALQUER uma das 3 partes; os
// outros 3 quadrados não podem referenciar nenhuma das 2 de jeito nenhum. Ao
// acertar, o novo par a decorar são os 2 OUTROS atributos (os que não deram
// o match) do quadrado que acabou de ser clicado — ver handleTrioClick.
//
// Viabilidade: como só é preciso excluir 2 cores por vez das 8 existentes
// (COLORS), sempre sobram 6 cores livres — de sobra pros 2 preenchimentos do
// quadrado certo (2 de 6) e pras 3 cores distintas de cada quadrado errado (3
// de 6), incluindo a reserva de até 4 fundos distintos entre si (ver
// bgAssignment) — então NENHUMA cor nova precisou ser adicionada à paleta.
function newTrioRound(first) {
  const pool = COLORS;
  let colorA, colorB;
  if (first || !trioColorA || !trioColorB) {
    // shuffle() ordena IN PLACE (ver "const shuffle = a => a.sort(...)") — nunca
    // pode receber a constante COLORS direto, ou embaralharia pra sempre a ordem
    // fixa que o tutorial de outros modos depende (COLORS[0], COLORS[1]...); por
    // isso passamos uma CÓPIA (.slice()) aqui, igual o resto do arquivo já faz
    // indiretamente sempre que chama shuffle(pool.filter(...)) (filter também
    // sempre devolve array novo)
    const shuffled = shuffle(pool.slice());
    colorA = shuffled[0];
    colorB = shuffled[1];
  } else {
    colorA = trioColorA;
    colorB = trioColorB;
  }
  trioColorA = colorA;
  trioColorB = colorB;

  const targetIdx = Math.floor(Math.random() * SQUARES);
  const matchColor = Math.random() < 0.5 ? colorA : colorB;
  const SLOTS = ['bg', 'tc', 'word'];
  const matchSlot = SLOTS[Math.floor(Math.random() * SLOTS.length)];
  const fillerPool = pool.filter(c => c !== colorA && c !== colorB); // sempre 6 cores

  // fundo NUNCA se repete entre os 4 quadrados da rodada — reserva antes de
  // tudo uma cor de fundo distinta por quadrado (se o quadrado certo "gastar"
  // o match no próprio fundo, ele já sai direto com matchColor; os outros 3,
  // ou os 4, tiram fundos distintos do fillerPool). Isso não muda nenhuma
  // regra: continua sendo o único jeito de saber qual é o certo (procurar as
  // 2 cores decoradas nas 3 partes), só deixa o tabuleiro mais legível.
  const bgShuffled = shuffle(fillerPool.slice());
  const bgAssignment = [];
  let bgCursor = 0;
  for (let i = 0; i < SQUARES; i++) {
    bgAssignment[i] = (i === targetIdx && matchSlot === 'bg') ? matchColor : bgShuffled[bgCursor++];
  }

  const grid = $('grid');
  grid.innerHTML = '';
  const roundSnapshot = [];
  let newPairA = null, newPairB = null;

  for (let i = 0; i < SQUARES; i++) {
    const bg = bgAssignment[i];
    let sq;
    if (i === targetIdx) {
      if (matchSlot === 'bg') {
        // fundo já é matchColor — tc/word são 2 cores distintas entre si (o
        // fundo nunca entra nessa comparação, já não pode repetir por
        // construção: matchColor nunca está no fillerPool)
        const fillers = shuffle(fillerPool.slice()).slice(0, 2);
        sq = { bg, tc: fillers[0], word: fillers[1], isTarget: true };
        newPairA = fillers[0];
        newPairB = fillers[1];
      } else {
        // matchSlot é tc OU word — esse vira matchColor; o slot restante
        // (o outro entre tc/word) fica com mais uma cor do fillerPool,
        // diferente do fundo já reservado pra esse quadrado
        const otherSlot = SLOTS.find(s => s !== 'bg' && s !== matchSlot);
        const otherFiller = shuffle(fillerPool.filter(c => c !== bg))[0];
        const attrs = { bg };
        attrs[matchSlot] = matchColor;
        attrs[otherSlot] = otherFiller;
        sq = { bg: attrs.bg, tc: attrs.tc, word: attrs.word, isTarget: true };
        newPairA = bg;
        newPairB = otherFiller;
      }
    } else {
      const fillers = shuffle(fillerPool.filter(c => c !== bg)).slice(0, 2);
      sq = { bg, tc: fillers[0], word: fillers[1], isTarget: false };
    }
    const el = document.createElement('div');
    el.className = 'square';
    renderTrioSquare(el, sq);
    el.onclick = (e) => handleTrioClick(sq.isTarget, e);
    grid.appendChild(el);
    roundSnapshot.push({
      bg: sq.bg.key, tc: sq.tc.key, word: sq.word.key, isTarget: sq.isTarget,
      // o par inicial só existe (e só faz sentido gravar) na primeira rodada —
      // é o que a tela de replay usa pra montar a instrução "decore X e Y"
      // sem precisar adivinhar a cor que nunca apareceu desenhada em lugar
      // nenhum (ver renderReplaySquares)
      ...(first ? { pairA: colorA.key, pairB: colorB.key } : {}),
    });
  }
  if (replayRounds.length < 400) replayRounds.push({ t: Math.round(performance.now() - replayStartMs), sq: roundSnapshot });

  trioNextPairA = newPairA;
  trioNextPairB = newPairB;

  $('instruction').textContent = first
    ? T[state.lang].instr_first_trio(cName(colorA), cName(colorB))
    : T[state.lang].instr_next_trio;
  $('speed').textContent = `⏱️ ${(duration / 1000).toFixed(1)}s`;

  startTimer();
}

function handleTrioClick(isCorrect, e) {
  if (!playing) return;
  if (isCorrect) {
    score++;
    if (state.currentSessionId) pendingRoundSync.push(callSyncProgress({ sessionId: state.currentSessionId, trusted: !e || e.isTrusted }).catch(() => {}));
    const elapsed = (performance.now() - timerStart) / 1000;
    xpGain += Math.max(0, 3 - 0.2 * elapsed) * xpStreakMultiplier(score);
    sfx.correct(score);
    $('score').textContent = score;
    trioColorA = trioNextPairA;
    trioColorB = trioNextPairB;
    duration *= 0.95;
    newTrioRound(false);
  } else {
    sfx.wrong();
    gameOver(T[state.lang].reason_wrong);
  }
}

// Modo Caos: cada quadrado tem 3 atributos independentes — a FORMA (shape),
// a COR de preenchimento dela (color) e a PALAVRA escrita nela (word, que
// pode nomear tanto uma cor quanto uma forma — vem de CAOS_POOL). A pessoa
// decora um PAR de itens (caosItemA/caosItemB — podendo ser 2 cores, 2
// formas ou 1 de cada); o quadrado certo é o ÚNICO em que um desses 2 itens
// aparece em QUALQUER um dos 3 atributos. Ao acertar, o novo par a decorar
// são os 2 OUTROS atributos (os que não deram o match) do quadrado que
// acabou de ser clicado — mesma mecânica do Trio (ver newTrioRound), só que
// com um pool misto de cor+forma em vez de só cor.
//
// Diferença-chave pro Trio: lá os 3 atributos aceitam QUALQUER uma das 8
// cores. Aqui só a palavra (word) aceita qualquer item do pool misto — forma
// só aceita forma, cor só aceita cor (domínio fixo) — por isso matchSlot só
// pode ser sorteado entre os slots cujo domínio aceita o item sorteado (ver
// matchableSlots abaixo), e o preenchimento de cada quadrado trata os 3
// casos (match na forma / na cor / na palavra) separadamente.
//
// Viabilidade: forma e cor nunca se repetem entre os 4 quadrados (ver
// shapeAssignment/colorAssignment abaixo). Pior caso é quando os 2 itens
// memorizados são as 2 formas sorteadas E o match cai na palavra (não
// "gasta" nenhuma forma do fillerPool) — sobram exatamente 4 formas livres
// (6 - 2) pros 4 quadrados, just certo. Cor nunca fica tão apertada (mínimo
// 6 livres de 8, sempre dá pras até 4 necessárias).
function newCaosRound(first) {
  let itemA, itemB;
  if (first || !caosItemA || !caosItemB) {
    const shuffled = shuffle(CAOS_POOL.slice());
    itemA = shuffled[0];
    itemB = shuffled[1];
  } else {
    itemA = caosItemA;
    itemB = caosItemB;
  }
  caosItemA = itemA;
  caosItemB = itemB;

  const targetIdx = Math.floor(Math.random() * SQUARES);
  const matchItem = Math.random() < 0.5 ? itemA : itemB;
  const matchableSlots = isColorItem(matchItem) ? ['color', 'word'] : ['shape', 'word'];
  const matchSlot = matchableSlots[Math.floor(Math.random() * matchableSlots.length)];

  const fillerPool = CAOS_POOL.filter(x => x !== itemA && x !== itemB); // sempre 12 itens
  const shapeFillerPool = fillerPool.filter(x => !isColorItem(x));
  const colorFillerPool = fillerPool.filter(x => isColorItem(x));

  // forma E cor NUNCA se repetem entre os 4 quadrados da rodada — reserva
  // antes de tudo uma forma distinta e uma cor distinta por quadrado (mesma
  // ideia do "fundo nunca se repete" do Trio — ver newTrioRound — só que
  // aplicada aos 2 atributos visuais aqui, já que são os mais visíveis). Se
  // o quadrado certo "gastar" o match na própria forma/cor, ele já sai
  // direto com matchItem nesse atributo; os outros, com valores distintos
  // dos respectivos fillerPools (sempre cabe: colorFillerPool nunca tem
  // menos que 6 cores livres, contra no máximo 4 necessárias).
  const shapeShuffled = shuffle(shapeFillerPool.slice());
  const colorShuffled = shuffle(colorFillerPool.slice());
  const shapeAssignment = [];
  const colorAssignment = [];
  let shapeCursor = 0, colorCursor = 0;
  for (let i = 0; i < SQUARES; i++) {
    shapeAssignment[i] = (i === targetIdx && matchSlot === 'shape') ? matchItem : shapeShuffled[shapeCursor++];
    colorAssignment[i] = (i === targetIdx && matchSlot === 'color') ? matchItem : colorShuffled[colorCursor++];
  }

  const grid = $('grid');
  grid.innerHTML = '';
  const roundSnapshot = [];
  let newPairA = null, newPairB = null;

  for (let i = 0; i < SQUARES; i++) {
    const shape = shapeAssignment[i];
    const color = colorAssignment[i];
    const isTarget = (i === targetIdx);
    let word;
    if (isTarget && matchSlot === 'word') {
      word = matchItem;
      newPairA = shape; newPairB = color;
    } else {
      word = shuffle(fillerPool.filter(x => x !== shape && x !== color))[0];
      if (isTarget) {
        // matchSlot é 'shape' ou 'color' — já ficou reservado direto no
        // Assignment acima; o outro atributo (não-match) + a palavra são o
        // novo par a memorizar
        newPairA = (matchSlot === 'shape') ? color : shape;
        newPairB = word;
      }
    }
    const sq = { shape, color, word, isTarget };
    const el = document.createElement('div');
    renderCaosSquare(el, sq);
    el.onclick = (e) => handleCaosClick(sq.isTarget, e);
    grid.appendChild(el);
    roundSnapshot.push({
      shape: poolItemId(sq.shape), color: sq.color.key, word: poolItemId(sq.word), isTarget: sq.isTarget,
      // par inicial (ver pairA/pairB do Trio) — só existe na primeira rodada,
      // é o que a tela de replay usa pra montar a instrução "decore X e Y"
      ...(first ? { pairA: poolItemId(itemA), pairB: poolItemId(itemB) } : {}),
    });
  }
  if (replayRounds.length < 400) replayRounds.push({ t: Math.round(performance.now() - replayStartMs), sq: roundSnapshot });

  caosNextPairA = newPairA;
  caosNextPairB = newPairB;

  $('instruction').textContent = first
    ? T[state.lang].instr_first_caos(cName(itemA), cName(itemB))
    : T[state.lang].instr_next_caos;
  $('speed').textContent = `⏱️ ${(duration / 1000).toFixed(1)}s`;

  startTimer();
}

function handleCaosClick(isCorrect, e) {
  if (!playing) return;
  if (isCorrect) {
    score++;
    if (state.currentSessionId) pendingRoundSync.push(callSyncProgress({ sessionId: state.currentSessionId, trusted: !e || e.isTrusted }).catch(() => {}));
    const elapsed = (performance.now() - timerStart) / 1000;
    xpGain += Math.max(0, 3 - 0.2 * elapsed) * xpStreakMultiplier(score);
    sfx.correct(score);
    $('score').textContent = score;
    caosItemA = caosNextPairA;
    caosItemB = caosNextPairB;
    duration *= 0.95;
    newCaosRound(false);
  } else {
    sfx.wrong();
    gameOver(T[state.lang].reason_wrong);
  }
}

function newRound(first) {
  if (mode === 'trio') return newTrioRound(first);
  if (mode === 'caos') return newCaosRound(first);
  const pool = poolFor(mode);
  nextTarget = pick(pool);
  const others = shuffle(pool.filter(c => c !== target)).slice(0, SQUARES - 1);
  const items = shuffle([target, ...others]); // clássico: fundos | reverso: palavras | formas: ícones
  const distractors = shuffle(pool.filter(c => c !== nextTarget)).slice(0, SQUARES - 1);
  let d = 0;

  const grid = $('grid');
  grid.innerHTML = '';
  // "foto" desta rodada pra tela de replay — cada quadrado na MESMA ordem em
  // que é exibido (ver poolItemId/replayRounds lá em cima); só isso já basta
  // pra reconstruir o tabuleiro inteiro depois, sem precisar re-sortear nada
  const roundSnapshot = [];
  items.forEach(item => {
    const paired = (item === target) ? nextTarget : distractors[d++];
    roundSnapshot.push({ id: poolItemId(item), paired: poolItemId(paired), isTarget: item === target });
    const el = document.createElement('div');
    el.className = 'square';
    if (mode === 'shapes' || mode === 'shapes-reverse') {
      // formas: shapeSide = qual delas vira a silhueta do azulejo | wordSide = qual delas tem o nome escrito
      const shapeSide = (mode === 'shapes') ? item : paired;
      const wordSide  = (mode === 'shapes') ? paired : item;
      el.classList.add('shape-square', shapeSide.shapeClass);
      el.innerHTML = `<span class="shape-fill ${shapeSide.shapeClass}"></span><span class="word">${cName(wordSide)}</span>`;
    } else {
      const bg   = (mode === 'classic') ? item : paired;
      const word = (mode === 'classic') ? paired : item;
      el.style.background = bg.hex;
      el.style.boxShadow = `0 0 18px ${bg.hex}99, 0 0 40px ${bg.hex}55, inset 0 0 20px rgba(255,255,255,0.12)`;
      el.innerHTML = `<span class="word">${cName(word)}</span>`;
    }
    el.onclick = (e) => handleClick(item, e);
    grid.appendChild(el);
  });
  // "t" é o instante (relativo a replayStartMs) em que ESTA rodada apareceu
  // na tela — é o que a tela de replay usa pra saber quando trocar de
  // rodada e sincronizar com o rastro do mouse (ver renderReplayFrame)
  if (replayRounds.length < 400) replayRounds.push({ t: Math.round(performance.now() - replayStartMs), sq: roundSnapshot }); // teto de sanidade — mesma ideia do HARD_SCORE_CAP do servidor

  const INSTR_FIRST = {
    classic: () => T[state.lang].instr_first_classic(cName(target)),
    reverse: () => T[state.lang].instr_first_reverse(cName(target)),
    shapes: () => T[state.lang].instr_first_shapes(cName(target)),
    'shapes-reverse': () => T[state.lang].instr_first_shapes_reverse(cName(target)),
  };
  const INSTR_NEXT = {
    classic: T[state.lang].instr_next_classic,
    reverse: T[state.lang].instr_next_reverse,
    shapes: T[state.lang].instr_next_shapes,
    'shapes-reverse': T[state.lang].instr_next_shapes_reverse,
  };
  $('instruction').textContent = first ? INSTR_FIRST[mode]() : INSTR_NEXT[mode];
  $('speed').textContent = `⏱️ ${(duration / 1000).toFixed(1)}s`;

  startTimer();
}

function startTimer() {
  cancelAnimationFrame(rafId);
  timerStart = performance.now();
  let lastTick = 0;
  const tick = now => {
    if (!playing) return;
    const left = 1 - (now - timerStart) / duration;
    $('timer-fill').style.width = Math.max(0, left * 100) + '%';
    if (left <= 0) { sfx.timeout(); return gameOver(T[state.lang].reason_timeout); }
    if (left < 0.35 && now - lastTick > 250) { lastTick = now; sfx.tick(); } // tic-tac no fim do tempo
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function handleClick(item, e) {
  if (!playing) return;
  if (item === target) {
    score++;
    if (state.currentSessionId) pendingRoundSync.push(callSyncProgress({ sessionId: state.currentSessionId, trusted: !e || e.isTrusted }).catch(() => {}));
    // XP da rodada: quanto mais rápido acertar, mais ganha — e quanto mais longa a sequência, maior o bônus
    const elapsed = (performance.now() - timerStart) / 1000;
    xpGain += Math.max(0, 3 - 0.2 * elapsed) * xpStreakMultiplier(score);
    sfx.correct(score);
    $('score').textContent = score;
    target = nextTarget;
    duration *= 0.95;
    newRound(false);
  } else {
    sfx.wrong();
    gameOver(T[state.lang].reason_wrong);
  }
}

// trava (ou destrava) os botões de ação da tela de fim de jogo — usado
// enquanto o placar ainda está sendo confirmado com o servidor, pra ninguém
// clicar "jogar de novo"/"menu"/"compartilhar" no meio da conta (ver
// gameOver abaixo)
function setOverButtonsEnabled(enabled) {
  document.querySelectorAll('#over-screen .btn-row button, #signup-cta').forEach(b => { b.disabled = !enabled; });
}

async function gameOver(reason) {
  playing = false;
  cancelAnimationFrame(rafId);
  const record = myRecord(mode);
  const isNewRecord = score > record;
  // XP só pra quem está logado com conta
  const xpEarned = (!state.offline && state.currentUser && state.myData.nick) ? Math.round(xpGain) : 0;
  const xpBefore = myXp();
  const xpAfter = xpBefore + xpEarned;
  const leveledUp = levelFromXp(xpAfter) > levelFromXp(xpBefore);
  track('game_over', { mode, score, new_record: isNewRecord, xp_earned: xpEarned });

  $('over-reason').textContent = reason;
  $('final-score').textContent = score;
  $('record-over').textContent = Math.max(score, record);
  $('new-record').classList.toggle('show', isNewRecord);
  $('sync-status').textContent = '';
  $('share-status').textContent = '';
  if (isNewRecord) { sfx.record(); spawnConfetti(); }
  show('over-screen');

  // trava os botões e espera os sinais de progresso desta partida
  // "assentarem" no servidor (ver pendingRoundSync/callSyncProgress)
  // antes de mandar o resultado final — fecha a corrida entre o envio final
  // chegar antes de algum sinal ainda em trânsito pela rede
  setOverButtonsEnabled(false);
  if (!state.offline && state.currentUser && state.myData.nick) $('sync-status').textContent = T[state.lang].sync_calculating;
  await Promise.allSettled(pendingRoundSync);
  pendingRoundSync = [];
  $('sync-status').textContent = ''; // volta a ficar vazio — persistGameResult decide se mostra sucesso/erro

  // XP ganho + animação da barra subindo
  if (xpEarned > 0) {
    $('xp-gain').style.display = '';
    $('over-xp-wrap').style.display = '';
    animateXpGain(xpEarned, xpBefore, xpAfter, leveledUp);
  } else {
    $('xp-gain').style.display = 'none';
    $('over-xp-wrap').style.display = 'none';
  }

  if (state.offline) {
    if (isNewRecord) setLocalRecord(mode, score);
  } else if (state.currentUser && state.myData.nick) {
    await persistGameResult(xpEarned);
  }
  setOverButtonsEnabled(true);

  // convite para quem joga sem conta
  $('signup-cta').style.display = 'none';
  if (state.offline && score > 0) {
    state.pendingScore = { mode, score };
    $('signup-cta').style.display = '';
  }

  renderMiniRankings(mode, score);
}

// anima o número de XP subindo e a barra de progresso enchendo (com virada de nível se houver)
function animateXpGain(earned, before, after, leveledUp) {
  const durMs = 1100;
  const start = performance.now();
  const numEl = $('xp-gain-num');
  const lvEl = $('over-xp-lv');
  const numsEl = $('over-xp-nums');
  const fillEl = $('over-xp-fill');
  fillEl.style.transition = 'none'; // a animação aqui é frame a frame

  const step = now => {
    const t = Math.min(1, (now - start) / durMs);
    const eased = 1 - Math.pow(1 - t, 3); // desacelera no final
    const xpNow = Math.round(before + (after - before) * eased);
    const xi = xpInfo(xpNow);
    numEl.textContent = Math.round(earned * eased);
    lvEl.textContent = `Lv ${xi.lv}`;
    numsEl.textContent = `${xi.into}/${xi.need}`;
    fillEl.style.width = Math.min(100, (xi.into / xi.need) * 100) + '%';
    if (t < 1) requestAnimationFrame(step);
    else if (leveledUp) showLevelUp(levelFromXp(after));
  };
  requestAnimationFrame(step);
}

function showLevelUp(newLv) {
  track('level_up', { level: newLv });
  $('levelup-title').textContent = T[state.lang].levelup_title;
  $('levelup-lv').textContent = `Lv ${newLv}`;
  $('levelup-banner').classList.add('show');
  sfx.levelUp();
  setTimeout(() => $('levelup-banner').classList.remove('show'), 3200);
}
window.dismissLevelUp = () => $('levelup-banner').classList.remove('show');

async function persistGameResult(xpEarned = 0) {
  // a pontuação final agora é validada no servidor (Cloud Function), que checa
  // se o tempo real de jogo é compatível com a pontuação alegada antes de gravar.
  if (!state.currentSessionId) {
    // sem sessão validada (ex.: caiu a internet bem no início da partida) —
    // não há como confirmar no servidor, então não grava essa partida.
    $('sync-status').textContent = T[state.lang].sync_fail;
    return;
  }
  const sessionId = state.currentSessionId;
  state.currentSessionId = null; // cada sessão só pode ser usada uma vez

  try {
    const res = await callSubmitResult({ sessionId, mode, score, xpGain: xpEarned });
    const d = res.data || {};
    state.myData.lastPlayedDate = todayStr();
    state.myData.currentStreak = d.currentStreak;
    state.myData.bestStreak = d.bestStreak;
    state.myData.gamesPlayed = (state.myData.gamesPlayed || 0) + 1;
    state.myData.totalPoints = (state.myData.totalPoints || 0) + score;
    state.myData.xp = (state.myData.xp || 0) + xpEarned;
    state.myData[PLAYED_FIELD[mode]] = true;
    if (d.isNewRecord) {
      state.myData[mode] = score;
      // servidor grava [mode]+"At" com serverTimestamp() (ver submitGameResult em
      // functions/index.js), mas o valor resolvido não volta na resposta — sem
      // atualizar isso aqui, o ranking de prévia (mini-ranking do fim de jogo)
      // ordenava o empate usando o carimbo do recorde ANTERIOR (ou nenhum),
      // não o de agora, e o critério "quem fez primeiro" saía errado bem na
      // hora que mais importa: logo após bater um recorde novo
      state.myData[mode + 'At'] = Timestamp.now();
      if (d.total !== undefined) { state.myData.total = d.total; state.myData.totalAt = Timestamp.now(); } // mesmo motivo, pro ranking "Geral" (soma dos recordes)
      $('sync-status').textContent = T[state.lang].sync_success;
      // sobe o "filme" da partida (ver replayRounds/replayMouse lá em cima)
      // só agora que virou recorde — em segundo plano, não atrasa a tela de
      // resultado. state.myData[mode+'ReplaySessionId'] atualiza na hora, sem
      // esperar o próximo carregamento do ranking, mesmo motivo do +'At' acima
      state.myData[mode + 'ReplaySessionId'] = sessionId;
      saveMatchReplayWithRetry({ sessionId, mode, rounds: replayRounds, mouseTrail: replayMouse }).catch(() => {}); // já logou dentro; aqui só evita unhandled rejection
    }
  } catch (e) {
    $('sync-status').textContent = T[state.lang].sync_fail;
  }
}

/* ================== ranking ================== */
// backTarget (2º parâmetro) é opcional — vira 'menu-screen' na pilha (ver
// pushScreenAndShow) pra quem abre ranking direto do menu (cards de modo,
// atalho "🏆 RANKING" etc.); profileRankGoto passa 'profile-screen' quando
// abre a partir do perfil de alguém.
window.showRanking = (tab, backTarget) => {
  pushScreenAndShow('ranking-screen', backTarget);
  window.loadRanking(tab || mode || 'classic'); // abre na aba pedida, ou no modo que a pessoa estava jogando
};


/* ================== desafio diário — tela, cronômetro, jogo, caixa de entrada ==================
   Mesmo esquema de validação do resto do jogo (sessão emitida pelo servidor,
   validada no fim contra o tempo decorrido), mas com uma diferença central:
   as cores de cada rodada saem de um gerador DETERMINÍSTICO (seededPick/
   seededShuffle, semeado pela data do dia — ver hashSeed/mulberry32 lá em
   cima), então todo mundo joga exatamente a mesma sequência no mesmo dia. */

// cronômetro do desafio — mora no CARD do menu (não numa tela separada). Roda
// pra sempre em segundo plano (mesmo padrão do heartbeat de atividade), só
// atualiza um texto pequeno a cada segundo — não pesa nada ficar rodando
// mesmo fora do menu.
let dailyCardTicker = null;
function startDailyCardTicker() {
  if (dailyCardTicker) return;
  renderDailyCardCountdown();
  dailyCardTicker = setInterval(renderDailyCardCountdown, 1000);
}
// detecta a TROCA DE FASE do desafio (não só "o relógio chegou em zero") —
// ver comentário dentro de renderDailyCardCountdown pra entender por que
// isso importa mais do que parece
let dailyCardLastPhaseKey = null;
function renderDailyCardCountdown() {
  const live = isDailyChallengeLive();
  // dentro da janela 00:00–00:05 (ver isDailyStartDelay), o desafio de hoje
  // ainda não abriu mesmo já tendo estreado — mostra "Inicia em" contando
  // pra dailyTodayStartsAtMs() em vez de "Termina em"
  const startDelay = live && isDailyStartDelay();
  const targetMs = !live ? dailyLaunchAtMs() : startDelay ? dailyTodayStartsAtMs() : dailyNextMidnightSaoPauloMs();
  let msLeft = targetMs - Date.now();
  if (msLeft < 0) msLeft = 0;
  const h = Math.floor(msLeft / 3600000);
  const m = Math.floor((msLeft % 3600000) / 60000);
  const s = Math.floor((msLeft % 60000) / 1000);
  const label = (!live || startDelay) ? T[state.lang].daily_starts_in : T[state.lang].daily_ends_in;
  const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  // atualiza os DOIS lugares que mostram esse cronômetro (card do menu e a
  // tela de introdução do desafio) — mesma informação nos dois, só muda
  // onde está visível na hora
  [['daily-card-countdown', 'daily-card-countdown-label'], ['daily-intro-countdown', 'daily-intro-countdown-label']].forEach(([elId, labelId]) => {
    const el = $(elId);
    const labelEl = $(labelId);
    const timeEl = el && el.querySelector('.daily-badge-time');
    if (!el || !timeEl || !labelEl) return;
    labelEl.textContent = label;
    timeEl.textContent = timeStr;
  });

  // antes, o refresh do resto do card (coming-soon/lock/descrição — ver
  // updateDailyMenuCard) só disparava quando msLeft cruzava 0. Isso só pega
  // a virada das 00:00 (fim de "hoje" -> começo do atraso de 5min do dia
  // seguinte): targetMs conta até ali e realmente zera nesse instante. Já a
  // virada das 00:05 (fim do atraso -> desafio libera de vez) NUNCA zera
  // esse cálculo — assim que isDailyStartDelay() vira false, targetMs pula
  // direto pra "próxima meia-noite" (um número bem maior), então msLeft
  // nunca passa por 0 ali. Resultado: o card ficava "congelado" parecendo
  // bloqueado mesmo já liberado, até a pessoa sair do menu e voltar (só aí
  // showMenu() força um updateDailyMenuCard() por fora). Comparando a fase
  // inteira (live+startDelay) em vez de só "zerou", as duas viradas passam a
  // disparar o refresh igual.
  const phaseKey = `${live}|${startDelay}`;
  const phaseChanged = dailyCardLastPhaseKey !== null && dailyCardLastPhaseKey !== phaseKey;
  dailyCardLastPhaseKey = phaseKey;
  if (phaseChanged && $('menu-screen').classList.contains('active')) updateDailyMenuCard();
}
startDailyCardTicker();

// resiliência contra o navegador/app pausar o setInterval acima quando a aba
// fica em segundo plano ou a tela é bloqueada — comportamento padrão de todo
// navegador moderno (inclusive dentro do WebView do app nativo iOS/Android,
// que suspende timers JS pra economizar bateria). Sem isso, quem atravessa
// 00:00 ou 00:05 com o app em segundo plano só via o card se corrigir
// quando/se o setInterval decidisse tiquetar de novo por conta própria — o
// que podia demorar bastante (ou nunca acontecer sozinho enquanto a aba não
// voltasse ao primeiro plano). Ao voltar — trocar de aba, desbloquear a
// tela, alternar de app e voltar — força um recálculo na hora, sem precisar
// recarregar a página nem reiniciar o app: visibilitychange/focus cobrem o
// caso normal, pageshow cobre a página voltando do cache de navegação
// (botão voltar/avançar do histórico).
function refreshDailyCardOnResume() { renderDailyCardCountdown(); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDailyCardOnResume(); });
window.addEventListener('focus', refreshDailyCardOnResume);
window.addEventListener('pageshow', refreshDailyCardOnResume);

// clique no card do menu: antes da estreia não faz nada (o card fica só de
// enfeite/curiosidade); depois, se ainda sobra tentativa vai direto pro jogo
// (sem tela intermediária); se já usou as 3, manda pra caixa de entrada/
// ranking do desafio, que é a informação útil nesse caso
window.dailyCardClick = () => {
  if (!isDailyChallengeLive() || isDailyStartDelay() || !dailyLevelUnlocked()) return;
  if (state.offline || !state.currentUser || !state.myData.nick) { goSignup(); return; }
  if (blockIfBanned()) return; // conta suspensa não joga nenhum modo
  if (dailyAttemptsUsed >= DAILY_MAX_ATTEMPTS) {
    $('daily-blocked-msg').textContent = T[state.lang].daily_blocked_msg;
    $('daily-intro').style.display = 'none';
    $('daily-play').style.display = 'none';
    $('daily-result').style.display = 'none';
    $('daily-blocked').style.display = 'flex';
    show('daily-screen');
    return;
  }
  showDailyIntro();
};

// tela de introdução: mostra qual modo foi sorteado pra hoje (mesmo se a
// pessoa não tiver nível pra jogar esse modo no menu normal — o desafio
// diário sempre valeu pra qualquer nível) + as instruções de como jogar +
// atalho pro tutorial passo a passo. O botão de tutorial e o de "iniciar"
// aqui usam handlers atribuídos na hora (não inline no HTML) porque este é
// um <script type="module"> — atributos onclick inline só enxergam
// identificadores expostos em window, e dailyMode/startTutorial/etc. não
// precisam virar globais só por causa disso.
window.showDailyIntro = () => {
  dailyMode = dailyModeForToday(dailyLocalDateStr());
  // as chaves de i18n usam "_" (mode_shapes_reverse_title), não "-" como o id
  // do modo (shapes-reverse) — só o "shapes-reverse" precisa dessa troca
  const modeKey = dailyMode.replace(/-/g, '_');
  $('daily-intro-mode-title').innerHTML = T[state.lang][`mode_${modeKey}_title`];
  $('daily-intro-mode-desc').innerHTML = T[state.lang][`mode_${modeKey}_desc`];
  $('daily-intro-attempts').textContent = T[state.lang].daily_card_attempts(DAILY_MAX_ATTEMPTS - dailyAttemptsUsed, DAILY_MAX_ATTEMPTS);
  $('daily-intro-best').textContent = dailyBestScore;
  renderDailyCardCountdown(); // atualiza o cronômetro na hora, sem esperar o próximo tique do segundo
  $('daily-intro-tut-btn').onclick = () => window.startTutorial(dailyMode, { fromDaily: true });
  $('daily-intro-start-btn').onclick = () => startDailyChallenge();
  $('daily-countdown').style.display = 'none';
  $('daily-play').style.display = 'none';
  $('daily-result').style.display = 'none';
  $('daily-blocked').style.display = 'none';
  $('daily-intro').style.display = 'flex';
  show('daily-screen');
};

/* -------- caixa de entrada (comunicados do jogo) --------
   Por enquanto só existe um tipo de mensagem (prêmio do desafio diário, salvo
   em dailyInbox/{uid}/messages), mas o ícone/popup já são genéricos pra caber
   qualquer aviso futuro do jogo, não só do desafio diário. */
window.showInbox = async () => {
  if (state.offline || !state.currentUser) return;
  $('inbox-modal').style.display = 'flex';
  await loadInbox();
};
window.closeInbox = () => {
  $('inbox-modal').style.display = 'none';
};
async function loadInbox() {
  if (state.offline || !state.currentUser) return;
  try {
    const snap = await getDocs(collection(db, 'dailyInbox', state.currentUser.uid, 'messages'));
    const msgs = [];
    snap.forEach(d => msgs.push({ id: d.id, ...d.data() }));
    msgs.sort((a, b) => (b.dateStr || '').localeCompare(a.dateStr || ''));
    renderInboxList(msgs);
  } catch {
    renderInboxList([]);
  }
}
function renderInboxList(msgs) {
  const list = $('inbox-list');
  const allBtn = $('inbox-claim-all-btn');
  $('inbox-status').textContent = '';
  if (msgs.length === 0) {
    list.innerHTML = `<div class="muted" style="text-align:center;">${T[state.lang].inbox_empty}</div>`;
    allBtn.style.display = 'none';
    return;
  }
  // mensagens já resgatadas continuam na lista como histórico — o botão
  // "resgatar todas" só deve contar quem ainda está pendente
  const pendingCount = msgs.filter(m => !m.claimed).length;
  allBtn.style.display = pendingCount > 1 ? '' : 'none';
  list.innerHTML = '';
  msgs.forEach(msg => {
    const pos = msg.position;
    const posLabel = pos === 1 ? T[state.lang].daily_pos_1 : pos === 2 ? T[state.lang].daily_pos_2 : pos === 3 ? T[state.lang].daily_pos_3 : T[state.lang].daily_pos_n(pos);
    const box = document.createElement('div');
    box.className = 'daily-inbox-msg';
    if (msg.claimed) box.style.opacity = '0.6';

    const posLine = document.createElement('div');
    posLine.className = 'pos-line';
    posLine.textContent = T[state.lang].daily_inbox_congrats(posLabel, formatDailyDateShort(msg.dateStr), msg.score);
    box.appendChild(posLine);

    const claimRow = document.createElement('div');
    claimRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px;';
    const coinsSpan = document.createElement('span');
    coinsSpan.style.cssText = 'display:flex; align-items:center; gap:4px; font-weight:700;';
    coinsSpan.insertAdjacentHTML('beforeend', pigmentIconSvg(16));
    const coinsNum = document.createElement('span');
    coinsNum.textContent = `+${msg.coins}`;
    coinsSpan.appendChild(coinsNum);
    claimRow.appendChild(coinsSpan);

    if (msg.claimed) {
      const claimedLabel = document.createElement('span');
      claimedLabel.className = 'muted';
      claimedLabel.style.fontWeight = '700';
      claimedLabel.textContent = T[state.lang].daily_reward_claimed_label;
      claimRow.appendChild(claimedLabel);
    } else {
      const claimBtn = document.createElement('button');
      claimBtn.className = 'secondary';
      claimBtn.textContent = T[state.lang].btn_claim;
      claimBtn.onclick = () => claimOneDailyReward(msg.dateStr);
      claimRow.appendChild(claimBtn);
    }

    box.appendChild(claimRow);
    list.appendChild(box);
  });
}
// bolinha de notificação no ícone 📬 do menu — mesma ideia da de pedido de
// amizade pendente (menu-quick-friends-badge); conta quantas mensagens ainda
// não foram resgatadas
async function refreshInboxBadge() {
  const btn = $('inbox-btn');
  if (state.offline || !state.currentUser || !state.myData.nick) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  try {
    // só conta o que ainda não foi resgatado — mensagens já lidas continuam
    // na caixa de entrada como histórico, mas não devem inflar a bolinha
    const snap = await getDocs(query(collection(db, 'dailyInbox', state.currentUser.uid, 'messages'), where('claimed', '==', false)));
    const badge = $('inbox-badge');
    badge.textContent = snap.size;
    badge.style.display = snap.size > 0 ? '' : 'none';
  } catch {}
}
window.claimOneDailyReward = async (dateStr) => {
  try {
    const res = await callClaimDailyReward({ dateStr });
    const coins = (res.data && res.data.coins) || 0;
    if (coins > 0) state.myData.pigmentos = (state.myData.pigmentos || 0) + coins;
    await loadInbox();
    refreshInboxBadge();
    updateDailyMenuCard();
    renderMenuPigmentosBar();
    renderUserPigmentos();
  } catch (e) {
    $('inbox-status').textContent = e.message || T[state.lang].daily_claim_error;
  }
};
window.claimAllDailyRewards = async () => {
  try {
    const res = await callClaimDailyReward({});
    const coins = (res.data && res.data.coins) || 0;
    if (coins > 0) state.myData.pigmentos = (state.myData.pigmentos || 0) + coins;
    await loadInbox();
    refreshInboxBadge();
    updateDailyMenuCard();
    renderMenuPigmentosBar();
    renderUserPigmentos();
  } catch (e) {
    $('inbox-status').textContent = e.message || T[state.lang].daily_claim_error;
  }
};

// atualiza o card do menu — melhor pontuação, tentativas restantes e aviso de
// prêmio pendente na caixa de entrada (chamado pelo showMenu())
async function updateDailyMenuCard() {
  const card = $('card-daily');
  if (!card) return;
  if (state.offline || !state.currentUser || !state.myData.nick) { card.style.display = 'none'; return; }
  card.style.display = '';
  renderDailyCardCountdown(); // atualiza o rótulo (Inicia em/Termina em) na hora, sem esperar o próximo tique

  // antes da estreia (ou pra quem ainda tá no nível 1): só título + cronômetro,
  // sem descrição nem dados — deixa a curiosidade no ar em vez de mostrar tudo.
  // Quando o motivo for nível baixo (não a estreia ainda não ter chegado),
  // mostra o mesmo aviso de "🔒 Desbloqueia no nível N" que os modos
  // Reverso/Formas/Formas Reverso já usam (ver lock-reverse/lock-shapes).
  const lockEl = $('lock-daily');
  if (!isDailyChallengeLive() || isDailyStartDelay() || !dailyLevelUnlocked()) {
    card.classList.add('coming-soon');
    $('daily-card-desc').style.display = 'none';
    $('daily-card-footer').style.display = 'none';
    const showLock = !dailyLevelUnlocked();
    card.classList.toggle('level-locked', showLock);
    if (lockEl) {
      lockEl.style.display = showLock ? '' : 'none';
      if (showLock) lockEl.textContent = T[state.lang].unlock_at(DAILY_MIN_LEVEL);
    }
    return;
  }
  card.classList.remove('coming-soon', 'level-locked');
  if (lockEl) lockEl.style.display = 'none';
  $('daily-card-desc').style.display = '';
  $('daily-card-footer').style.display = '';
  try {
    const dateStr = dailyLocalDateStr();
    const snap = await getDoc(doc(db, 'dailyScores', `${dateStr}_${state.currentUser.uid}`));
    const data = snap.exists() ? snap.data() : {};
    dailyAttemptsUsed = data.attempts || 0;
    dailyBestScore = data.bestScore || 0;
  } catch {
    dailyAttemptsUsed = 0;
    dailyBestScore = 0;
  }
  $('daily-card-best').textContent = T[state.lang].daily_card_best(dailyBestScore);
  $('daily-card-attempts').textContent = (dailyAttemptsUsed >= DAILY_MAX_ATTEMPTS)
    ? T[state.lang].daily_card_already_played
    : T[state.lang].daily_card_attempts(DAILY_MAX_ATTEMPTS - dailyAttemptsUsed, DAILY_MAX_ATTEMPTS);
}

/* -------- jogo do desafio (mesmo modo Clássico, RNG determinística) -------- */
window.startDailyChallenge = async () => {
  if (state.offline || !state.currentUser || !state.myData.nick) { goSignup(); return; }
  if (!(await isDailyClientUpToDate())) {
    $('daily-blocked-msg').textContent = T[state.lang].daily_update_required;
    $('daily-intro').style.display = 'none';
    $('daily-play').style.display = 'none';
    $('daily-result').style.display = 'none';
    $('daily-blocked').style.display = 'flex';
    show('daily-screen');
    return;
  }
  try {
    const res = await callStartDailyAttempt();
    const d = res.data || {};
    dailySessionId = d.sessionId;
    dailyDateStrCache = d.dateStr;
    dailyClosesAtMs = d.closesAt;
    dailyAttemptsUsed = d.attemptNumber;
    // o modo já foi sorteado (e mostrado) na tela de introdução, mas recalcula
    // aqui de novo (mesma conta determinística — ver dailyModeForToday) pro
    // caso de "jogar de novo" a 2ª/3ª tentativa direto do resultado, sem
    // passar pela introdução de novo
    dailyMode = dailyModeForToday(d.dateStr);
    track('daily_start', { attempt: d.attemptNumber, mode: dailyMode });

    dailyRng = mulberry32(hashSeed(d.dateStr + '|daily-v2|' + dailyMode + '|attempt' + d.attemptNumber + '|salt' + (d.seedSalt || '')));
    dailyScore = 0;
    dailyDuration = 10000;
    dailyPlaying = true;
    dailyTarget = seededPick(dailyRng, dailyPoolFor(dailyMode));
    $('daily-score').textContent = 0;
    $('daily-intro').style.display = 'none';
    $('daily-result').style.display = 'none';
    $('daily-blocked').style.display = 'none';
    $('daily-play').style.display = 'none';
    show('daily-screen');
    startDailyCountdown(() => {
      $('daily-play').style.display = 'flex';
      // o tabuleiro libera AGORA — a contagem regressiva não deve entrar na
      // conta de tempo de jogo, então recarimba o início real da tentativa
      // neste instante (dispara e esquece, não atrasa a rodada em nada; ver
      // dailyPendingRoundSync/callArmDailySession)
      if (dailySessionId) dailyPendingRoundSync.push(callArmDailySession({ sessionId: dailySessionId }).catch(() => {}));
      // o replay também começa a contar só a partir daqui (mesmo motivo do
      // recarimbo acima) — ver dailyReplayRounds/dailyReplayMouse lá em cima
      dailyReplayRounds = [];
      dailyReplayMouse = [];
      dailyReplayStartMs = performance.now();
      dailyNewRound(true);
    });
  } catch (e) {
    // sem tentativas hoje (ou outro erro) — não tem uma tela de lobby pra
    // mostrar a mensagem, então manda pra tela de "sem tentativas", que já
    // tem o link pro ranking do desafio
    $('daily-blocked-msg').textContent = e.message || T[state.lang].daily_start_error;
    $('daily-intro').style.display = 'none';
    $('daily-play').style.display = 'none';
    $('daily-result').style.display = 'none';
    $('daily-blocked').style.display = 'flex';
    show('daily-screen');
  }
};

// mostra "3, 2, 1, Vai!" antes de liberar o tabuleiro pra pessoa se preparar
// (mesma ideia visual/sonora do duelo PvP). Diferente do PvP, aqui não tem
// servidor pra sincronizar dois jogadores — é uma pessoa só, então a
// contagem em si roda 100% local (performance.now/requestAnimationFrame).
// Só no fim, quando o tabuleiro libera de vez, é que dispara a chamada pro
// servidor recarimbar o início real da tentativa (ver callArmDailySession
// no onDone do startDailyCountdown, mais abaixo).
const DAILY_COUNTDOWN_MS = 3000;
function startDailyCountdown(onDone) {
  stopDailyCountdown();
  const startedMs = performance.now();
  let lastNum = null;
  $('daily-countdown').style.display = '';
  function tick() {
    const remaining = DAILY_COUNTDOWN_MS - (performance.now() - startedMs);
    if (remaining <= 0) {
      $('daily-countdown-num').textContent = T[state.lang].pvp_go;
      if (lastNum !== 'go') { lastNum = 'go'; sfx.countdown(true); }
      dailyCountdownTimerId = setTimeout(() => {
        $('daily-countdown').style.display = 'none';
        dailyCountdownTimerId = null;
        onDone();
      }, 400);
      return;
    }
    const num = Math.max(1, Math.ceil(remaining / 1000));
    $('daily-countdown-num').textContent = String(num);
    if (lastNum !== num) { lastNum = num; sfx.countdown(false); }
    dailyCountdownTimerId = requestAnimationFrame(tick);
  }
  dailyCountdownTimerId = requestAnimationFrame(tick);
}
function stopDailyCountdown() {
  if (dailyCountdownTimerId) {
    cancelAnimationFrame(dailyCountdownTimerId);
    clearTimeout(dailyCountdownTimerId);
    dailyCountdownTimerId = null;
  }
  $('daily-countdown').style.display = 'none';
}

function dailyNewRound(first) {
  const pool = dailyPoolFor(dailyMode);
  dailyNextTarget = seededPick(dailyRng, pool);
  const others = seededShuffle(dailyRng, pool.filter(c => c !== dailyTarget)).slice(0, SQUARES - 1);
  const items = seededShuffle(dailyRng, [dailyTarget, ...others]); // clássico: fundos | reverso: palavras | formas: ícones
  const distractors = seededShuffle(dailyRng, pool.filter(c => c !== dailyNextTarget)).slice(0, SQUARES - 1);
  let d = 0;

  const grid = $('daily-grid');
  grid.innerHTML = '';
  // mesma ideia de "foto" da rodada que newRound() grava (ver comentário lá)
  const roundSnapshot = [];
  items.forEach(item => {
    const paired = (item === dailyTarget) ? dailyNextTarget : distractors[d++];
    roundSnapshot.push({ id: poolItemId(item), paired: poolItemId(paired), isTarget: item === dailyTarget });
    const el = document.createElement('div');
    el.className = 'square';
    if (dailyMode === 'shapes' || dailyMode === 'shapes-reverse') {
      const shapeSide = (dailyMode === 'shapes') ? item : paired;
      const wordSide  = (dailyMode === 'shapes') ? paired : item;
      el.classList.add('shape-square', shapeSide.shapeClass);
      el.innerHTML = `<span class="shape-fill ${shapeSide.shapeClass}"></span><span class="word">${cName(wordSide)}</span>`;
    } else {
      const bg   = (dailyMode === 'classic') ? item : paired;
      const word = (dailyMode === 'classic') ? paired : item;
      el.style.background = bg.pattern || bg.hex; // "zebra" (só no desafio diário) usa listras em vez de hex sólido
      el.style.boxShadow = `0 0 18px ${bg.hex}99, 0 0 40px ${bg.hex}55, inset 0 0 20px rgba(255,255,255,0.12)`;
      el.innerHTML = `<span class="word">${cName(word)}</span>`;
    }
    el.onclick = (e) => dailyHandleClick(item, e);
    grid.appendChild(el);
  });
  if (dailyReplayRounds.length < 400) dailyReplayRounds.push({ t: Math.round(performance.now() - dailyReplayStartMs), sq: roundSnapshot });

  const INSTR_FIRST = {
    classic: () => T[state.lang].instr_first_classic(cName(dailyTarget)),
    reverse: () => T[state.lang].instr_first_reverse(cName(dailyTarget)),
    shapes: () => T[state.lang].instr_first_shapes(cName(dailyTarget)),
    'shapes-reverse': () => T[state.lang].instr_first_shapes_reverse(cName(dailyTarget)),
  };
  const INSTR_NEXT = {
    classic: T[state.lang].instr_next_classic,
    reverse: T[state.lang].instr_next_reverse,
    shapes: T[state.lang].instr_next_shapes,
    'shapes-reverse': T[state.lang].instr_next_shapes_reverse,
  };
  $('daily-instruction').textContent = first ? INSTR_FIRST[dailyMode]() : INSTR_NEXT[dailyMode];
  $('daily-speed').textContent = `⏱️ ${(dailyDuration / 1000).toFixed(1)}s`;
  startDailyTimer();
}

function startDailyTimer() {
  cancelAnimationFrame(dailyRafId);
  dailyTimerStart = performance.now();
  let lastTick = 0;
  const tick = now => {
    if (!dailyPlaying) return;
    const left = 1 - (now - dailyTimerStart) / dailyDuration;
    $('daily-timer-fill').style.width = Math.max(0, left * 100) + '%';
    if (left <= 0) { sfx.timeout(); return dailyGameOver(T[state.lang].reason_timeout); }
    if (left < 0.35 && now - lastTick > 250) { lastTick = now; sfx.tick(); }
    dailyRafId = requestAnimationFrame(tick);
  };
  dailyRafId = requestAnimationFrame(tick);
}

function dailyHandleClick(item, e) {
  if (!dailyPlaying) return;
  if (item === dailyTarget) {
    dailyScore++;
    if (dailySessionId) dailyPendingRoundSync.push(callSyncProgress({ sessionId: dailySessionId, trusted: !e || e.isTrusted }).catch(() => {}));
    sfx.correct(dailyScore);
    $('daily-score').textContent = dailyScore;
    dailyTarget = dailyNextTarget;
    dailyDuration *= 0.95;
    dailyNewRound(false);
  } else {
    sfx.wrong();
    dailyGameOver(T[state.lang].reason_wrong);
  }
}

// mesma ideia de setOverButtonsEnabled (modo livre), pros botões da tela de
// resultado do desafio diário
function setDailyResultButtonsEnabled(enabled) {
  document.querySelectorAll('#daily-result .btn-row button').forEach(b => { b.disabled = !enabled; });
}

async function dailyGameOver(reason) {
  dailyPlaying = false;
  cancelAnimationFrame(dailyRafId);
  track('daily_over', { score: dailyScore });

  $('daily-result-reason').textContent = reason;
  $('daily-result-score').textContent = dailyScore;
  $('daily-play').style.display = 'none';
  $('daily-result').style.display = 'flex';
  $('daily-result-xp').style.display = 'none';
  resetScroll('daily-screen');

  // trava os botões e espera os sinais de progresso desta tentativa
  // "assentarem" no servidor antes de mandar o resultado final (mesma ideia
  // de gameOver no modo livre — ver comentário lá)
  setDailyResultButtonsEnabled(false);
  $('daily-result-attempts').textContent = T[state.lang].sync_calculating;
  await Promise.allSettled(dailyPendingRoundSync);
  dailyPendingRoundSync = [];

  let bestScore = Math.max(dailyScore, dailyBestScore);
  const lvBefore = levelFromXp(myXp());
  try {
    const res = await callSubmitDailyResult({ sessionId: dailySessionId, score: dailyScore });
    if (res.data && typeof res.data.bestScore === 'number') bestScore = res.data.bestScore;
    if (res.data && typeof res.data.xpEarned === 'number' && res.data.xpEarned > 0) {
      state.myData.xp = (state.myData.xp || 0) + res.data.xpEarned;
      $('daily-result-xp').textContent = T[state.lang].daily_xp_bonus(res.data.xpEarned);
      $('daily-result-xp').style.display = '';
      if (levelFromXp(myXp()) > lvBefore) sfx.levelUp();
    }
  } catch (e) {
    // não foi possível confirmar com o servidor — o placar oficial (ranking)
    // só considera o que o servidor validou; a tela ainda mostra o resultado local
  }
  if (dailyScore >= bestScore && dailyScore > 0 && dailyScore > dailyBestScore) {
    sfx.record(); spawnConfetti();
    // mesma ideia do modo livre (ver persistGameResult) — só sobe o "filme"
    // da tentativa quando ela vira a melhor pontuação do dia, em segundo
    // plano, sem atrasar a tela de resultado
    if (dailySessionId) saveMatchReplayWithRetry({ sessionId: dailySessionId, mode: dailyMode, kind: 'daily', rounds: dailyReplayRounds, mouseTrail: dailyReplayMouse }).catch(() => {}); // já logou dentro; aqui só evita unhandled rejection
  }
  dailyBestScore = bestScore;
  $('daily-result-best').textContent = dailyBestScore;

  const left = Math.max(0, DAILY_MAX_ATTEMPTS - dailyAttemptsUsed);
  $('daily-result-attempts').textContent = left > 0
    ? T[state.lang].daily_attempts_left_msg(left)
    : T[state.lang].daily_attempts_used_msg;
  $('daily-result-again-btn').style.display = left > 0 ? '' : 'none';
  setDailyResultButtonsEnabled(true);

  refreshInboxBadge(); // atualiza a bolinha do 📬 caso esse resultado tenha desbloqueado algo pendente
}

window.dailyExitScreen = () => {
  dailyPlaying = false;
  cancelAnimationFrame(dailyRafId);
  stopDailyCountdown();
  showMenu();
};

applyLanguage();

