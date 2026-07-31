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
  fetchMyFriendRequests, renderProfileFriendAction, showFriendActionError
} from './friends.js';

// chamadas ao servidor: a pontuação final agora é validada lá,
// não é mais um simples write direto no Firestore vindo do navegador.
const callStartSession = callable('startGameSession');
const callSubmitResult = callable('submitGameResult');
const callCreditReferral = callable('creditReferral');
const callSuggestFriendFromRef = callable('suggestFriendFromRef');
const callClaimPendingScore = callable('claimPendingScore');
const callRecomputeTotal = callable('recomputeMyTotal');
const callDeleteMyAccount = callable('deleteMyAccount');
// troca o authorization code do login com Apple por um refresh token que o
// servidor guarda pra poder revogar na exclusão de conta (exigência da Apple,
// ver doApple/registerAppleAuthCode mais abaixo e functions/index.js)
const callRegisterAppleAuthCode = httpsCallable(functions, 'registerAppleAuthCode');
// duelo ao vivo (PvP) — igual ao resto: quem decide o que aconteceu é sempre
// a function (o servidor), nunca o navegador direto
const callChallengeFriend = callable('challengeFriend');
const callRespondChallenge = callable('respondChallenge');
const callCancelChallenge = callable('cancelChallenge');
const callSubmitPvpAnswer = callable('submitPvpAnswer');
const callClaimTimeout = callable('claimTimeout');
const callForfeitMatch = callable('forfeitMatch');
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
// envia o "filme" (rodadas + rastro do mouse) de uma partida que acabou de
// bater recorde — ver replayRounds/replayMouse lá em cima e saveMatchReplay
// em functions/index.js. Só uma chamada, no fim da partida, com tudo junto
// (não é "dispare e esqueça" por evento como as de cima); não precisa do
// wrapper callable() porque não é um clique do usuário esperando resposta —
// roda em segundo plano enquanto a pessoa já está vendo a tela de resultado.
const callSaveMatchReplay = httpsCallable(functions, 'saveMatchReplay');
// tenta salvar o replay algumas vezes antes de desistir — cobre quedas de
// rede de um instante bem na hora que a partida termina (upload silencioso
// que nunca chega no servidor não deixa log nenhum, nem de erro, porque a
// function nem chega a rodar). Só re-tenta ERRO DE REDE (a chamada não
// chegou no servidor) — uma resposta {ok:false} de verdade (sessão não
// confere, modo inválido etc.) é determinística, re-tentar não muda nada.
async function saveMatchReplayWithRetry(payload, attemptsLeft = 3) {
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
// ferramentas de admin (só funcionam de verdade pra quem tem admin:true —
// ver requireAdmin em functions/index.js; qualquer outra conta que tentar
// chamar recebe permission-denied do servidor)
const callAdminGetUserDetails = callable('adminGetUserDetails');
const callAdminSetBanned = callable('adminSetBanned');
const callAdminResetScores = callable('adminResetScores');
const callAdminSetNick = callable('adminSetNick');
const callAdminSetXp = callable('adminSetXp');
const callBackfillPendingPigmentos = callable('backfillPendingPigmentos');
const callAdminRecomputeScoresSnapshot = callable('adminRecomputeScoresSnapshot');
const callBackfillReplayDurations = callable('backfillReplayDurations');
const callAdminGetFlaggedAccounts = callable('adminGetFlaggedAccounts');
const callAdminListPendingDeletions = callable('adminListPendingDeletions');
const callAdminCancelAccountDeletion = callable('adminCancelAccountDeletion');
const callAdminForcePurgeAccount = callable('adminForcePurgeAccount');
// desafio diário — mesmo esquema de sessão/validação de tempo do modo normal
// (ver startDailyAttempt/submitDailyResult em functions/index.js)
const callStartDailyAttempt = callable('startDailyAttempt');
const callSubmitDailyResult = callable('submitDailyResult');
const callClaimDailyReward = callable('claimDailyReward');
// loja de cosméticos (paga com Pigmentos)
const callBuyShopItem = callable('buyShopItem');
const callSetEquippedItem = callable('setEquippedItem');

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

/* ================== loja (cosméticos comprados com Pigmentos) ==================
   Catálogo espelha o de functions/index.js (preço/slot são conferidos de novo
   no servidor — o catálogo aqui é só pra desenhar a tela). "equipped*" abaixo
   são os cosméticos ativos AGORA nesta sessão — carregados de state.myData.equipped
   depois do login e aplicados em applyEquippedCosmetics(). */
const SHOP_ITEMS = [
  { id: 'sfx_splash',    slot: 'sfxCorrect', price: 30,  icon: '🎨', name: 'Som de Acerto: Splash de Tinta', desc: 'Troca o bipe de acerto por um "splash" de tinta.' },
  { id: 'sfx_8bit',      slot: 'sfxCorrect', price: 30,  icon: '👾', name: 'Som de Acerto: Retrô 8-bit',     desc: 'Um bipe estilo fliperama clássico.' },
  { id: 'sfx_bell',      slot: 'sfxCorrect', price: 30,  icon: '🔔', name: 'Som de Acerto: Sininho',         desc: 'Um "ding" de sino cristalino a cada acerto.' },
  { id: 'sfx_laser',     slot: 'sfxCorrect', price: 30,  icon: '🔫', name: 'Som de Acerto: Laser',           desc: 'Um tiro de laser sci-fi a cada acerto.' },
  { id: 'sfx_bubble',    slot: 'sfxCorrect', price: 30,  icon: '🫧', name: 'Som de Acerto: Bolha',           desc: 'Um "blip" de bolha estourando a cada acerto.' },
  { id: 'sfx_synth',     slot: 'sfxCorrect', price: 30,  icon: '🎹', name: 'Som de Acerto: Sintetizador',    desc: 'Um acorde curto de sintetizador retrô a cada acerto.' },
  { id: 'frame_gold',    slot: 'frame',      price: 100, icon: '🖼️', name: 'Moldura Dourada',                desc: 'Uma moldura dourada ao redor do seu nick no ranking e perfil.' },
  { id: 'frame_rainbow', slot: 'frame',      price: 100, icon: '🖼️', name: 'Moldura Arco-íris',              desc: 'Uma moldura multicolorida ao redor do seu nick.' },
  { id: 'confetti_gold', slot: 'confetti',   price: 120, icon: '🎊', name: 'Confete Dourado',                desc: 'Um confete dourado quando você bate um novo recorde.' },
  { id: 'row_fire',      slot: 'rowTheme',   price: 130, icon: '🔥', name: 'Linha: Fogo',                    desc: 'Fundo temático de fogo na sua linha do ranking.' },
  { id: 'row_ocean',     slot: 'rowTheme',   price: 130, icon: '🌊', name: 'Linha: Oceano',                  desc: 'Fundo temático de oceano na sua linha do ranking.' },
  { id: 'row_galaxy',    slot: 'rowTheme',   price: 130, icon: '🌌', name: 'Linha: Galáxia',                 desc: 'Fundo temático de galáxia na sua linha do ranking.' },
  { id: 'avatar_robot',   slot: 'avatar', price: 110, icon: '🤖', name: 'Avatar: Robô',     desc: 'Um robô neon pra representar você no perfil e no duelo.' },
  { id: 'avatar_ninja',   slot: 'avatar', price: 110, icon: '🥷', name: 'Avatar: Ninja',    desc: 'Um ninja encapuzado pra representar você no perfil e no duelo.' },
  { id: 'avatar_ghost',   slot: 'avatar', price: 110, icon: '👻', name: 'Avatar: Fantasma', desc: 'Um fantasma pra representar você no perfil e no duelo.' },
  { id: 'avatar_cat',     slot: 'avatar', price: 110, icon: '🐱', name: 'Avatar: Gato',     desc: 'Um gato pra representar você no perfil e no duelo.' },
  { id: 'avatar_alien',   slot: 'avatar', price: 110, icon: '👽', name: 'Avatar: Alien',    desc: 'Um alien pra representar você no perfil e no duelo.' },
  { id: 'avatar_flame',   slot: 'avatar', price: 110, icon: '🔥', name: 'Avatar: Chama',    desc: 'Uma chama pra representar você no perfil e no duelo.' },
  { id: 'avatar_crystal', slot: 'avatar', price: 110, icon: '💎', name: 'Avatar: Cristal',  desc: 'Um cristal pra representar você no perfil e no duelo.' },
  { id: 'avatar_star',    slot: 'avatar', price: 110, icon: '⭐', name: 'Avatar: Estrela',  desc: 'Uma estrela pra representar você no perfil e no duelo.' },
];
const SHOP_ITEMS_BY_ID = Object.fromEntries(SHOP_ITEMS.map(it => [it.id, it]));
const SHOP_SLOTS = [
  { slot: 'sfxCorrect', label: '🔊 Som de Acerto' },
  { slot: 'frame',      label: '🖼️ Moldura do Nick' },
  { slot: 'confetti',   label: '🎊 Confete de Recorde' },
  { slot: 'rowTheme',   label: '📊 Linha do Ranking' },
  { slot: 'avatar',     label: '🧑 Avatar' },
];
let equippedSfx = null, equippedFrame = null, equippedConfetti = null, equippedAvatar = null;
function applyEquippedCosmetics() {
  const eq = (state.myData && state.myData.equipped) || {};
  equippedSfx = eq.sfxCorrect || null;
  equippedFrame = eq.frame || null;
  equippedConfetti = eq.confetti || null;
  equippedAvatar = eq.avatar || null;
}

// modo sorteado do desafio diário — determinístico por dia (mesmo modo pra
// TODO MUNDO, e igual nas 3 tentativas), sorteado entre os modos de
// DAILY_ROTATION_MODES, SEM olhar nível desbloqueado: o desafio diário
// sempre foi acessível a qualquer um independente do modo normal estar
// bloqueado ou não pro nível da pessoa.
// DAILY_MODE_OVERRIDE: força um dia específico pra um modo em particular,
// sem mexer no sorteio de verdade dos outros dias (fica igual pra quem olhar
// de fora — "🎲 modo sorteado de hoje" continua fazendo sentido). Hoje
// (30/07/2026) é Clássico, com a paleta trocada pra Azul/Ciano/Verde/Roxo;
// amanhã (31/07/2026) será Reverso, com a paleta estendida de 12 cores (ver
// DAILY_PALETTE_OVERRIDE).
const DAILY_MODE_OVERRIDE = { '2026-07-28': 'reverse', '2026-07-29': 'classic', '2026-07-30': 'classic', '2026-07-31': 'reverse' };
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

// desenha um quadrado do modo Trio (3 cores independentes: fundo, cor da
// palavra e a própria palavra) — função compartilhada entre a partida de
// verdade (newTrioRound), o replay (renderReplaySquares) e, no futuro, um
// tutorial dedicado, pra nunca desenhar esse quadrado especial de 2 jeitos
// diferentes por engano
function renderTrioSquare(el, sq) {
  el.style.background = sq.bg.hex;
  el.style.boxShadow = `0 0 18px ${sq.bg.hex}99, 0 0 40px ${sq.bg.hex}55, inset 0 0 20px rgba(255,255,255,0.12)`;
  el.innerHTML = `<span class="word word-trio" style="color:${sq.tc.hex}">${cName(sq.word)}</span>`;
}

// desenha um quadrado do modo Caos (forma + cor de preenchimento + palavra,
// os 3 atributos independentes — ver newCaosRound) — igual renderTrioSquare,
// função compartilhada entre a partida de verdade e o replay, pra nunca
// desenhar esse quadrado de 2 jeitos diferentes por engano
function renderCaosSquare(el, sq) {
  el.className = 'square shape-square ' + sq.shape.shapeClass;
  el.style.background = '';
  el.style.boxShadow = '';
  el.innerHTML = `<span class="shape-fill ${sq.shape.shapeClass}" style="background:${sq.color.hex}; filter: drop-shadow(0 0 14px ${sq.color.hex}88) drop-shadow(0 0 26px ${sq.color.hex}44);"></span><span class="word">${cName(sq.word)}</span>`;
}

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

window.goSignup = () => {
  state.offline = false;
  show('auth-screen');
};

/* ================== perfil / conquistas ================== */
window.showProfile = () => {
  pushScreenAndShow('profile-screen', 'menu-screen');
  renderProfile();
};
window.profileBack = () => popScreenBack();

/* ================== painel de admin (perfil de outra pessoa) ================== */
// texto fixo em português de propósito — essa parte da tela só aparece pra
// quem tem admin:true (só você), então não precisa dos outros idiomas
function fmtDateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function renderAdminPanel(uid, currentNick, stats) {
  const box = $('admin-panel-body');
  if (!box) return;

  let details;
  try {
    details = (await callAdminGetUserDetails({ uid })).data;
  } catch (e) {
    box.textContent = 'Erro ao carregar dados de admin: ' + (e.message || e);
    return;
  }

  box.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'text-align:left; display:flex; flex-direction:column; gap:10px; width:100%;';

  // último login
  const loginRow = document.createElement('div');
  loginRow.innerHTML = '<b>Última vez online:</b> ';
  loginRow.appendChild(document.createTextNode(details.lastActiveAt ? fmtDateTime(details.lastActiveAt) : 'nunca registrado'));
  wrap.appendChild(loginRow);

  // últimos duelos (PvP) — nick do adversário sempre via textContent (nunca
  // interpolado no HTML), mesmo cuidado usado no resto da tela de perfil
  const matchesTitle = document.createElement('div');
  matchesTitle.innerHTML = '<b>Últimos duelos (PvP):</b>';
  wrap.appendChild(matchesTitle);
  const matchesList = document.createElement('div');
  matchesList.style.cssText = 'display:flex; flex-direction:column; gap:2px;';
  if (!details.matches.length) {
    const row = document.createElement('div');
    row.className = 'muted';
    row.textContent = 'Nenhum duelo concluído ainda.';
    matchesList.appendChild(row);
  } else {
    details.matches.forEach(m => {
      const row = document.createElement('div');
      row.className = 'muted';
      const resultLabel = m.result === 'win' ? '🏆 Vitória' : m.result === 'loss' ? '💀 Derrota' : '🤝 Empate';
      row.appendChild(document.createTextNode(fmtDateTime(m.finishedAt) + ' — vs '));
      const b = document.createElement('b');
      b.textContent = m.opponentNick || '?';
      row.appendChild(b);
      row.appendChild(document.createTextNode(' — ' + resultLabel));
      matchesList.appendChild(row);
    });
  }
  wrap.appendChild(matchesList);

  // lista de amigos
  const friendsTitle = document.createElement('div');
  friendsTitle.innerHTML = `<b>Amigos (${details.friends.length}):</b>`;
  wrap.appendChild(friendsTitle);
  const friendsList = document.createElement('div');
  friendsList.style.cssText = 'display:flex; flex-direction:column; gap:2px;';
  if (!details.friends.length) {
    const row = document.createElement('div');
    row.className = 'muted';
    row.textContent = 'Sem amigos ainda.';
    friendsList.appendChild(row);
  } else {
    details.friends.forEach(f => {
      const row = document.createElement('div');
      row.className = 'muted';
      row.appendChild(document.createTextNode('👤 '));
      const b = document.createElement('b');
      b.textContent = f.nick || '?';
      row.appendChild(b);
      if (f.since) row.appendChild(document.createTextNode(' — desde ' + fmtDateTime(f.since)));
      friendsList.appendChild(row);
    });
  }
  wrap.appendChild(friendsList);

  // histórico de IPs/locais dessa conta (ver checkIpAndFlag em
  // functions/index.js) — só pra revisão manual, não marca nada sozinho.
  // Cada IP é uma linha própria de propósito (não uma frase corrida), pra
  // ficar fácil comparar visualmente com o histórico de outra conta suspeita.
  const ipTitle = document.createElement('div');
  ipTitle.innerHTML = `<b>Histórico de IPs (${(details.ipHistory || []).length}):</b>`;
  wrap.appendChild(ipTitle);
  const ipList = document.createElement('div');
  ipList.style.cssText = 'display:flex; flex-direction:column; gap:2px;';
  if (!details.ipHistory || !details.ipHistory.length) {
    const row = document.createElement('div');
    row.className = 'muted';
    row.textContent = 'Nenhum IP registrado ainda.';
    ipList.appendChild(row);
  } else {
    details.ipHistory.forEach(h => {
      const row = document.createElement('div');
      row.className = 'muted';
      const place = [h.city, h.country].filter(Boolean).join(', ') || '(local desconhecido)';
      row.textContent = `🌐 ${h.ip} — ${place} — ${fmtDateTime(h.at)}`;
      ipList.appendChild(row);
    });
  }
  wrap.appendChild(ipList);

  // editar nick + banir/desbanir — ambos validados de novo no servidor
  // (adminSetNick / adminSetBanned), isso aqui só monta a UI
  const toolsBox = document.createElement('div');
  toolsBox.style.cssText = 'border-top:1px solid rgba(255,255,255,0.1); padding-top:10px; display:flex; flex-direction:column; gap:8px;';

  const nickRow = document.createElement('div');
  nickRow.style.cssText = 'display:flex; gap:8px;';
  const nickInput = document.createElement('input');
  nickInput.type = 'text';
  nickInput.value = currentNick || '';
  nickInput.style.flex = '1';
  nickRow.appendChild(nickInput);
  const saveBtn = document.createElement('button');
  saveBtn.className = 'secondary';
  saveBtn.style.flex = 'none';
  saveBtn.textContent = 'Salvar nick';
  nickRow.appendChild(saveBtn);
  toolsBox.appendChild(nickRow);
  const nickStatus = document.createElement('div');
  nickStatus.className = 'muted';
  toolsBox.appendChild(nickStatus);

  saveBtn.onclick = async () => {
    const nick = nickInput.value.trim();
    nickStatus.textContent = '';
    if (nick.length < 3 || nick.length > 16 || /\s/.test(nick)) {
      nickStatus.textContent = 'Nick inválido (3 a 16 caracteres, sem espaço).';
      return;
    }
    saveBtn.disabled = true;
    try {
      await callAdminSetNick({ uid, nick });
      nickStatus.textContent = '✅ Nick atualizado.';
      stats.nick = nick;
      $('profile-nick-text').textContent = T[state.lang].profile_nick_label(nick);
      $('profile-nick-lv').innerHTML = ' ' + lvChip(stats.xp || 0);
    } catch (e) {
      nickStatus.textContent = '❌ ' + (e.message || 'Erro ao salvar.');
    } finally {
      saveBtn.disabled = false;
    }
  };

  const banBtn = document.createElement('button');
  const paintBanBtn = banned => {
    banBtn.textContent = banned ? '✅ Remover banimento' : '🚫 Banir esta conta';
    banBtn.style.cssText = banned
      ? 'border-color:var(--neon-green); color:var(--neon-green); background:#0a0e1e;'
      : 'border-color:var(--neon-red); color:#ff8bab; background:#0a0e1e;';
  };
  paintBanBtn(details.banned);
  toolsBox.appendChild(banBtn);
  const banStatus = document.createElement('div');
  banStatus.className = 'muted';
  toolsBox.appendChild(banStatus);

  banBtn.onclick = async () => {
    const next = !details.banned;
    if (next && !confirm('Banir esta conta? A pessoa não vai mais conseguir gravar pontuação nem jogar PvP.')) return;
    banBtn.disabled = true;
    banStatus.textContent = '';
    try {
      await callAdminSetBanned({ uid, banned: next });
      details.banned = next;
      paintBanBtn(next);
      banStatus.textContent = next ? '🚫 Conta banida.' : '✅ Banimento removido.';
    } catch (e) {
      banStatus.textContent = '❌ ' + (e.message || 'Erro.');
    } finally {
      banBtn.disabled = false;
    }
  };

  // zera a pontuação dos 6 modos de jogo (e o total geral, que é a soma
  // deles) mais a tentativa de hoje do desafio diário — não mexe em
  // dailyWins (Salão da Fama), XP/nível, indicações, Pigmentos nem itens da
  // loja. Sem "desfazer" (ao contrário do banimento): a confirmação é
  // sempre exigida, já que não tem como voltar atrás depois.
  const resetScoresBtn = document.createElement('button');
  resetScoresBtn.className = 'secondary';
  resetScoresBtn.style.cssText = 'border-color:var(--neon-red); color:#ff8bab; background:#0a0e1e;';
  resetScoresBtn.textContent = '🗑️ Zerar pontuações desta conta';
  toolsBox.appendChild(resetScoresBtn);
  const resetScoresStatus = document.createElement('div');
  resetScoresStatus.className = 'muted';
  toolsBox.appendChild(resetScoresStatus);

  resetScoresBtn.onclick = async () => {
    if (!confirm(`Zerar as pontuações de ${currentNick || 'esta conta'} nos 6 modos de jogo (Clássico, Reverso, Formas, Formas Reverso, Trio, Caos) e a tentativa de hoje do desafio diário? Isso NÃO afeta o Salão da Fama, XP/nível, indicações, Pigmentos ou itens da loja. Não pode ser desfeito.`)) return;
    resetScoresBtn.disabled = true;
    resetScoresStatus.textContent = '';
    try {
      await callAdminResetScores({ uid });
      ALL_MODES.forEach(m => { stats[m] = 0; });
      stats.total = 0;
      resetScoresStatus.textContent = '✅ Pontuações zeradas nos 6 modos e na tentativa de hoje do desafio diário.';
    } catch (e) {
      resetScoresStatus.textContent = '❌ ' + (e.message || 'Erro.');
    } finally {
      resetScoresBtn.disabled = false;
    }
  };

  wrap.appendChild(toolsBox);
  box.appendChild(wrap);
  // o painel carrega depois do resto do perfil (é uma chamada assíncrona à
  // parte) e deixa a tela mais alta — sem isso, o mesmo bug de rolagem presa
  // já corrigido no ranking/amigos podia voltar a acontecer aqui
  resetScroll('profile-screen');
}

// botão avulso no PRÓPRIO perfil (não no painel de outra pessoa acima) —
// dispara o backfill único de pendingPigmentos (ver comentário da function
// no functions/index.js). Idempotente: pode clicar mais de uma vez à vontade.
window.runBackfillPendingPigmentos = async (btn) => {
  const status = $('backfill-status');
  btn.disabled = true;
  if (status) status.textContent = 'Rodando...';
  try {
    const res = await callBackfillPendingPigmentos();
    if (status) status.textContent = `✅ Concluído — ${res.data.usersUpdated} conta(s) atualizada(s).`;
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || 'Erro ao rodar backfill.');
  } finally {
    btn.disabled = false;
  }
};

