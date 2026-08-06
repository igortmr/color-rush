import { $ } from './dom.js';
import { state } from './state.js';

// rodapé com links das redes sociais — mesmo bloquinho HTML colado no fim
// de CADA tela (não é fixo, é só mais um elemento normal dentro do fluxo de
// cada .screen), pra dar visibilidade das redes em qualquer lugar do jogo
// sem competir visualmente com o conteúdo enquanto joga. O índice "i" só
// existe pra cada cópia ter seu próprio id de gradiente (evita ids
// duplicados no HTML final, mesmo que o resultado visual seja idêntico).
//
// true só quando a página está rodando dentro do app nativo (Capacitor) --
// mesma checagem duplicada em auth.js/game-core.js (não vale a pena um
// módulo compartilhado só pra isso, ver padrão já usado nos outros).
const isNativeApp = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
// WKWebView (app nativo) desloca a origem do "position:fixed" pelo
// contentInset do scrollView -- enquanto o documento tinha scroll de
// verdade, isso empurrava de graça os elementos fixos ancorados no topo
// (ex.: .lang-switch) pra baixo do notch/Dynamic Island. Sem esse scroll
// (ver #scroll-area no CSS), esse empurrão some, e "top:10px" passa a
// cair embaixo do notch mesmo -- SÓ no app, o Safari nunca teve esse
// deslocamento (viewport-fit:cover só afeta contexto standalone/WebView,
// não uma aba normal do Safari). Por isso essa classe existe: compensa
// só no app, sem mexer no valor que já está certo no site.
if (isNativeApp()) document.documentElement.classList.add('is-native-app');

// ===== PAINEL DE DIAGNÓSTICO TEMPORÁRIO (remover depois de resolver o bug
// do .lang-switch grudado no topo no app nativo) =====
// Sem Mac/Xcode à mão pra abrir o Web Inspector no device, isso mostra os
// números reais direto na tela -- toque em qualquer lugar do painel pra
// esconder (não atrapalha o teste do resto do app depois de ler).
// sem gate de isNativeApp() e sem depender do evento "load" (nenhum dos
// dois é confiável o bastante aqui pra apostar tudo neles -- o painel
// simplesmente não apareceu da primeira vez, e não dá pra saber qual dos
// dois foi o culpado sem outro round de teste). Roda direto, protegido por
// try/catch pra nunca quebrar o resto do app se algo aqui der errado.
setTimeout(() => {
  try {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed; padding-top:env(safe-area-inset-top); padding-bottom:env(safe-area-inset-bottom); visibility:hidden;';
    document.body.appendChild(probe);
    const probeStyle = getComputedStyle(probe);
    const safeTop = probeStyle.paddingTop;
    const safeBottom = probeStyle.paddingBottom;
    probe.remove();

    const langSwitch = document.querySelector('.lang-switch');
    const lsRect = langSwitch ? langSwitch.getBoundingClientRect() : null;
    const lsStyle = langSwitch ? getComputedStyle(langSwitch) : null;
    const vv = window.visualViewport;

    const lines = [
      'DIAGNÓSTICO .lang-switch',
      'isNativeApp: ' + isNativeApp(),
      'html classes: ' + document.documentElement.className,
      'env(safe-area-inset-top): ' + safeTop,
      'env(safe-area-inset-bottom): ' + safeBottom,
      'lang-switch computed top: ' + (lsStyle ? lsStyle.top : 'n/a'),
      'lang-switch rect.top: ' + (lsRect ? lsRect.top.toFixed(1) : 'n/a'),
      'lang-switch rect.left: ' + (lsRect ? lsRect.left.toFixed(1) : 'n/a'),
      'lang-switch rect.height: ' + (lsRect ? lsRect.height.toFixed(1) : 'n/a'),
      '--ios-banner-offset: ' + (getComputedStyle(document.documentElement).getPropertyValue('--ios-banner-offset') || '(vazio)'),
      'window.innerWidth/innerHeight: ' + window.innerWidth + ' / ' + window.innerHeight,
      'visualViewport: ' + (vv ? `w=${vv.width} h=${vv.height} offsetTop=${vv.offsetTop} scale=${vv.scale}` : 'indisponível'),
      'Capacitor.getPlatform: ' + (window.Capacitor && window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : 'n/a'),
      'userAgent: ' + navigator.userAgent,
    ];

    const panel = document.createElement('div');
    panel.id = 'debug-diag-panel';
    panel.style.cssText = 'position:fixed; left:12px; right:12px; top:50%; transform:translateY(-50%); z-index:99999; background:rgba(0,0,0,0.92); color:#0f0; font-family:monospace; font-size:11px; line-height:1.5; padding:14px; border-radius:10px; border:2px solid #0f0; white-space:pre-wrap; word-break:break-all; max-height:80vh; overflow:auto;';
    panel.textContent = lines.join('\n');
    panel.addEventListener('click', () => panel.remove());
    document.body.appendChild(panel);
  } catch (e) {
    try {
      const panel = document.createElement('div');
      panel.style.cssText = 'position:fixed; left:12px; right:12px; top:50%; transform:translateY(-50%); z-index:99999; background:rgba(80,0,0,0.92); color:#fff; font-family:monospace; font-size:11px; padding:14px; border-radius:10px; white-space:pre-wrap; word-break:break-all;';
      panel.textContent = 'erro no painel de diagnóstico: ' + (e && e.message);
      panel.addEventListener('click', () => panel.remove());
      document.body.appendChild(panel);
    } catch (e2) { /* nada mais a fazer */ }
  }
}, 800); // dá tempo do layout/safe-area assentar

