import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { isWeeklyPassActive, pigmentIconSvg } from './levels.js';

// Passe Semanal (IAP via RevenueCat) — R$9,90/US$1,99, dá por 7 dias a
// partir da compra: nick amarelo (ver applyWeeklyPassNickColor em
// js/levels.js), +500 Pigmentos (uma vez, na hora) e +1 tentativa no
// Desafio Diário (ver dailyMaxAttempts em js/daily-challenge.js). Quem
// credita de verdade é o webhook do RevenueCat (revenueCatWebhook em
// functions/index.js) — este arquivo só dispara a compra e reflete o
// estado na tela.
//
// UI: balãozinho flutuante amarelo (mesmo padrão dos de clã/amigos, ver
// refreshGuildChatBubble em js/guilds.js / refreshDmChatBubble em
// js/dms.js), empilhado por cima dos dois — abre um popup com a oferta ao
// clicar, em vez de um card fixo na tela principal.
//
// AINDA NÃO À VENDA: dentro do app nativo, balão só aparece se
// config/features.weeklyPassOnSale (Firestore, documento público, ligado à
// mão no Firebase Console quando for a hora de lançar) for true -- OU se a
// conta for admin (ver canSeeWeeklyPass abaixo), pra dar pra conferir/testar
// sem expor pra ninguém mais. Lido uma vez só, não é um listener — não
// precisa reagir em tempo real a essa flag mudando enquanto alguém já está
// com o app aberto.
//
// NO NAVEGADOR (PC ou celular, sem o WebView do Capacitor): compra de
// verdade via RevenueCat Web Billing (Stripe por trás) já está configurada
// (produto `weekly_pass_web`, mesma offering `default`/package `$rc_weekly`
// do app nativo, ver isAdminAccount abaixo) -- mas SÓ pra conta admin,
// independente de weeklyPassOnSale, porque ainda não passou por teste real
// de compra nem foi decidido abrir pra todo mundo no navegador. Trocar isso
// exigiria decisão separada (não é só ligar weeklyPassOnSale).
//
// A "Public API Key" do RevenueCat NÃO é segredo (mesmo status da chave do
// Firebase já hardcoded em js/firebase.js — identifica o projeto, não
// autoriza nada sozinha) — fica direto aqui. Chave do app nativo é do app
// "Color Rush Saga (App Store)"; as chaves web são do app "Color Rush Saga
// (RevenueCat Billing)" -- Web Billing tem uma Public API Key (cobra de
// verdade) e uma Sandbox API Key (testes, sem cobrar) separadas, ambas
// obtidas em Apps → Web → API keys no painel do RevenueCat.
const REVENUECAT_PUBLIC_API_KEY = 'appl_XWLAAoYZNgNPNhoBflUUUbJqmpD';
const WEEKLY_PASS_PRODUCT_ID = 'br.com.colorrush.app.weeklypass';
const REVENUECAT_WEB_PUBLIC_API_KEY = 'rcb_ZOpahmiKUlfXCfPtCofeHdfgOrHG';
const REVENUECAT_WEB_SANDBOX_API_KEY = 'rcb_sb_YYDbtJirtbEKdukwXxxvzHaCh';
const WEEKLY_PASS_WEB_PRODUCT_ID = 'weekly_pass_web';
// TROCAR PRA false SÓ QUANDO estiver pronto pra cobrar de verdade no
// navegador (mesmo cartão de teste do Stripe funciona em modo sandbox, sem
// mover dinheiro real) -- enquanto for true, toda compra web (mesmo da
// conta admin) usa REVENUECAT_WEB_SANDBOX_API_KEY em vez da pública.
const WEB_PURCHASES_SANDBOX_MODE = true;
// SDK Web do RevenueCat, via CDN (mesmo padrão do Firebase acima -- este
// arquivo roda direto do site, sem bundler). Versão travada de propósito
// (mesmo motivo do Firebase pinado em js/firebase.js): atualizar não pode
// quebrar o fluxo de compra sem a gente notar. dist/style.css é o CSS que o
// modal de checkout injetado pelo SDK espera -- só é carregado quando o
// fluxo web de verdade é usado (ver loadPurchasesJs abaixo), não pra todo
// mundo.
const PURCHASES_JS_VERSION = '1.51.2';
const PURCHASES_JS_URL = `https://cdn.jsdelivr.net/npm/@revenuecat/purchases-js@${PURCHASES_JS_VERSION}/dist/Purchases.es.js`;
const PURCHASES_JS_CSS_URL = `https://cdn.jsdelivr.net/npm/@revenuecat/purchases-js@${PURCHASES_JS_VERSION}/dist/style.css`;