// preenche <modo>DurationMs/bestScoreDurationMs de recordes/pontuações
// retroativas — ver backfillReplayDurations em functions/index.js. Rodar
// uma vez só; idempotente, então clicar de novo por engano não faz mal
// (só reprocessa o que ainda estiver faltando).
window.runBackfillReplayDurations = async (btn) => {
  const status = $('backfill-duration-status');
  btn.disabled = true;
  if (status) status.textContent = 'Rodando...';
  try {
    const res = await callBackfillReplayDurations();
    const d = res.data;
    if (status) status.textContent = `✅ Concluído — ${d.scoresUpdated} recorde(s) e ${d.dailyUpdated} pontuação(ões) do diário atualizados. Sem dado suficiente pra calcular: ${d.scoresFieldsSkipped} recorde(s) e ${d.dailySkipped} do diário (ficam no critério antigo).`;
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || 'Erro ao rodar backfill.');
  } finally {
    btn.disabled = false;
  }
};

// outra ferramenta avulsa só pra admin, mesmo raciocínio da de cima — define
// o XP da PRÓPRIA conta pro mínimo do nível digitado (ver totalXpForLevel).
// Só atualiza o essencial na tela (chip de nível no cabeçalho + state.myData.xp),
// sem chamar renderProfile() de novo — isso reconstruiria o card inteiro e
// apagaria a mensagem de status antes da pessoa conseguir ler.
// força o recálculo do retrato de ranking (scoresSnapshot) na hora, em vez de
// esperar os até 5min do agendamento — útil pra ver na hora o efeito de uma
// mudança recém-implantada em functions/index.js (ex.: admin entrar/sair do
// ranking) sem precisar esperar o próximo ciclo automático
window.runAdminRecomputeSnapshot = async (btn) => {
  const status = $('recompute-snapshot-status');
  btn.disabled = true;
  if (status) status.textContent = 'Recalculando...';
  try {
    const res = await callAdminRecomputeScoresSnapshot();
    invalidateScoresCache(); // invalida o cache local de 5min pra próxima leitura já vir atualizada
    if (status) status.textContent = `✅ Retrato atualizado — ${res.data.userCount} conta(s), ${res.data.chunkCount} pedaço(s).`;
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || 'Erro ao recalcular.');
  } finally {
    btn.disabled = false;
  }
};

