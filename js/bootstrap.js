import { $ } from './dom.js';
import { state } from './state.js';
import { auth } from './firebase.js';
import { pushScreenAndShow } from './nav.js';
import { T } from './i18n.js';
import { isMuted, setMuted, tone, playCorrectSfxVariant } from './utils.js';
import { tutMode, tutStep, showTutStep } from './tutorial.js';
import { equippedSfx } from './shop.js';
import { mode, playing } from './game-core.js';
import './share.js';
import './nick.js';
import './menu.js';
import './auth.js';

// Universal Links (iOS): quando alguém toca um link de colorrush.com.br por
// fora do app (WhatsApp, Mensagens etc.) com o app já instalado, o iOS abre
// o app em vez do Safari (ver .well-known/apple-app-site-association +
// entitlement "associated-domains" no codemagic.yaml) e dispara esse evento
// com a URL tocada — navega o próprio WebView pra lá, reaproveitando toda a
// leitura de ?ref= que já acontece normalmente ao carregar a página (ver
// share.js), sem precisar de nenhuma lógica de rota nova. window.Capacitor
// (não um import de pacote) porque esta página roda remota, direto do site,
// dentro do WebView — sem bundler pra resolver "@capacitor/app" (mesmo
// padrão de window.Capacitor.Plugins já usado no login nativo, auth.js).
if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
  window.Capacitor.Plugins.App.addListener('appUrlOpen', (data) => {
    if (data && data.url) window.location.href = data.url;
  });
}

// faixa "baixe o app" -- no Safari o Smart App Banner nativo (ver
// <meta name="apple-itunes-app"> no <head> de index.html) já cobre o caso
// sozinho, então essa faixa custom só aparece nos OUTROS navegadores iOS
// (Chrome, Firefox etc.), que não ganham o banner nativo da Apple. Não dá
// pra detectar via JS se a pessoa já fechou o banner nativo do Safari (é um
// elemento do próprio navegador, sem API pra isso) -- por isso, no Safari,
// a faixa custom simplesmente nunca aparece, em vez de tentar adivinhar.
// Só em iPhone/iPad, fora do app nativo (mostrar isso pra quem já tem o
// app instalado não faz sentido nenhum), e só se a pessoa ainda não tiver
// fechado a faixa custom antes (guardado no localStorage, não expira).
const IOS_APP_BANNER_DISMISSED_KEY = 'colorRushIosBannerDismissed';
const IOS_APP_BANNER_BADGE_LOCALE = { pt: 'pt-br', en: 'en-us', es: 'es-mx' };
const IOS_APP_BANNER_BADGE_ALT = { pt: 'Baixar na App Store', en: 'Download on the App Store', es: 'Descargar en el App Store' };
// selo oficial da Apple (baixado de tools.applemediaservices.com), um SVG por
// idioma do jogo -- troca o src/alt junto com applyLanguage() (js/bootstrap.js)
function updateIosAppBannerBadge() {
  const img = $('ios-app-banner-badge');
  if (!img) return;
  const locale = IOS_APP_BANNER_BADGE_LOCALE[state.lang] || 'pt-br';
  img.src = `img/app-store-badge/badge-${locale}.svg`;
  img.alt = IOS_APP_BANNER_BADGE_ALT[state.lang] || IOS_APP_BANNER_BADGE_ALT.pt;
}
window.dismissIosAppBanner = () => {
  const el = $('ios-app-banner');
  if (el) el.style.display = 'none';
  document.body.style.paddingTop = ''; // volta pro padding normal (env(safe-area-inset-top)) do CSS
  document.documentElement.style.setProperty('--ios-banner-offset', '0px'); // combo de idioma sobe de volta (ver .lang-switch no CSS)
  try { localStorage.setItem(IOS_APP_BANNER_DISMISSED_KEY, '1'); } catch {}
};
(() => {
  const el = $('ios-app-banner');
  if (!el) return; // teste.html/index.html sem esse elemento (ou tela antiga em cache)
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  // "Safari de verdade" tem "Safari" na UA e nenhum token dos outros
  // navegadores iOS (todos usam WebKit por baixo, então também levam
  // "Safari" na UA -- CriOS = Chrome, FxiOS = Firefox, EdgiOS = Edge,
  // OPiOS = Opera; sem esses tokens, é o Safari mesmo).
  const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  if (!isIOS || isNative || isSafari) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem(IOS_APP_BANNER_DISMISSED_KEY) === '1'; } catch {}
  if (dismissed) return;
  updateIosAppBannerBadge();
  el.style.display = '';
  // a faixa é position:fixed (não empurra o body sozinha, ver comentário no
  // CSS) -- compensa manualmente o espaço que ela ocupa, com a altura REAL
  // dela (varia por causa da tradução/tamanho de tela), somada ao padding de
  // topo que já existia (env(safe-area-inset-top), notch etc.). O combo de
  // idioma (.lang-switch) usa a mesma var pra descer e não ficar por baixo.
  requestAnimationFrame(() => {
    document.body.style.paddingTop = `calc(env(safe-area-inset-top) + ${el.offsetHeight}px)`;
    document.documentElement.style.setProperty('--ios-banner-offset', `${el.offsetHeight}px`);
  });
})();

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
  updateIosAppBannerBadge();

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
