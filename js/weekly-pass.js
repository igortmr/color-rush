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
// NO NAVEGADOR (PC ou celular, sem o WebView do Capacitor): ainda não tem
// como comprar de verdade (falta o produto "Web Billing" do RevenueCat com
// Stripe conectado -- não configurado ainda), então lá o balão só aparece
// pra conta admin, mesmo que weeklyPassOnSale já esteja true (ver
// refreshWeeklyPassBubble abaixo). Clicar em comprar mostra um aviso de
// "em breve" em vez de tentar chamar o plugin nativo que não existe ali.
//
// A "Public API Key" do RevenueCat NÃO é segredo (mesmo status da chave do
// Firebase já hardcoded em js/firebase.js — identifica o projeto, não
// autoriza nada sozinha) — fica direto aqui. Chave do app "Color Rush Saga
// (App Store)" no projeto RevenueCat (obtida em API keys > SDK API keys).
const REVENUECAT_PUBLIC_API_KEY = 'appl_XWLAAoYZNgNPNhoBflUUUbJqmpD';
const WEEKLY_PASS_PRODUCT_ID = 'br.com.colorrush.app.weeklypass';

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

// busca o preço de verdade (localizado, ex. "R$ 9,90") na oferta configurada
// no RevenueCat — só cosmético (o texto do popup antes de comprar); se
// falhar por qualquer motivo (produto ainda não configurado lá, sem
// internet etc.) cai no texto estático T[lang].weekly_pass_price, sem
// travar o popup
async function refreshWeeklyPassPricing() {
  if (weeklyPassPriceString) return;
  try {
    const Purchases = await ensurePurchasesConfigured();
    if (!Purchases) return;
    const offerings = await Purchases.getOfferings();
    const pkgs = (offerings.current && offerings.current.availablePackages) || [];
    const pkg = pkgs.find(p => p.product && p.product.identifier === WEEKLY_PASS_PRODUCT_ID);
    if (pkg && pkg.product && pkg.product.priceString) weeklyPassPriceString = pkg.product.priceString;
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
  // no navegador (PC ou celular) ainda não existe forma de comprar de
  // verdade — falta o produto "Web Billing" do RevenueCat com Stripe
  // conectado, que ainda não foi configurado. Até isso existir, o balão só
  // aparece no navegador pra conta admin (mesmo campo scores/{uid}.admin de
  // canSeeWeeklyPass acima), pra dar pra conferir/testar a tela sem expor
  // pra ninguém mais — mesmo com weeklyPassOnSale já ligado pro app nativo.
  // Dentro do app nativo continua valendo a regra normal (canSeeWeeklyPass).
  const isAdmin = !!(state.myData && state.myData.admin === true);
  const visibleHere = isNative ? canSeeWeeklyPass() : isAdmin;
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

window.weeklyPassCardClick = async () => {
  // passe já ativo -- popup é só informativo enquanto durar, comprar de novo
  // ainda funcionaria (empilha mais 7 dias, ver revenueCatWebhook em
  // functions/index.js) mas não é o que o toque no botão faz aqui
  if (!canSeeWeeklyPass() || isWeeklyPassActive(state.myData)) return;
  const Purchases = purchasesPlugin();
  // sem o plugin nativo (navegador, ver isNative em refreshWeeklyPassBubble
  // acima) ainda não tem como comprar de verdade -- mensagem específica em
  // vez do erro genérico, já que quem chega aqui é só a conta admin
  // conferindo a tela (ver visibleHere em refreshWeeklyPassBubble)
  if (!Purchases) { alert(T[state.lang].weekly_pass_web_soon); return; }
  const statusEl = $('weekly-pass-status');
  const prevText = statusEl ? statusEl.textContent : '';
  try {
    if (statusEl) statusEl.textContent = T[state.lang].loading_text;
    await ensurePurchasesConfigured();
    const offerings = await Purchases.getOfferings();
    const pkgs = (offerings.current && offerings.current.availablePackages) || [];
    const pkg = pkgs.find(p => p.product && p.product.identifier === WEEKLY_PASS_PRODUCT_ID);
    if (!pkg) throw new Error('Produto do Passe Semanal ainda não configurado no RevenueCat.');
    await Purchases.purchasePackage({ aPackage: pkg });
    // quem credita de verdade (Pigmentos + weeklyPassExpiresAt) é o webhook,
    // do lado do servidor — aqui só espera um instante (tempo do RevenueCat
    // mandar o evento e a Cloud Function processar) e recarrega scores/{uid}
    // pra tela já refletir sem precisar reabrir o app
    setTimeout(async () => {
      try {
        const snap = await getDoc(doc(db, 'scores', state.currentUser.uid));
        if (snap.exists()) Object.assign(state.myData, snap.data());
      } catch {}
      renderWeeklyPassPopupContent();
      if (window.renderUserPigmentos) window.renderUserPigmentos();
    }, 2500);
  } catch (e) {
    if (e && (e.userCancelled || e.code === 'PURCHASE_CANCELLED')) { renderWeeklyPassPopupContent(); return; } // cancelou -- sem alerta
    if (statusEl) statusEl.textContent = prevText;
    alert((e && e.message) || T[state.lang].guild_err_generic);
  }
};