// mostra os alertas mais recentes de checkIpAndFlag (functions/index.js) —
// texto fixo em português de propósito, igual o resto do painel de admin
window.runAdminGetFlaggedAccounts = async (btn) => {
  const list = $('flagged-accounts-list');
  btn.disabled = true;
  if (list) list.innerHTML = '<div class="muted">Carregando...</div>';
  try {
    const res = await callAdminGetFlaggedAccounts();
    const events = (res.data && res.data.events) || [];
    if (!events.length) {
      if (list) list.innerHTML = '<div class="muted">Nenhum alerta registrado ainda.</div>';
    } else if (list) {
      list.innerHTML = events.map(ev => {
        const nickSafe = (ev.nick || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        let detailText;
        if (ev.reason === 'ip_compartilhado_entre_contas') {
          const otherSafe = (ev.otherNick || '(sem nick)').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
          detailText = `mesmo IP que <b>${otherSafe}</b> (${ev.details.ip || '?'})`;
        } else {
          const from = ev.details.fromCity || ev.details.fromCountry || '?';
          const to = ev.details.toCity || ev.details.toCountry || '?';
          const mins = ev.details.elapsedMs ? Math.round(ev.details.elapsedMs / 60000) : '?';
          detailText = `pulou de <b>${from}</b> pra <b>${to}</b> (${ev.details.distanceKm || '?'}km) em ${mins}min`;
        }
        return `<div class="card" style="text-align:left; padding:10px 14px;">
          <div><b>${nickSafe}</b> — ${detailText}</div>
          <div class="muted" style="margin-top:4px;">${fmtDateTime(ev.at)}</div>
        </div>`;
      }).join('');
    }
  } catch (e) {
    if (list) list.innerHTML = '❌ ' + (e.message || 'Erro ao carregar.');
  } finally {
    btn.disabled = false;
  }
};

// lista os pedidos de exclusão dentro da carência de 15 dias, com botão pra
// desfazer (reativa login) ou acelerar (apaga os dados na hora) cada um —
// ver adminListPendingDeletions/adminCancelAccountDeletion/
// adminForcePurgeAccount em functions/index.js
window.runAdminListPendingDeletions = async (btn) => {
  const list = $('pending-deletions-list');
  btn.disabled = true;
  if (list) list.innerHTML = '<div class="muted">Carregando...</div>';
  try {
    const res = await callAdminListPendingDeletions();
    const requests = (res.data && res.data.requests) || [];
    if (!requests.length) {
      if (list) list.innerHTML = '<div class="muted">Nenhum pedido de exclusão pendente.</div>';
    } else if (list) {
      list.innerHTML = requests.map(r => {
        const esc = s => (s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        const msLeft = (r.scheduledPurgeAt || 0) - Date.now();
        const daysLeft = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
        const timeLabel = msLeft <= 0 ? 'já venceu — purga automática deve rodar em breve' : `${daysLeft} dia(s) restante(s)`;
        return `<div class="card" style="text-align:left; padding:10px 14px;">
          <div><b>${esc(r.nick)}</b>${r.email ? ' — ' + esc(r.email) : ''}</div>
          <div class="muted" style="margin-top:2px;">Pedido em ${fmtDateTime(r.requestedAt)} — ${timeLabel} (exclusão automática em ${fmtDateTime(r.scheduledPurgeAt)})</div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <button class="secondary" style="flex:1;" onclick="runAdminCancelAccountDeletion('${r.uid}', this)">↩️ Desfazer</button>
            <button class="secondary" style="flex:1; border-color:var(--neon-red); color:#ff8bab;" onclick="runAdminForcePurgeAccount('${r.uid}', this)">🗑️ Excluir agora</button>
          </div>
          <div class="muted pending-deletion-status" style="margin-top:6px;"></div>
        </div>`;
      }).join('');
    }
  } catch (e) {
    if (list) list.innerHTML = '❌ ' + (e.message || 'Erro ao carregar.');
  } finally {
    btn.disabled = false;
  }
};

window.runAdminCancelAccountDeletion = async (uid, btn) => {
  if (!confirm('Cancelar o pedido de exclusão e reativar o login dessa conta?')) return;
  const row = btn.closest('.card');
  const status = row && row.querySelector('.pending-deletion-status');
  btn.disabled = true;
  try {
    await callAdminCancelAccountDeletion({ uid });
    if (row) row.remove();
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || 'Erro.');
    btn.disabled = false;
  }
};

window.runAdminForcePurgeAccount = async (uid, btn) => {
  if (!confirm('Excluir esta conta AGORA, sem esperar o resto da carência? Isso apaga todos os dados na hora e não pode ser desfeito.')) return;
  const row = btn.closest('.card');
  const status = row && row.querySelector('.pending-deletion-status');
  btn.disabled = true;
  try {
    await callAdminForcePurgeAccount({ uid });
    if (row) row.remove();
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || 'Erro.');
    btn.disabled = false;
  }
};

