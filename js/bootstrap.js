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
import './guilds.js';
// depois de guilds.js de propósito — refreshDmChatBubble (dentro de dms.js)
// confere a posição do balão de clã pra não sobrepor o de amigos, ver
// comentário junto de refreshDmChatBubble
import './dms.js';

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
//
// Checa window.Capacitor.Plugins.App antes de usar (em vez de assumir que
// existe) porque o site é carregado remoto pelo WebView, então esse código
// já roda pra quem ainda está com um binário mais antigo, sem o plugin
// "@capacitor/app" nativo (ex.: versão 1.1, aprovada antes desse plugin ser
// adicionado). Sem essa checagem, .addListener em undefined derrubava com
// exceção o topo do módulo inteiro na 1.1 -- travando tudo que é definido
// depois neste arquivo (window.showRanking, sfx, etc.), sem log nenhum.
if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
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
// idioma do jogo -- atualiza TODOS os selos da página de uma vez (a faixa do
// topo E o popup de lançamento pra desktop, ver mais abaixo), identificados
// por [data-app-store-badge] em vez de um id fixo cada -- troca junto com
// applyLanguage() (js/bootstrap.js)
function updateAppStoreBadges() {
  const locale = IOS_APP_BANNER_BADGE_LOCALE[state.lang] || 'pt-br';
  const alt = IOS_APP_BANNER_BADGE_ALT[state.lang] || IOS_APP_BANNER_BADGE_ALT.pt;
  document.querySelectorAll('[data-app-store-badge]').forEach(img => {
    img.src = `img/app-store-badge/badge-${locale}.svg`;
    img.alt = alt;
  });
}
window.dismissIosAppBanner = () => {
  const el = $('ios-app-banner');
  if (el) el.style.display = 'none';
  const scrollArea = $('scroll-area');
  if (scrollArea) scrollArea.style.paddingTop = ''; // volta pro padding normal (env(safe-area-inset-top)) do CSS
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
  updateAppStoreBadges();
  el.style.display = '';
  // a faixa é position:fixed (não empurra o body sozinha, ver comentário no
  // CSS) -- compensa manualmente o espaço que ela ocupa, com a altura REAL
  // dela (varia por causa da tradução/tamanho de tela), somada ao padding de
  // topo que já existia (env(safe-area-inset-top), notch etc.). O combo de
  // idioma (.lang-switch) usa a mesma var pra descer e não ficar por baixo.
  requestAnimationFrame(() => {
    const scrollArea = $('scroll-area');
    if (scrollArea) scrollArea.style.paddingTop = `calc(env(safe-area-inset-top) + ${el.offsetHeight}px)`;
    document.documentElement.style.setProperty('--ios-banner-offset', `${el.offsetHeight}px`);
  });
})();