let weeklyPassOnSale = false;
let weeklyPassFlagChecked = false;
let weeklyPassPriceString = ''; // preço de verdade (localizado) vindo do RevenueCat, quando disponível
let weeklyPassPopupOpen = false;

async function ensureWeeklyPassFlagLoaded() {
  if (weeklyPassFlagChecked) return;
  weeklyPassFlagChecked = true;
  try {
    const snap = await getDoc(doc(db, 'config', 'features'));
    weeklyPassOnSale = !!(snap.exists() && snap.data().weeklyPassOnSale === true);
  } catch { weeklyPassOnSale = false; }
}

// libera o balão/compra pra conta admin mesmo com weeklyPassOnSale
// desligado (mesmo campo "admin" de scores/{uid}, "setado à mão no Firebase
// Console", já usado em todo o resto do jogo) -- serve tanto pro usuário
// conferir como o balão está ficando antes do lançamento, quanto pro
// revisor da Apple testar a compra de verdade durante a revisão, dando pra
// conta de revisão (App Store Connect > App Review Information >
// Sign-In Required) um scores/{uid}.admin = true SEM precisar ligar a flag
// pra todo mundo.
function canSeeWeeklyPass() {
  return weeklyPassOnSale || (state.myData && state.myData.admin === true);
}

// mesmo campo scores/{uid}.admin usado acima, isolado numa função porque o
// navegador (ver comentário grande no topo do arquivo) usa SÓ isso, sem o
// "OU weeklyPassOnSale" de canSeeWeeklyPass -- a compra web ainda não foi
// aberta pro público mesmo quando o app nativo já estiver à venda
function isAdminAccount() {
  return !!(state.myData && state.myData.admin === true);
}

// mesmas telas "principais" do balão de chat único (ver
// DM_CHAT_BUBBLE_SCREENS em js/dms.js) — fora dessas, some sozinho (não
// atrapalha uma partida/duelo em andamento)
const WEEKLY_PASS_BUBBLE_SCREENS = new Set([
  'menu-screen', 'shop-screen', 'ranking-screen', 'replay-screen',
  'profile-screen', 'friends-screen', 'guild-list-screen', 'guild-screen',
]);

// plugin nativo (@revenuecat/purchases-capacitor) — acessado via
// window.Capacitor.Plugins (SEM import de pacote: esta página roda remota,
// direto do site, dentro do WebView, sem bundler pra resolver um specifier
// de npm — mesmo padrão já usado pro login nativo, ver window.Capacitor.Plugins
// em js/auth.js). Guard duplo (existe o objeto E existe a chave) porque um
// binário mais velho ainda instalado pode não ter esse plugin ainda (mesma
// cautela já documentada pra outros plugins adicionados depois do primeiro
// build aprovado).
function purchasesPlugin() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases) || null;
}

let purchasesConfigured = false;
async function ensurePurchasesConfigured() {
  const Purchases = purchasesPlugin();
  if (!Purchases || purchasesConfigured) return Purchases;
  await Purchases.configure({ apiKey: REVENUECAT_PUBLIC_API_KEY, appUserID: state.currentUser.uid });
  purchasesConfigured = true;
  return Purchases;
}