window.runAdminSetOwnLevel = async (btn) => {
  const input = $('admin-set-level-input');
  const status = $('admin-set-level-status');
  const lv = parseInt(input.value, 10);
  if (status) status.textContent = '';
  if (!Number.isFinite(lv) || lv < 1 || lv > 500) {
    if (status) status.textContent = '❌ Nível inválido (1 a 500).';
    return;
  }
  const xp = totalXpForLevel(lv);
  btn.disabled = true;
  try {
    await callAdminSetXp({ uid: state.currentUser.uid, xp });
    state.myData.xp = xp;
    $('profile-nick-lv').innerHTML = ' ' + lvChip(myXp());
    if (status) status.textContent = `✅ Nível definido pra ${lv}.`;
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || 'Erro ao salvar.');
  } finally {
    btn.disabled = false;
  }
};


// sem argumentos: perfil PRÓPRIO (editável, lê de state.myData ao vivo, badges
// completos com progresso). Com viewStats/viewNick/viewUid: perfil de OUTRO
// jogador — somente leitura, medalha atual de cada categoria + posição no
// ranking em cada modo (ver openProfileFromRanking acima).
async function renderProfile(viewStats, viewNick, viewUid) {
  const isOther = !!viewStats;
  const stats = isOther ? viewStats : state.myData;

  $('profile-invite-btn').style.display = (!isOther && !state.offline) ? '' : 'none';
  const showOwnRefCode = !isOther && !state.offline && !!state.myData.refCode;
  $('profile-refcode-row').style.display = showOwnRefCode ? 'flex' : 'none';
  if (showOwnRefCode) $('profile-refcode-value').textContent = state.myData.refCode;

  if (!isOther && state.offline) {
    $('profile-nick-avatar').innerHTML = '';
    $('profile-nick-text').textContent = T[state.lang].profile_offline_label;
    $('profile-nick-lv').innerHTML = '';
    $('profile-summary').textContent = '';
    $('profile-friend-action').style.display = 'none';
    $('profile-friend-action').innerHTML = '';
    $('profile-friend-status').textContent = '';
    $('profile-body').innerHTML = `
      <div class="card" style="text-align:center;">
        <p>${T[state.lang].profile_offline_msg1}</p>
        <p class="muted">${T[state.lang].profile_offline_msg2}</p>
        <button onclick="goSignup()">${T[state.lang].btn_create_account}</button>
      </div>`;
    resetScroll('profile-screen');
    return;
  }

  // avatar e nível são markup fixo/confiável (innerHTML tudo bem); o nick
  // sempre via textContent (nunca innerHTML) pra não abrir brecha de injeção.
  // Cada pedaço tem seu próprio <span> dedicado (profile-nick-avatar/-text/-lv)
  // e é sempre SUBSTITUÍDO (nunca acrescentado) — antes usava insertAdjacentHTML
  // direto no #profile-nick, o que podia deixar ícone duplicado se essa função
  // rodasse mais de uma vez em sequência (ex.: ao trocar a medalha equipada).
  $('profile-nick-avatar').innerHTML = avatarOrDefaultIcon(stats.equipped && stats.equipped.avatar, 42) + ' ';
  $('profile-nick-text').textContent = T[state.lang].profile_nick_label(isOther ? (viewNick || '') : (state.myData.nick || ''));
  $('profile-nick-lv').innerHTML = ' ' + lvChip(isOther ? (stats.xp || 0) : myXp());
  applyNickFrame($('profile-nick'), stats);

  if (isOther) {
    $('profile-summary').textContent = '';
    renderProfileFriendAction(viewUid);
    const ranks = await computeModeRanks(viewUid);
    const ranksHtml = renderPublicProfileRanks(stats, ranks);
    let html = '';
    if (ranksHtml) html += profileSectionLabel(T[state.lang].profile_ranks_section) + ranksHtml;
    html += profileSectionLabel(T[state.lang].profile_badges_section) + renderPublicProfileBadges(stats);
    // painel só pra admin (state.myData.admin, setado à mão no Firebase Console) —
    // último login, últimos duelos e amigos de QUALQUER jogador, com opção de
    // editar o nick e banir a conta, tudo validado de novo no servidor (ver
    // requireAdmin em functions/index.js — o cliente decidir mostrar isso aqui
    // é só conveniência de UI, não é o que garante a permissão)
    if (state.myData.admin === true) {
      html += profileSectionLabel('🛠️ Admin') + `<div class="card" id="admin-panel-body"><div class="muted" style="text-align:center;">Carregando dados de admin...</div></div>`;
    }
    $('profile-body').innerHTML = html;
    resetScroll('profile-screen');
    if (state.myData.admin === true) renderAdminPanel(viewUid, viewNick || '', stats);
    return;
  }

  $('profile-friend-action').style.display = 'none';
  $('profile-friend-action').innerHTML = '';
  $('profile-friend-status').textContent = '';

  // conta cada NÍVEL desbloqueado dentro de cada categoria (não só se a categoria
  // foi iniciada) — cada categoria tem 6 níveis, então o total é 4×6 = 24
  const unlockedCount = BADGE_ORDER.reduce((n, k) => {
    const t = unlockedTier(BADGE_DEFS[k], stats);
    return n + (t >= 0 ? t + 1 : 0);
  }, 0);
  const totalLevels = BADGE_ORDER.reduce((n, k) => n + BADGE_DEFS[k].tiers.length, 0);
  $('profile-summary').textContent = T[state.lang].profile_summary(unlockedCount, totalLevels);
  $('profile-body').innerHTML = BADGE_ORDER.map(key => renderBadgeCard(key, BADGE_DEFS[key], stats)).join('');
  // ferramenta avulsa só pra admin (state.myData.admin, setado à mão no Firebase
  // Console) — corrige pendingPigmentos de quem já tinha prêmio parado na
  // caixa de entrada de antes desse campo existir (ver comentário da
  // function backfillPendingPigmentos em functions/index.js). Idempotente:
  // pode rodar mais de uma vez sem risco.
  if (state.myData.admin === true) {
    $('profile-body').insertAdjacentHTML('beforeend', `
      <div class="card" style="text-align:left;">
        <b>🛠️ Admin — ferramentas gerais</b>
        <p class="muted" style="margin-top:6px;">Recalcula pendingPigmentos de todo mundo a partir do que ainda está na caixa de entrada de cada um. Seguro rodar mais de uma vez.</p>
        <button class="secondary" onclick="runBackfillPendingPigmentos(this)">Rodar backfill de pigmentos pendentes</button>
        <div class="muted" id="backfill-status" style="margin-top:6px;"></div>
      </div>
      <div class="card" style="text-align:left;">
        <b>🛠️ Admin — preencher duração de partidas retroativas</b>
        <p class="muted" style="margin-top:6px;">Preenche a duração das partidas que já bateram recorde antes dessa medição existir (usa a sessão salva do recorde atual — start/fim já gravados). O ranking passou a desempatar por "menos tempo gasto" em vez de "quem pontuou primeiro"; sem isso, todo recorde antigo continua no critério velho. Seguro rodar mais de uma vez.</p>
        <button class="secondary" onclick="runBackfillReplayDurations(this)">Rodar backfill de duração</button>
        <div class="muted" id="backfill-duration-status" style="margin-top:6px;"></div>
      </div>
      <div class="card" style="text-align:left;">
        <b>🛠️ Admin — atualizar ranking agora</b>
        <p class="muted" style="margin-top:6px;">Recalcula o retrato do ranking (scoresSnapshot) na hora, em vez de esperar até 5min pelo agendamento automático. Útil pra testar mudanças recém-implantadas nas functions.</p>
        <button class="secondary" onclick="runAdminRecomputeSnapshot(this)">Recalcular ranking agora</button>
        <div class="muted" id="recompute-snapshot-status" style="margin-top:6px;"></div>
      </div>
      <div class="card" style="text-align:left;">
        <b>🚩 Contas Suspeitas</b>
        <p class="muted" style="margin-top:6px;">Lista os alertas mais recentes de possível compartilhamento de conta: mesmo IP em duas contas diferentes, ou uma conta "pulando" de local rápido demais (ver checkIpAndFlag em functions/index.js). Não bloqueia nada sozinho — é só pra você decidir manualmente o que fazer.</p>
        <button class="secondary" onclick="runAdminGetFlaggedAccounts(this)">Carregar contas suspeitas</button>
        <div id="flagged-accounts-list" style="margin-top:6px;"></div>
      </div>
      <div class="card" style="text-align:left;">
        <b>🕒 Pedidos de Exclusão de Conta</b>
        <p class="muted" style="margin-top:6px;">Contas que pediram exclusão e ainda estão dentro da carência de 15 dias (exigência da Apple — ver deleteMyAccount em functions/index.js). "Desfazer" reativa o login e cancela o pedido; "Excluir agora" apaga os dados na hora, sem esperar o resto da carência.</p>
        <button class="secondary" onclick="runAdminListPendingDeletions(this)">Carregar pedidos de exclusão</button>
        <div id="pending-deletions-list" style="margin-top:6px;"></div>
      </div>
      <div class="card" style="text-align:left;">
        <b>🛠️ Admin — editar meu nível</b>
        <p class="muted" style="margin-top:6px;">Define seu XP direto pro mínimo do nível escolhido. Só afeta a sua própria conta — validado de novo no servidor (ver adminSetXp em functions/index.js).</p>
        <div style="display:flex; gap:8px; margin-top:6px;">
          <input type="number" id="admin-set-level-input" min="1" max="500" step="1" value="${levelFromXp(myXp())}" style="flex:1;">
          <button class="secondary" style="flex:none;" onclick="runAdminSetOwnLevel(this)">Definir nível</button>
        </div>
        <div class="muted" id="admin-set-level-status" style="margin-top:6px;"></div>
      </div>`);
  }
  $('profile-body').insertAdjacentHTML('beforeend', `
    <div class="card" style="text-align:left;">
      <b data-i18n="delete_account_title">⚠️ Excluir conta</b>
      <p class="muted" style="margin-top:6px;" data-i18n="delete_account_desc">Apaga permanentemente sua conta e todos os dados vinculados a ela (pontuações, XP, amigos, medalhas, Pigmentos). Essa ação não pode ser desfeita.</p>
      <button class="secondary" style="border-color:var(--neon-red,#ff2d6b); color:var(--neon-red,#ff2d6b); margin-top:6px;" onclick="startDeleteMyAccount(this)" data-i18n="delete_account_btn">Excluir minha conta</button>
      <div class="muted" id="delete-account-status" style="margin-top:6px;"></div>
    </div>`);
  resetScroll('profile-screen');
  // agora que a pessoa viu o próprio perfil (com todas as categorias e a
  // bolinha mostrando qual tinha novidade), marca tudo como visto — some a
  // bolinha do nick até desbloquear algo novo de novo
  markAllBadgesSeen();
}
// exposta em window pra js/profile-public.js (openProfileFromRanking) poder
// chamar sem esperar o perfil ganhar seu próprio módulo (fase futura)
window.renderProfile = renderProfile;