function socialLinksHtml(i) {
  // selo "Baixar na App Store" ao lado das redes -- SÓ fora do app nativo
  // (quem já está no app não precisa ser convidado a baixar de novo).
  // Diferente da faixa/popup (que se restringem por tipo de navegador),
  // este aparece em QUALQUER navegador, mobile ou desktop -- reforço passivo
  // sempre visível. data-app-store-badge: mesmo selo oficial da Apple, troca
  // de idioma automática (ver updateAppStoreBadges em bootstrap.js).
  const appStoreBadge = isNativeApp() ? '' : `
    <a class="social-app-store-link" href="https://apps.apple.com/app/id6794695684">
      <img class="social-app-store-badge" data-app-store-badge src="img/app-store-badge/badge-pt-br.svg" alt="Baixar na App Store">
    </a>`;
  return `
  <div class="social-links">
    <a class="social-link" href="https://instagram.com/colorrushsaga" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="igGrad-${i}" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#ffdb73"/>
            <stop offset="25%" stop-color="#fd5949"/>
            <stop offset="55%" stop-color="#d6249f"/>
            <stop offset="100%" stop-color="#285AEB"/>
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="20" height="20" rx="6" fill="none" stroke="url(#igGrad-${i})" stroke-width="2"/>
        <circle cx="12" cy="12" r="4.2" fill="none" stroke="url(#igGrad-${i})" stroke-width="2"/>
        <circle cx="17.4" cy="6.6" r="1.3" fill="url(#igGrad-${i})"/>
      </svg>
      <span>@colorrushsaga</span>
    </a>
    <a class="social-link" href="https://x.com/colorrushsaga" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#fff">
        <path d="M18.9 2H22l-7.6 8.7L23.3 22h-7l-5.5-7.2L4.5 22H1.4l8.1-9.3L1 2h7.2l5 6.6L18.9 2zm-1.2 18h1.7L6.4 4H4.6l13.1 16z"/>
      </svg>
      <span>@colorrushsaga</span>
    </a>${appStoreBadge}
  </div>`;
}
document.querySelectorAll('.screen').forEach((screen, i) => {
  // loading-screen nunca tem conteúdo de verdade (só "Carregando..." antes do
  // Firebase resolver quem é a pessoa) — não faz sentido mostrar as redes
  // sociais junto de um esqueleto vazio, então essa é a única tela que fica
  // de fora
  if (screen.id === 'loading-screen') return;
  screen.insertAdjacentHTML('beforeend', socialLinksHtml(i));
});