// carrega o SDK Web do RevenueCat (módulo ES + CSS do checkout, ver
// PURCHASES_JS_URL/PURCHASES_JS_CSS_URL acima) só na primeira vez que
// alguém realmente tenta comprar pelo navegador -- promise memoizada pra
// não disparar o import()/<link> duas vezes se o clique acontecer de novo
// antes do primeiro carregar
let purchasesJsLoadPromise = null;
function loadPurchasesJs() {
  if (!purchasesJsLoadPromise) {
    purchasesJsLoadPromise = (async () => {
      if (!document.querySelector('link[data-purchases-js-css]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = PURCHASES_JS_CSS_URL;
        link.dataset.purchasesJsCss = 'true';
        document.head.appendChild(link);
      }
      return import(PURCHASES_JS_URL);
    })();
  }
  return purchasesJsLoadPromise;
}

let webPurchasesInstance = null;
async function ensureWebPurchasesConfigured() {
  if (webPurchasesInstance) return webPurchasesInstance;
  const { Purchases } = await loadPurchasesJs();
  const apiKey = WEB_PURCHASES_SANDBOX_MODE ? REVENUECAT_WEB_SANDBOX_API_KEY : REVENUECAT_WEB_PUBLIC_API_KEY;
  webPurchasesInstance = Purchases.configure({ apiKey, appUserId: state.currentUser.uid });
  return webPurchasesInstance;
}

// busca o preço de verdade (localizado, ex. "R$ 9,90") na oferta configurada
// no RevenueCat — só cosmético (o texto do popup antes de comprar); se
// falhar por qualquer motivo (produto ainda não configurado lá, sem
// internet etc.) cai no texto estático T[lang].weekly_pass_price, sem
// travar o popup
async function refreshWeeklyPassPricing() {
  if (weeklyPassPriceString) return;
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  try {
    if (isNative) {
      const Purchases = await ensurePurchasesConfigured();
      if (!Purchases) return;
      const offerings = await Purchases.getOfferings();
      const pkgs = (offerings.current && offerings.current.availablePackages) || [];
      const pkg = pkgs.find(p => p.product && p.product.identifier === WEEKLY_PASS_PRODUCT_ID);
      if (pkg && pkg.product && pkg.product.priceString) weeklyPassPriceString = pkg.product.priceString;
    } else {
      // navegador -- só admin chega aqui (ver isAdminAccount), sem risco de
      // carregar o SDK web/pedir preço do Stripe pra usuário nenhum
      if (!isAdminAccount()) return;
      const purchases = await ensureWebPurchasesConfigured();
      const offerings = await purchases.getOfferings();
      const pkgs = (offerings.current && offerings.current.availablePackages) || [];
      const pkg = pkgs.find(p => p.webBillingProduct && p.webBillingProduct.identifier === WEEKLY_PASS_WEB_PRODUCT_ID);
      const price = pkg && pkg.webBillingProduct && pkg.webBillingProduct.price;
      if (price && price.formattedPrice) weeklyPassPriceString = price.formattedPrice;
    }
  } catch { /* melhor esforço -- cai no preço estático */ }
}

function renderWeeklyPassPopupContent() {
  const statusEl = $('weekly-pass-status');
  if (!statusEl) return;
  if (isWeeklyPassActive(state.myData)) {
    const expMs = state.myData.weeklyPassExpiresAt.toMillis();
    const localeTag = state.lang === 'en' ? 'en-US' : state.lang === 'es' ? 'es-ES' : 'pt-BR';
    const dateStr = new Date(expMs).toLocaleDateString(localeTag);
    statusEl.textContent = T[state.lang].weekly_pass_active_until(dateStr);
  } else {
    statusEl.textContent = weeklyPassPriceString || T[state.lang].weekly_pass_price;
  }
}

// chamada sempre que a tela ativa muda (ver MutationObserver no fim do
// arquivo, mesmo padrão de refreshGuildChatBubble/refreshDmChatBubble) —
// decide se o balão aparece e em cima de qual altura (empilhado acima do
// balão de chat, se estiver visível)
async function refreshWeeklyPassBubble() {
  const bubble = $('weekly-pass-bubble');
  if (!bubble) return;
  await ensureWeeklyPassFlagLoaded();
  // checagem duplicada de propósito (mesmo raciocínio já aplicado ao botão
  // de Sign in with Apple, ver isNativeApp em js/nav.js) — não compensa um
  // módulo compartilhado só pra isso, mesmo padrão já usado nos outros
  // arquivos
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  // no navegador o balão só aparece pra conta admin (ver isAdminAccount e o
  // comentário grande no topo do arquivo) -- dentro do app nativo continua
  // valendo a regra normal (canSeeWeeklyPass, que inclui weeklyPassOnSale)
  const visibleHere = isNative ? canSeeWeeklyPass() : isAdminAccount();
  const active = document.querySelector('.screen.active');
  const eligible = !!(active && WEEKLY_PASS_BUBBLE_SCREENS.has(active.id) && visibleHere
    && !state.offline && state.currentUser && state.myData.nick);
  bubble.style.display = eligible ? 'flex' : 'none';
  // empilha por cima do balão de chat (agora ÚNICO, amigos+clã em abas — ver
  // js/dms.js) se ele estiver visível nesse instante (mesma ideia de
  // refreshDmChatBubble) -- depende dele já ter sido atualizado neste mesmo
  // ciclo, por isso este módulo é importado por último em js/bootstrap.js/
  // js/game-teste.js
  const dmBubble = $('dm-chat-bubble');
  const stackedBelow = (dmBubble && dmBubble.style.display !== 'none') ? 1 : 0;
  const baseBottom = 20 + stackedBelow * 68;
  bubble.style.bottom = baseBottom + 'px';
  const popup = $('weekly-pass-popup');
  if (popup) popup.style.bottom = (baseBottom + 68) + 'px';
  if (!eligible && weeklyPassPopupOpen) window.toggleWeeklyPassPopup();
}

function setupWeeklyPassBubbleWatcher() {
  const observer = new MutationObserver(() => refreshWeeklyPassBubble());
  document.querySelectorAll('.screen').forEach(s => observer.observe(s, { attributes: true, attributeFilter: ['class'] }));
}
setupWeeklyPassBubbleWatcher();

// ícone de verdade dos Pigmentos (gota com gradiente colorido, mesmo usado
// em todo o resto do jogo -- ver pigmentIconSvg em js/levels.js), em vez do
// emoji 💧 (cor fixa, não bate com o resto do app). O texto do popup vem de
// data-i18n-html (troca o innerHTML inteiro a cada idioma/render, ver
// applyLanguage em js/bootstrap.js), então um <span id="weekly-pass-pigment-icon">
// vazio serve de marcador -- observa a mesma div e reinjeta toda vez que o
// conteúdo é trocado (idioma mudando, popup reabrindo etc.), sem precisar
// que bootstrap.js saiba desse detalhe. Checa se já tem <svg> dentro antes
// de reinjetar pra não entrar em loop (a própria injeção também é uma
// mutação dentro da árvore observada).
function injectWeeklyPassPigmentIcon() {
  const el = $('weekly-pass-pigment-icon');
  if (!el || el.querySelector('svg')) return;
  el.innerHTML = pigmentIconSvg(16);
}
function setupWeeklyPassPigmentIconWatcher() {
  const body = document.querySelector('.weekly-pass-popup-body');
  if (!body) return;
  const observer = new MutationObserver(() => injectWeeklyPassPigmentIcon());
  observer.observe(body, { childList: true, subtree: true });
  injectWeeklyPassPigmentIcon();
}
setupWeeklyPassPigmentIconWatcher();

window.toggleWeeklyPassPopup = () => {
  weeklyPassPopupOpen = !weeklyPassPopupOpen;
  const popup = $('weekly-pass-popup');
  popup.style.display = weeklyPassPopupOpen ? 'flex' : 'none';
  if (weeklyPassPopupOpen) {
    renderWeeklyPassPopupContent();
    if (!isWeeklyPassActive(state.myData)) refreshWeeklyPassPricing().then(renderWeeklyPassPopupContent);
  }
};

// comum aos dois fluxos (nativo/web) -- webhook do RevenueCat
// (revenueCatWebhook em functions/index.js) é quem credita de verdade
// (Pigmentos + weeklyPassExpiresAt); aqui só espera um instante (tempo do
// evento chegar e a Cloud Function processar) e recarrega scores/{uid} pra
// tela já refletir sem precisar recarregar a página/reabrir o app
function reloadMyScoreAfterPurchase() {
  setTimeout(async () => {
    try {
      const snap = await getDoc(doc(db, 'scores', state.currentUser.uid));
      if (snap.exists()) Object.assign(state.myData, snap.data());
    } catch {}
    renderWeeklyPassPopupContent();
    if (window.renderUserPigmentos) window.renderUserPigmentos();
  }, 2500);
}

window.weeklyPassCardClick = async () => {
  // passe já ativo -- popup é só informativo enquanto durar, comprar de novo
  // ainda funcionaria (empilha mais 7 dias, ver revenueCatWebhook em
  // functions/index.js) mas não é o que o toque no botão faz aqui
  if (isWeeklyPassActive(state.myData)) return;
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const statusEl = $('weekly-pass-status');
  const prevText = statusEl ? statusEl.textContent : '';

  if (isNative) {
    if (!canSeeWeeklyPass()) return;
    const Purchases = purchasesPlugin();
    if (!Purchases) { alert(T[state.lang].guild_err_generic); return; }
    try {
      if (statusEl) statusEl.textContent = T[state.lang].loading_text;
      await ensurePurchasesConfigured();
      const offerings = await Purchases.getOfferings();
      const pkgs = (offerings.current && offerings.current.availablePackages) || [];
      const pkg = pkgs.find(p => p.product && p.product.identifier === WEEKLY_PASS_PRODUCT_ID);
      if (!pkg) throw new Error('Produto do Passe Semanal ainda não configurado no RevenueCat.');
      await Purchases.purchasePackage({ aPackage: pkg });
      reloadMyScoreAfterPurchase();
    } catch (e) {
      if (e && (e.userCancelled || e.code === 'PURCHASE_CANCELLED')) { renderWeeklyPassPopupContent(); return; } // cancelou -- sem alerta
      if (statusEl) statusEl.textContent = prevText;
      alert((e && e.message) || T[state.lang].guild_err_generic);
    }
    return;
  }

  // navegador -- só admin (ver comentário grande no topo do arquivo);
  // checagem redundante de propósito (mesma cautela do resto do arquivo),
  // já que quem não é admin nem consegue ver o botão pra clicar nele
  if (!isAdminAccount()) return;
  try {
    if (statusEl) statusEl.textContent = T[state.lang].loading_text;
    const purchases = await ensureWebPurchasesConfigured();
    const offerings = await purchases.getOfferings();
    const pkgs = (offerings.current && offerings.current.availablePackages) || [];
    const pkg = pkgs.find(p => p.webBillingProduct && p.webBillingProduct.identifier === WEEKLY_PASS_WEB_PRODUCT_ID);
    if (!pkg) throw new Error('Produto do Passe Semanal (web) ainda não configurado no RevenueCat.');
    // sem htmlTarget -- o próprio SDK cria e mostra um modal de checkout
    // (com o dist/style.css carregado em loadPurchasesJs) por cima da
    // página; customerEmail evita que ele peça o e-mail de novo, já que a
    // conta já está logada
    await purchases.purchase({ rcPackage: pkg, customerEmail: state.currentUser.email || undefined });
    reloadMyScoreAfterPurchase();
  } catch (e) {
    if (e && e.errorCode === 1 /* ErrorCode.UserCancelledError */) { renderWeeklyPassPopupContent(); return; } // cancelou -- sem alerta
    if (statusEl) statusEl.textContent = prevText;
    alert((e && e.message) || T[state.lang].guild_err_generic);
  }
};