function renderBadgeCard(key, def, stats) {
  const tier = unlockedTier(def, stats);
  const val = def.metric(stats);
  const maxed = tier === def.tiers.length - 1;
  const color = tier >= 0 ? TIER_COLORS[tier] : '#0f3460';
  const currentName = tier >= 0 ? def.names[state.lang][tier] : T[state.lang].badge_not_unlocked;
  const newCount = newBadgeCountFor(key); // quantos níveis novos essa categoria tem ainda não vistos

  let progressHtml;
  if (maxed) {
    progressHtml = `<div class="muted" style="text-align:left;">${T[state.lang].badge_maxed}</div>`;
  } else {
    const nextThreshold = def.tiers[tier + 1];
    if (def.inverse) {
      const posText = (val === Infinity) ? T[state.lang].badge_rank_unknown : T[state.lang].badge_rank_current(val);
      progressHtml = `<div class="muted" style="text-align:left;">${posText}<br>${T[state.lang].badge_next_goal(def.desc(nextThreshold))}</div>`;
    } else {
      const pct = Math.min(100, Math.max(0, (val / nextThreshold) * 100));
      progressHtml = `
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="muted" style="text-align:left;">${val} / ${nextThreshold} — ${def.desc(nextThreshold)}</div>`;
    }
  }

  // qual nível desta categoria está sendo exibido no ranking agora (-1 se a
  // categoria nem está equipada) — não precisa ser o mais alto desbloqueado,
  // ver setEquippedBadgeTier/equippedBadgeLabel
  const equippedTier = (state.myData.equippedBadge === key)
    ? ((typeof state.myData.equippedBadgeTier === 'number' && state.myData.equippedBadgeTier <= tier) ? state.myData.equippedBadgeTier : tier)
    : -1;

  // cada chip DESBLOQUEADO é clicável — escolhe direto aquele nível pra
  // exibir no ranking (não precisa ser o mais alto). Clicar no que já está
  // sendo exibido desequipa a categoria inteira.
  const chips = def.tiers.map((th, i) => {
    const unlocked = i <= tier;
    const lockOverlay = unlocked ? '' : '<span class="chip-lock">🔒</span>';
    const isShown = i === equippedTier;
    const clickAttr = unlocked ? ` onclick="setEquippedBadgeTier('${key}', ${i})"` : '';
    const cursorStyle = unlocked ? 'cursor:pointer;' : '';
    return `<span class="chip-wrap"><span class="badge-chip${unlocked ? '' : ' locked'}${isShown ? ' equipped' : ''}" style="background:${TIER_COLORS[i]};${cursorStyle}" title="${def.names[state.lang][i]}"${clickAttr}>${def.icon}</span>${lockOverlay}</span>`;
  }).join('');

  // legenda embaixo dos chips — só existe pra medalha já desbloqueada (tier >= 0)
  let equipHtml = '';
  if (tier >= 0) {
    equipHtml = (equippedTier >= 0)
      ? `<div class="muted" style="text-align:left; margin-top:6px;">${T[state.lang].profile_badge_equipped_btn}: ${badgePillHtml(def, equippedTier)}</div>`
      : `<div class="muted" style="text-align:left; margin-top:6px;">${T[state.lang].profile_badge_equip_btn}</div>`;
  }

  return `
    <div class="card badge-card">
      <div class="badge-card-head">
        <span class="badge-chip big" style="background:${color}; position:relative;">${def.icon}${newCount > 0 ? `<span class="notif-dot">${newCount}</span>` : ''}</span>
        <div>
          <div class="name">${def.label[state.lang]}</div>
          <div class="muted" style="text-align:left;">${currentName}</div>
        </div>
      </div>
      ${progressHtml}
      <div class="chip-row">${chips}</div>
      ${equipHtml}
    </div>`;
}

