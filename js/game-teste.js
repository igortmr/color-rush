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
import { ALL_MODES } from './constants.js';
import { isMuted, setMuted, tone, playCorrectSfxVariant, track } from './utils.js';
import { $ } from './dom.js';
import { state } from './state.js';
import {
  show, resetScroll, pushScreenAndShow, popScreenBack, resetScreenBackStack
} from './nav.js';
import { T, cName } from './i18n.js';
import {
  MODE_UNLOCK, avatarOrDefaultIcon, modeLabel, xpInfo, myXp, modeUnlocked
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
import { mode, score, playing, myRecord } from './game-core.js';
import { refreshInboxBadge, updateDailyMenuCard } from './daily-challenge.js';

// chamadas ao servidor: a pontuação final agora é validada lá,
// não é mais um simples write direto no Firestore vindo do navegador.
const callCreditReferral = callable('creditReferral');
const callSuggestFriendFromRef = callable('suggestFriendFromRef');
const callRecomputeTotal = callable('recomputeMyTotal');
const callDeleteMyAccount = callable('deleteMyAccount');
// troca o authorization code do login com Apple por um refresh token que o
// servidor guarda pra poder revogar na exclusão de conta (exigência da Apple,
// ver doApple/registerAppleAuthCode mais abaixo e functions/index.js)
const callRegisterAppleAuthCode = httpsCallable(functions, 'registerAppleAuthCode');
const callTouchActivity = httpsCallable(functions, 'touchActivity'); // batimento automático — não conta pro travamento de clique

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
// exposta em window pra js/daily-challenge.js poder conferir a versão antes
// de liberar uma tentativa, sem esperar a auto-atualização ganhar seu
// próprio módulo (fase futura)
window.isDailyClientUpToDate = isDailyClientUpToDate;

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

/* ================== ranking ================== */
// backTarget (2º parâmetro) é opcional — vira 'menu-screen' na pilha (ver
// pushScreenAndShow) pra quem abre ranking direto do menu (cards de modo,
// atalho "🏆 RANKING" etc.); profileRankGoto passa 'profile-screen' quando
// abre a partir do perfil de alguém.
window.showRanking = (tab, backTarget) => {
  pushScreenAndShow('ranking-screen', backTarget);
  window.loadRanking(tab || mode || 'classic'); // abre na aba pedida, ou no modo que a pessoa estava jogando
};


applyLanguage();