// ===== proteção global contra clique duplo/muito rápido =====
// alguns cliques disparam ações com consequência real no servidor (aceitar/
// recusar duelo, resgatar prêmio, comprar na loja, salvar nick...). Um
// clique duplo bem rápido (toque acidental, "ghost click" do celular, ou o
// dedo escorregando) pode disparar a mesma ação duas vezes antes da primeira
// terminar — já aconteceu de resgatar o mesmo prêmio da caixa de entrada
// duas vezes clicando rápido demais, precisando corrigir na mão no Firestore
// depois. Um tempo fixo curto (300ms) não é garantia nenhuma, porque a
// resposta do servidor pode demorar mais que isso (rede lenta, function fria
// etc.) — o que resolve de verdade é travar até a resposta chegar.
// Por isso o travamento aqui combina os dois: (1) um mínimo de 300ms sempre,
// pra cobrir ações que nem chamam o servidor, e (2) enquanto tiver alguma
// chamada ao servidor pendente (state.pendingServerCalls, incrementado/
// decrementado em `callable()`, ver game-teste.js), NENHUM clique novo
// passa — só libera de verdade quando a resposta (sucesso ou erro) chega.
// Em vez de mexer em cada botão um por um, um único listener no topo (fase
// de captura, roda ANTES de qualquer onclick) cobre tudo de uma vez.
// Fica de fora o jogo oficial (os grids de resposta: clássico/reverso/
// formas/formas reverso, desafio diário e PvP) — ali cada clique já tem sua
// própria trava (handleClick só aceita um clique por rodada, ver `playing`),
// e o ritmo do jogo pode exigir cliques bem mais rápidos que 300ms conforme
// a partida acelera, então esse travamento genérico não se aplica lá.
const CLICK_LOCK_MS = 300;
const CLICK_LOCK_EXCLUDE_SELECTOR = '#grid, #daily-grid, #pvp-grid';
document.addEventListener('click', (e) => {
  if (e.target.closest(CLICK_LOCK_EXCLUDE_SELECTOR)) return; // jogo oficial: sem travamento genérico
  const now = Date.now();
  if (now < state.clickLockedUntil || state.pendingServerCalls > 0) {
    e.stopPropagation();
    e.preventDefault();
    return;
  }
  state.clickLockedUntil = now + CLICK_LOCK_MS;
}, true);

export const show = id => {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  resetScroll(id);
};

// pilha de navegação — usada por telas que têm um botão "voltar" que depende
// de onde a pessoa veio (perfil, ranking). Antes disso, cada uma dessas
// telas guardava só 1 variável fixa "pra onde volta". Isso quebrava em
// cadeias mais profundas (ex.: perfil A -> ranking -> perfil B, clicando num
// nick de dentro do ranking -> ranking de novo): as 2 variáveis podiam
// acabar apontando uma pra outra, e "voltar" entrava num loop que nunca
// alcançava o menu de novo. Uma pilha de verdade resolve isso de forma
// estrutural — cada "voltar" sempre tira exatamente 1 nível dela, e ela só
// cresce quando alguém abre uma tela nova (nunca sozinha), então bate no
// fundo (menu) mais cedo ou mais tarde, não importa quantos níveis a pessoa
// empilhar antes.
let screenBackStack = [];
export function pushScreenAndShow(nextScreenId, cameFromScreenId) {
  screenBackStack.push(cameFromScreenId || 'menu-screen');
  show(nextScreenId);
}
export function popScreenBack() {
  show(screenBackStack.pop() || 'menu-screen');
}
// menu é a "raiz" da navegação — zera a pilha de "voltar" toda vez que quem
// chama (showMenu) decide voltar pra raiz, pra nunca ir acumulando entradas
// órfãs de sessões de perfil/ranking anteriores
export function resetScreenBackStack() {
  screenBackStack = [];
}

// depois de trocar o conteúdo de uma tela que já estava aberta (ex.: troca de
// aba do ranking), houve mais de um relato de tela ficando presa no topo sem
// rolar. Além de a página inteira ter passado a rolar de verdade (nada mais
// de overflow-y aninhado dentro de flexbox centralizado — ver comentário
// junto de .screen no <style>), isso aqui força um reflow e volta pro topo
// sempre que o conteúdo muda, como reforço extra.
export function resetScroll(screenId) {
  const el = $(screenId);
  if (!el) return;
  void el.offsetHeight; // força o navegador recalcular o layout
  const scrollArea = $('scroll-area');
  if (scrollArea) scrollArea.scrollTop = 0; // quem rola agora é #scroll-area, não mais o documento (ver comentário no CSS)
}