// escolhe qual medalha (já desbloqueada) E QUAL NÍVEL dela aparece ao lado do
// próprio nick no ranking — não precisa ser o nível mais alto desbloqueado
// (ex.: já tem "Imortal" mas prefere mostrar "Lenda"). Grava direto em
// scores/{uid} (permitido pelas regras, ver isValidEquippedBadge/
// isValidEquippedBadgeTier no firestore.rules); é seguro sem Cloud Function
// porque equippedBadgeLabel() sempre reconfere unlockedTier() contra as
// stats reais antes de mostrar qualquer coisa (clicar num nível não
// desbloqueado de verdade nunca chega a acontecer pela UI, mas mesmo que
// alguém forje isso direto no Firestore, não muda o que aparece pra ninguém).
window.setEquippedBadgeTier = async (key, tierIdx) => {
  if (state.offline || !state.currentUser || !state.myData.nick) return;
  // clicar no nível que já está sendo exibido desequipa a categoria inteira
  // (volta a não mostrar nada); clicar em outro nível (da mesma categoria ou
  // de outra) troca na hora, sem precisar desequipar antes
  const alreadyShown = state.myData.equippedBadge === key
    && ((typeof state.myData.equippedBadgeTier === 'number' ? state.myData.equippedBadgeTier : unlockedTier(BADGE_DEFS[key], state.myData)) === tierIdx);
  const nextKey = alreadyShown ? null : key;
  const nextTier = alreadyShown ? null : tierIdx;
  state.myData.equippedBadge = nextKey;
  state.myData.equippedBadgeTier = nextTier;
  // renderProfile() sempre chama resetScroll('profile-screen') no final, que
  // joga a página pro topo — é o certo ao ENTRAR na tela, mas aqui a pessoa já
  // está nela só trocando a medalha, então guarda a posição e restaura logo
  // depois, pra não pular a tela pra cima.
  const scrollY = window.scrollY;
  renderProfile(); // atualiza o chip/legenda na hora, antes mesmo do Firestore confirmar
  window.scrollTo(0, scrollY);
  try {
    await setDoc(doc(db, 'scores', state.currentUser.uid), { equippedBadge: nextKey, equippedBadgeTier: nextTier, updatedAt: serverTimestamp() }, { merge: true });
  } catch (e) {
    // não foi possível salvar agora — a escolha fica só localmente até a próxima tentativa
  }
};

