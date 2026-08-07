import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { isWeeklyPassActive } from './levels.js';

// Passe Semanal (IAP via RevenueCat) — R$9,90/US$1,99, dá por 7 dias a
// partir da compra: nick amarelo (ver applyWeeklyPassNickColor em
// js/levels.js), +500 Pigmentos (uma vez, na hora) e +1 tentativa no
// Desafio Diário (ver dailyMaxAttempts em js/daily-challenge.js). Quem
// credita de verdade é o webhook do RevenueCat (revenueCatWebhook em
// functions/index.js) — este arquivo só dispara a compra e reflete o
// estado na tela.
//
// AINDA NÃO À VENDA: card só aparece se config/features.weeklyPassOnSale
// (Firestore, documento público, ligado à mão no Firebase Console quando
// for a hora de lançar — mesmo padrão manual do campo "admin" em
// scores/{uid}) for true. Lido uma vez só ao abrir o menu, não é um
// listener — não precisa reagir em tempo real a essa flag mudando enquanto
// alguém já está com o app aberto.
//
// A "Public API Key" do RevenueCat NÃO é segredo (mesmo status da chave do
// Firebase já hardcoded em js/firebase.js — identifica o projeto, não
// autoriza nada sozinha) — fica direto aqui. Placeholder vazio até o
// usuário criar a conta RevenueCat e passar a chave de verdade (ver plano
// "Passe Semanal" — a compra simplesmente falha com string vazia, sem
// quebrar o resto do app).
const REVENUECAT_PUBLIC_API_KEY = '';
const WEEKLY_PASS_PRODUCT_ID = 'br.com.colorrush.app.weeklypass';

let weeklyPassOnSale = false;
let weeklyPassFlagChecked = false;
let weeklyPassPriceString = ''; // preço de verdade (localizado) vindo do RevenueCat, quando disponível

async function ensureWeeklyPassFlagLoaded() {
  if (weeklyPassFlagChecked) return;
  weeklyPassFlagChecked = true;
  try {
    const snap = await getDoc(doc(db, 'config', 'features'));
    weeklyPassOnSale = !!(snap.exists() && snap.data().weeklyPassOnSale === true);
  } catch { weeklyPassOnSale = false; }
}

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
// no RevenueCat — só cosmético (o texto do card antes de comprar); se falhar
// por qualquer motivo (produto ainda não configurado lá, sem internet etc.)
// cai no texto estático T[lang].weekly_pass_price, sem travar o card
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

function renderWeeklyPassCardContent() {
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

// chamado pelo showMenu() (mesmo padrão de updateGuildBattleCard em
// js/guild-battle.js / updateDailyMenuCard em js/daily-challenge.js) —
// mostra/esconde o card e atualiza o texto
export async function updateWeeklyPassCard() {
  const card = $('card-weekly-pass');
  if (!card) return;
  await ensureWeeklyPassFlagLoaded();
  // compra real só existe dentro do app nativo (mesmo raciocínio já
  // aplicado ao botão de Sign in with Apple, ver isNativeApp em js/nav.js —
  // checagem duplicada aqui de propósito, não compensa um módulo
  // compartilhado só pra isso, mesmo padrão já usado nos outros arquivos)
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (!weeklyPassOnSale || !isNative || state.offline || !state.currentUser || !state.myData.nick) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  renderWeeklyPassCardContent();
  if (!isWeeklyPassActive(state.myData)) {
    refreshWeeklyPassPricing().then(renderWeeklyPassCardContent);
  }
}

window.weeklyPassCardClick = async () => {
  // passe já ativo -- card é só informativo enquanto durar, comprar de novo
  // ainda funcionaria (empilha mais 7 dias, ver revenueCatWebhook em
  // functions/index.js) mas não é o que o toque no card faz aqui
  if (!weeklyPassOnSale || isWeeklyPassActive(state.myData)) return;
  const Purchases = purchasesPlugin();
  if (!Purchases) { alert(T[state.lang].guild_err_generic); return; }
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
      renderWeeklyPassCardContent();
      if (window.renderUserPigmentos) window.renderUserPigmentos();
    }, 2500);
  } catch (e) {
    if (e && (e.userCancelled || e.code === 'PURCHASE_CANCELLED')) { renderWeeklyPassCardContent(); return; } // cancelou -- sem alerta
    if (statusEl) statusEl.textContent = prevText;
    alert((e && e.message) || T[state.lang].guild_err_generic);
  }
};
