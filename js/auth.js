import {
  onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, GoogleAuthProvider, OAuthProvider, signInWithPopup,
  signInWithCredential, signOut, sendEmailVerification
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { auth, db, functions, callable } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { show } from './nav.js';
import { T } from './i18n.js';
import { track } from './utils.js';
import { ALL_MODES } from './constants.js';
import { applyEquippedCosmetics } from './shop.js';
import { submitPendingScore } from './profile.js';
import { startPvpListener, stopPvpListener } from './pvp.js';
import { getReferrerCode, clearReferrerCode } from './share.js';
import { syncRefCodeField, resetNickConsent } from './nick.js';

const callSuggestFriendFromRef = callable('suggestFriendFromRef');
const callRecomputeTotal = callable('recomputeMyTotal');
const callDeleteMyAccount = callable('deleteMyAccount');
const callRegisterPushToken = callable('registerPushToken');
// troca o authorization code do login com Apple por um refresh token que o
// servidor guarda pra poder revogar na exclusão de conta (exigência da Apple,
// ver doApple/registerAppleAuthCode mais abaixo e functions/index.js)
const callRegisterAppleAuthCode = httpsCallable(functions, 'registerAppleAuthCode');
const callTouchActivity = httpsCallable(functions, 'touchActivity'); // batimento automático — não conta pro travamento de clique

// Geral = soma dos recordes em TODOS os modos (conta 0 pro modo ainda não jogado)
const computeTotal = (overrideMode, overrideScore) =>
  ALL_MODES.reduce((sum, k) => sum + (k === overrideMode ? overrideScore : (state.myData[k] || 0)), 0);

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
// pede permissão e registra o dispositivo pra notificação push, só dentro do
// app nativo, uma vez por sessão (chamado em proceedAfterLogin mais abaixo).
// Melhor esforço: qualquer falha aqui fica só no console, nunca atrapalha o
// login/uso normal do jogo (mesmo padrão do sendPushToUser no servidor, ver
// functions/index.js).
let nativePushInitDone = false;
async function initNativePush() {
  if (nativePushInitDone || !isNativeApp()) return;
  nativePushInitDone = true;
  try {
    const PushNotifications = window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
    if (!PushNotifications) return;
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;
    PushNotifications.addListener('registration', (token) => {
      callRegisterPushToken({ token: token.value }).catch(() => {});
    });
    PushNotifications.addListener('registrationError', (err) => {
      console.warn('[push] erro de registro', err);
    });
    await PushNotifications.register();
  } catch (e) {
    console.warn('[push] indisponível', e);
  }
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
  window.showMenu();
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
    initNativePush(); // sem await de propósito: nunca deve atrasar a entrada no menu
    // já tem conta — se chegou (ou já estava logada) com o link de convite de
    // alguém, sugere amizade em segundo plano, sem travar a entrada no menu
    // (mesmo caso de quem acabou de criar a conta, ver saveNick/creditReferral)
    const referrerCode = getReferrerCode();
    if (referrerCode) {
      callSuggestFriendFromRef({ refCode: referrerCode }).catch(() => {});
      clearReferrerCode();
    }
    window.showMenu();
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