async function submitPendingScore() {
  if (!state.pendingScore || !state.currentUser || !state.myData.nick) return;
  const { mode: m, score: s, xp: pendingXp = 0 } = state.pendingScore;
  state.pendingScore = null;

  // pontuação feita antes de ter conta — não existe sessão de servidor pra validar
  // o tempo (foi jogada state.offline), mas o servidor ainda valida o valor e só ele grava
  try {
    const res = await callClaimPendingScore({ mode: m, score: s, xpGain: pendingXp });
    const d = res.data || {};
    if (d.xpEarned) state.myData.xp = (state.myData.xp || 0) + d.xpEarned;
    if (d.isNewRecord) {
      state.myData[m] = s;
      state.myData[m + 'At'] = Timestamp.now(); // mesmo motivo do persistGameResult() acima
      if (d.total !== undefined) { state.myData.total = d.total; state.myData.totalAt = Timestamp.now(); }
    }
  } catch {}
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

/* ================== tela de replay ==================
   reconstrói uma partida gravada (ver replayRounds/replayMouse lá em cima e
   saveMatchReplay no servidor) — não recalcula nem valida nada, só lê de
   volta o que já está salvo em replays/{sessionId} e desenha de novo.
   Rodada: cada round.sq já traz o tabuleiro inteiro resolvido (ver
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
  // functions/index.js) usa a paleta estendida do desafio diário nos modos
  // Clássico/Reverso — mesmo "mode" que o jogo livre usa, então só dá pra
  // saber qual paleta reconstruir checando esse flag à parte. Usa a paleta
  // DO DIA em que a partida foi jogada (createdAt), não a de hoje — senão um
  // dia com DAILY_PALETTE_OVERRIDE (ver dailyPoolFor) faz o replay tentar
  // achar chaves tipo 'blue'/'cyan' numa paleta que não tem essas chaves,
  // caindo todo no pool[0] (era isso que deixava tudo amarelo).
  const replayDateStr = (replayData.createdAt && typeof replayData.createdAt.toMillis === 'function')
    ? dailyLocalDateStr(new Date(replayData.createdAt.toMillis()))
    : dailyLocalDateStr();
  const pool = (replayData.kind === 'daily' && (rmode === 'classic' || rmode === 'reverse'))
    ? (DAILY_PALETTE_OVERRIDE[replayDateStr] || DAILY_COLORS)
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
        el.innerHTML = `<span class="shape-fill ${shapeSide.shapeClass}"></span><span class="word">${cName(wordSide)}</span>`;
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
// que a encerrou — ver chamada em renderReplayFrame
function triggerReplayClickFlash(idx) {
  if (replayTargetSquareEl) {
    replayTargetSquareEl.classList.remove('replay-click-flash');
    void replayTargetSquareEl.offsetWidth; // força reflow pra poder retriggerar a animação se o elemento ainda tiver a classe de uma execução anterior
    replayTargetSquareEl.classList.add('replay-click-flash');
  }
  sfx.correct(idx + 1); // idx é a rodada que terminou; idx+1 é o placar resultante do clique — mesmo valor usado na partida real (ver handleClick)
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

/* ================== loja (cosméticos comprados com Pigmentos) ==================
   Catálogo/preço são só pra desenhar a tela — quem manda de verdade é o
   servidor (buyShopItem/setEquippedItem em functions/index.js), que confere
   saldo e posse de novo antes de gravar. O cliente só reflete o que já sabe
   (state.myData.pigmentos/ownedItems/equipped) e atualiza otimisticamente depois
   de cada resposta bem-sucedida. */

// botão "🛍️ LOJA" do menu — a loja ainda tá em teste, então o botão fica
// oculto pra todo mundo, menos pra quem loga como admin
function renderMenuPigmentosBar() {
  const shopBtn = $('menu-quick-shop-btn');
  if (!shopBtn) return;
  shopBtn.style.display = (!state.offline && state.currentUser && state.myData.nick && state.myData.admin === true) ? '' : 'none';
}
// saldo de Pigmentos no topo da tela, entre o nick e a caixa de entrada — só
// o número + ícone colorido, sem texto/link (o acesso à loja continua sendo
// só pela barra do menu, acima)
function renderUserPigmentos() {
  const el = $('user-pigmentos-bar');
  if (!el) return;
  if (state.offline || !state.currentUser || !state.myData.nick) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'inline-flex';
  $('user-pigmentos-num').textContent = state.myData.pigmentos || 0;
  $('user-pigmentos-icon').innerHTML = pigmentIconSvg(16);
}

window.showShop = () => {
  if (state.offline || !state.currentUser || !state.myData.nick) { goSignup(); return; }
  track('shop_open');
  $('shop-status').textContent = '';
  show('shop-screen');
  renderShop();
};

function renderShop() {
  $('shop-balance-icon').innerHTML = pigmentIconSvg(20);
  $('shop-balance-num').textContent = state.myData.pigmentos || 0;
  const owned = new Set(state.myData.ownedItems || []);
  const equipped = state.myData.equipped || {};

  const body = $('shop-body');
  body.innerHTML = '';
  SHOP_SLOTS.forEach(({ slot, label }) => {
    const section = document.createElement('div');
    section.className = 'card';
    section.style.textAlign = 'left';

    const title = document.createElement('h2');
    title.style.cssText = "font-family:'Orbitron',sans-serif; font-size:0.95rem; margin-bottom:2px;";
    title.textContent = label;
    section.appendChild(title);

    section.appendChild(shopDefaultRow(slot, equipped[slot]));
    SHOP_ITEMS.filter(it => it.slot === slot).forEach(item => {
      section.appendChild(shopItemRow(item, owned.has(item.id), equipped[slot] === item.id));
    });

    body.appendChild(section);
  });
  resetScroll('shop-screen');
}

// opção "padrão" de cada slot — sempre disponível, sem custo, volta o visual original
function shopDefaultRow(slot, currentEquipped) {
  const row = document.createElement('div');
  row.className = 'shop-item-row';

  const info = document.createElement('div');
  info.className = 'shop-item-info';
  const name = document.createElement('div');
  name.className = 'shop-item-name';
  name.textContent = '— Padrão —';
  const desc = document.createElement('div');
  desc.className = 'muted';
  desc.style.textAlign = 'left';
  desc.textContent = 'Visual original, sem cosmético.';
  info.appendChild(name);
  info.appendChild(desc);
  row.appendChild(info);

  const isActive = !currentEquipped;
  const btn = document.createElement('button');
  btn.style.cssText = 'padding:8px 16px; font-size:0.8rem; white-space:nowrap;';
  if (isActive) {
    btn.textContent = 'EQUIPADO';
    btn.disabled = true;
    btn.style.opacity = '0.6';
  } else {
    btn.className = 'secondary';
    btn.textContent = 'USAR';
    btn.onclick = () => equipShopItem(slot, null);
  }
  row.appendChild(btn);
  return row;
}

// prévia de cada item, direto na linha da loja — funciona mesmo sem
// comprar/equipar nada, pra pessoa decidir se vale a pena antes de gastar
// Pigmentos. Som chama a variante direto (bypassa o que estiver equipado
// agora); moldura monta um nick de exemplo com a moldura aplicada; confete
// dispara a mesma explosão que aparece ao bater recorde.
function shopItemPreview(item) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:6px;';
  if (item.slot === 'sfxCorrect') {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.style.cssText = 'padding:4px 12px; font-size:0.72rem;';
    btn.textContent = '🔊 Ouvir';
    btn.onclick = (e) => { e.stopPropagation(); playCorrectSfxVariant(item.id, 5); };
    wrap.appendChild(btn);
  } else if (item.slot === 'frame') {
    const sample = document.createElement('span');
    sample.textContent = 'SeuNick';
    sample.style.cssText = 'font-weight:700; font-size:0.85rem;';
    applyNickFrame(sample, { equipped: { frame: item.id } });
    wrap.appendChild(sample);
  } else if (item.slot === 'confetti') {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.style.cssText = 'padding:4px 12px; font-size:0.72rem;';
    btn.textContent = '🎉 Testar';
    btn.onclick = (e) => { e.stopPropagation(); spawnConfettiVariant(item.id); };
    wrap.appendChild(btn);
  } else if (item.slot === 'rowTheme') {
    // mini tabela real (não só uma div) pra reaproveitar exatamente o mesmo
    // seletor CSS "tbody tr.row-theme-x" usado na tabela de ranking de verdade
    const mini = document.createElement('table');
    mini.style.cssText = 'width:100%; border-collapse:collapse; margin-top:2px;';
    const tbody = document.createElement('tbody');
    const tr = document.createElement('tr');
    applyRowTheme(tr, { equipped: { rowTheme: item.id } });
    tr.innerHTML = '<td class="pos" style="padding:6px 8px;">1</td><td style="padding:6px 8px; font-weight:700;">SeuNick</td><td class="pts" style="padding:6px 8px;">1234</td>';
    tbody.appendChild(tr);
    mini.appendChild(tbody);
    wrap.appendChild(mini);
  } else if (item.slot === 'avatar') {
    // sempre visível (não precisa clicar em nada pra "testar" um desenho fixo)
    wrap.innerHTML = avatarSvg(item.id, 100); // 2.5x o tamanho antigo (40), só na prévia da loja
  }
  return wrap;
}