// popup "Color Rush já está no iPhone" -- só em navegador de COMPUTADOR (nem
// iOS nem Android, mesmo em navegador comum), já que quem acessa pelo
// celular já vê a faixa acima (ou já está no app). No PC não existe nenhum
// aviso hoje de que o jogo lançou pro iOS, então isso cobre esse buraco. 1x
// por dispositivo (localStorage, não expira, mesmo padrão da faixa acima) --
// fecha tanto pelo X quanto clicando fora do card (ver modal-overlay/onclick
// no HTML), os dois marcam como visto.
const IOS_LAUNCH_MODAL_DISMISSED_KEY = 'colorRushIosLaunchModalDismissed';
window.dismissIosLaunchModal = () => {
  const el = $('ios-launch-modal');
  if (el) el.style.display = 'none';
  try { localStorage.setItem(IOS_LAUNCH_MODAL_DISMISSED_KEY, '1'); } catch {}
};
(() => {
  const el = $('ios-launch-modal');
  if (!el) return; // teste.html/index.html sem esse elemento (ou tela antiga em cache)
  const ua = navigator.userAgent;
  const isMobile = /iPhone|iPad|iPod|Android|Mobi/i.test(ua);
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (isMobile || isNative) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem(IOS_LAUNCH_MODAL_DISMISSED_KEY) === '1'; } catch {}
  if (dismissed) return;
  updateAppStoreBadges();
  el.style.display = '';
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
  updateAppStoreBadges();

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
  // sem "path=" de propósito — antes só contava commit que tocasse
  // index.html, então mudança só em CSS/outro JS (ex.: css/style-teste.css,
  // js/ranking-cache.js) nunca aparecia aqui nem disparava o auto-reload
  // abaixo, mesmo já estando no ar
  const res = await fetch('https://api.github.com/repos/igortmr/color-rush/commits?per_page=1');
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

// confere se o client está na versão mais nova antes de liberar QUALQUER
// partida (modos livres, diário, duelo PvP...) — toda pontuação depende da
// lógica do cliente bater com a que o servidor espera (paleta de cores,
// modo sorteado, RNG determinística, regras de pontuação etc.), então uma
// versão desatualizada pode gerar um resultado que o servidor rejeita, ou
// pior, uma forma antiga de pontuar que já foi corrigida/removida por bug.
// Fail-open: se não der pra confirmar (1ª busca do load ainda não terminou,
// ou a requisição falha agora), deixa jogar — só barra quando dá pra
// confirmar de verdade que saiu versão nova.
async function isClientUpToDate() {
  try {
    const sha = await fetchLatestSha();
    if (!sha || !loadedSha) return true;
    return sha === loadedSha;
  } catch {
    return true;
  }
}
// exposta em window pra qualquer domínio que inicia uma partida (game-core.js,
// pvp.js, daily-challenge.js) poder conferir a versão antes de liberar
window.isClientUpToDate = isClientUpToDate;

// recarrega a página buscando a versão mais nova (bypassa o cache do HTML
// via ?v=) — usada tanto pelo auto-reload silencioso abaixo quanto pelo
// botão "Atualizar agora" do #outdated-version-modal
function reloadToLatest(sha) {
  document.getElementById('version-tag').textContent = '🔄 atualizando...';
  setTimeout(() => location.replace(`${location.pathname}?v=${sha ? sha.slice(0, 7) : Date.now()}`), 600);
}
// chamada pelo #outdated-version-modal (ver isClientUpToDate acima) — busca
// a sha mais nova de novo na hora do clique, não confia em loadedSha (que
// nunca é atualizado fora do reload de verdade, de propósito)
window.forceReloadNow = async () => {
  let sha = null;
  try { sha = await fetchLatestSha(); } catch {}
  reloadToLatest(sha);
};
// mostrada por qualquer início de partida bloqueado (ver isClientUpToDate) —
// avisa e deixa a pessoa decidir quando recarregar, em vez de arrancar a
// página debaixo dela sem avisar
window.showOutdatedVersionModal = () => {
  document.getElementById('outdated-version-modal').style.display = 'flex';
};
window.closeOutdatedVersionModal = () => {
  document.getElementById('outdated-version-modal').style.display = 'none';
};

// se sair versão nova no GitHub, recarrega sozinho — mas nunca no meio de uma partida
async function checkForUpdate() {
  if (playing || document.hidden) return;
  try {
    const sha = await fetchLatestSha();
    if (!sha) return;
    if (!loadedSha) { loadedSha = sha; return; } // primeira busca falhou no load; só registra
    if (sha !== loadedSha) reloadToLatest(sha);
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
// tick de confirmação em QUALQUER <button> (ou .mode-card — os cards de
// modo na tela inicial são <div onclick>, não <button>, mas também "iniciam
// uma ação" igual um botão) clicado fora de uma partida — menus, telas,
// modais etc. Delegado num listener só no document (em vez de um em cada
// botão) porque cobre também os que nascem depois via JS (ranking, chat
// etc.) sem precisar lembrar de religar em cada lugar novo. Fase de CAPTURA
// (3º argumento "true"), não a de bolha default: vários cliques do app
// chamam event.stopPropagation() pra não disparar o onclick de um ancestral
// (ex.: o "❓ Como jogar" dentro de um .mode-card, pra não also iniciar a
// partida do card) — isso corta a propagação ANTES de chegar num listener
// de bolha no document, mas um listener de CAPTURA roda antes disso (a
// captura desce da raiz até o alvo, de fora pra dentro, antes da fase de
// bolha nem começar), então continua vendo o clique mesmo assim.
// Não entra durante uma partida: os quadrados do tabuleiro são <div>, não
// <button>/.mode-card (ver newRound em game-core.js), então o closest()
// abaixo já não bate neles sozinho — o "if (playing) return" é só reforço
// pro raro caso de algum <button> real aparecer por cima do tabuleiro no
// meio da rodada; sem isso ia soar duplicado/errado em cima do som de
// acerto/erro que o próprio clique no quadrado já tem (ver handleClick).
// "playing" é um live binding de módulo ES (import de cima), por isso
// reflete o valor atual sem precisar reimportar a cada clique.
document.addEventListener('click', (e) => {
  if (playing) return;
  const el = e.target.closest('button, .mode-card');
  if (!el || el.disabled) return;
  // opt-out pontual — hoje só o toggle de efeitos sonoros do painel de
  // configurações (teste.html) usa isso: como esse listener é de CAPTURA
  // (roda antes do próprio onclick do botão), um tique genérico aqui
  // tocaria com o estado de mudo de ANTES do toggle rodar — exatamente
  // invertido do que faz sentido (tocar ao desligar, ficar mudo ao ligar).
  // O onclick de quem marcar esse atributo decide o som certo por conta
  // própria, na hora certa (depois de já ter mudado o estado).
  if (el.hasAttribute('data-no-click-tick')) return;
  sfx.tick();
}, true);
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