function shopItemRow(item, isOwned, isEquipped) {
  const row = document.createElement('div');
  row.className = 'shop-item-row';

  const info = document.createElement('div');
  info.className = 'shop-item-info';
  const name = document.createElement('div');
  name.className = 'shop-item-name';
  name.textContent = `${item.icon} ${item.name}`;
  const desc = document.createElement('div');
  desc.className = 'muted';
  desc.style.textAlign = 'left';
  desc.textContent = item.desc;
  info.appendChild(name);
  info.appendChild(desc);
  info.appendChild(shopItemPreview(item));
  row.appendChild(info);

  const btn = document.createElement('button');
  btn.style.cssText = 'padding:8px 16px; font-size:0.8rem; white-space:nowrap;';
  if (isEquipped) {
    btn.textContent = 'EQUIPADO';
    btn.disabled = true;
    btn.style.opacity = '0.6';
  } else if (isOwned) {
    btn.className = 'secondary';
    btn.textContent = 'USAR';
    btn.onclick = () => equipShopItem(item.slot, item.id);
  } else {
    btn.className = 'secondary';
    btn.insertAdjacentHTML('beforeend', pigmentIconSvg(14));
    const priceSpan = document.createElement('span');
    priceSpan.textContent = ' ' + item.price;
    btn.appendChild(priceSpan);
    if ((state.myData.pigmentos || 0) < item.price) btn.style.opacity = '0.55';
    btn.onclick = () => buyShopItemUi(item.id);
  }
  row.appendChild(btn);
  return row;
}

window.buyShopItemUi = async (itemId) => {
  $('shop-status').textContent = '';
  try {
    const res = await callBuyShopItem({ itemId });
    if (res.data && typeof res.data.pigmentos === 'number') state.myData.pigmentos = res.data.pigmentos;
    state.myData.ownedItems = [...(state.myData.ownedItems || []), itemId];
    renderShop();
    renderMenuPigmentosBar();
    renderUserPigmentos();
  } catch (e) {
    $('shop-status').textContent = e.message || 'Não foi possível comprar agora.';
  }
};

window.equipShopItem = async (slot, itemId) => {
  $('shop-status').textContent = '';
  try {
    await callSetEquippedItem({ slot, itemId: itemId || null });
    if (!state.myData.equipped) state.myData.equipped = {};
    if (itemId) state.myData.equipped[slot] = itemId; else delete state.myData.equipped[slot];
    applyEquippedCosmetics();
    renderShop();
  } catch (e) {
    $('shop-status').textContent = e.message || 'Não foi possível trocar agora.';
  }
};

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

function startPvpListener() {
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

function stopPvpListener() {
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
  $('pvp-challenge-text').textContent = T[state.lang].pvp_challenge_received(fromNick);
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

window.uiChallengeFriend = async (toUid) => {
  if (blockIfBanned()) return; // conta suspensa não joga nenhum modo
  try {
    const res = await callChallengeFriend({ toUid });
    const data = res.data || {};
    if (data.matchId) { openPvpScreen(data.matchId); return; }
  } catch {}
  showFriendActionError(); // "já existe um desafio" ou erro genérico — mesmo aviso da tela de amigos
};

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
  showMenu();
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
// não por cada cliente decidindo sozinho o que aconteceu
function checkPvpAttemptSound(m) {
  const la = m.lastAttempt;
  if (!la || !la.at) return;
  const at = la.at.toMillis();
  if (at === pvpLastAttemptAt) return;
  pvpLastAttemptAt = at;
  if (la.success) sfx.correct(0);
  else if (la.reason === 'timeout') sfx.timeout();
  else sfx.wrong();
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
    $('pvp-waiting-text').textContent = T[state.lang].pvp_waiting_text((m.nicks && m.nicks[oppUid]) || '');
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

function renderPvpBoard(m, myUid) {
  const round = m.round;
  if (!round) return;
  // a cor do RETÂNGULO é só distração — o que vale é a cor que a PALAVRA diz
  const boxColor = COLORS[round.promptColorIdx] || COLORS[0];
  const targetColor = COLORS[round.promptWordIdx] || COLORS[0];
  const box = $('pvp-prompt-box');
  box.textContent = targetColor.name[state.lang]; // conteúdo fixo (tabela COLORS), sem dado de usuário
  box.style.background = boxColor.hex;
  box.style.boxShadow = `0 0 18px ${boxColor.hex}99, 0 0 40px ${boxColor.hex}55, inset 0 0 14px rgba(255,255,255,0.15)`;

  const myTurn = m.turnUid === myUid;
  const grid = $('pvp-grid');
  grid.innerHTML = '';
  round.squares.forEach((sq, i) => {
    const bg = COLORS[sq.bgIdx] || COLORS[0];
    const word = COLORS[sq.wordIdx] || COLORS[0];
    const el = document.createElement('div');
    el.className = 'square';
    el.style.background = bg.hex;
    el.style.boxShadow = `0 0 18px ${bg.hex}99, 0 0 40px ${bg.hex}55, inset 0 0 20px rgba(255,255,255,0.12)`;
    el.innerHTML = `<span class="word">${word.name[state.lang]}</span>`; // conteúdo fixo (tabela COLORS), sem dado de usuário
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
  if (kind === 'win') sfx.pvpWin();
  else if (kind === 'lose') sfx.pvpLose();
  else sfx.pvpDraw();
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
    if (pvpCountdownLastNum !== 'go') { pvpCountdownLastNum = 'go'; sfx.countdown(true); }
  } else {
    $('pvp-countdown-num').textContent = String(num);
    if (pvpCountdownLastNum !== num) { pvpCountdownLastNum = num; sfx.countdown(false); }
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

applyLanguage();