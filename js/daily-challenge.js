import {
  doc, getDoc, getDocs, collection, query, where, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { db, functions, callable } from './firebase.js';
import { $, withBtnLoading } from './dom.js';
import { state } from './state.js';
import { show, resetScroll } from './nav.js';
import { T, cName } from './i18n.js';
import { track, seededPick, seededShuffle, mulberry32, hashSeed, jitterHex } from './utils.js';
import {
  SQUARES, poolItemId, DAILY_ROTATION_MODES, DAILY_MAX_ATTEMPTS, DAILY_COLORS,
  DAILY_PALETTE_OVERRIDE, DAILY_SHAPES_OVERRIDE, poolFor
} from './constants.js';
import { levelFromXp, myXp, pigmentIconSvg, blockIfBanned, isWeeklyPassActive, renderMenuXpBar } from './levels.js';
import { renderMenuPigmentosBar, renderUserPigmentos } from './shop.js';
import { spawnConfetti } from './game-core.js';
import { saveMatchReplayWithRetry } from './replay.js';
import { computeMyDailyTodayRank } from './daily-ranking.js';

// desafio diário — mesmo esquema de sessão/validação de tempo do modo normal
// (ver startDailyAttempt/submitDailyResult em functions/index.js)
const callStartDailyAttempt = callable('startDailyAttempt');
const callSubmitDailyResult = callable('submitDailyResult');
const callClaimDailyReward = callable('claimDailyReward');
// recarimba o início real da tentativa do desafio diário pro instante em que
// a contagem "3, 2, 1, Vai!" termina e o tabuleiro libera de vez — mesmo
// padrão "dispare e esqueça" de callSyncProgress abaixo, não passa pelo
// wrapper callable() pelo mesmo motivo.
const callArmDailySession = httpsCallable(functions, 'armDailySession');
const callSyncProgress = httpsCallable(functions, 'syncRoundProgress');

// desafio diário — estado separado do jogo normal (não usa "mode"/"score" etc.
// do modo livre, pra não arriscar misturar com uma partida solo aberta em paralelo)
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
// exportada como binding ao vivo (mesmo padrão de tutMode/tutStep em
// tutorial.js) — lida por js/game-core.js (recordReplayMouseSample) pra
// saber se deve gravar o rastro do mouse no tabuleiro do desafio em vez do
// modo livre
export let dailyPlaying = false;
let dailyPendingRoundSync = []; // mesma ideia de pendingRoundSync (modo livre), mas pra tentativa do
                                 // desafio diário — também guarda a chamada que recarimba o início real
                                 // da tentativa depois do "Vai!" (ver callArmDailySession)
// mesma ideia de replayRounds/replayMouse/replayStartMs (modo livre), mas
// pra tentativa do desafio diário — só sobe se bater a melhor pontuação do
// dia (ver dailyGameOver mais abaixo). mouse/startMs exportadas como binding
// ao vivo pelo mesmo motivo de dailyPlaying acima.
let dailyReplayRounds = [];
export let dailyReplayMouse = [];
export let dailyReplayStartMs = 0;
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

// Passe Semanal ativo dá +1 tentativa (ver dailyMaxAttempts em
// startDailyAttempt, functions/index.js — o servidor é quem garante isso de
// verdade, aqui é só pra exibição/checagem de UI baterem com o que o server
// vai aceitar). isWeeklyPassActive vem de js/levels.js (mesmo helper usado
// pelo nick amarelo), reexportada aqui porque js/daily-ranking.js também
// precisa do mesmo cálculo (ver lá) e importar de volta daily-challenge.js
// criaria um import circular (este arquivo já importa de daily-ranking.js).
export function dailyMaxAttempts() {
  return DAILY_MAX_ATTEMPTS + (isWeeklyPassActive(state.myData) ? 1 : 0);
}

// modo sorteado do desafio diário — determinístico por dia (mesmo modo pra
// TODO MUNDO, e igual nas 3 tentativas), sorteado entre os modos de
// DAILY_ROTATION_MODES, SEM olhar nível desbloqueado: o desafio diário
// sempre foi acessível a qualquer um independente do modo normal estar
// bloqueado ou não pro nível da pessoa.
// DAILY_MODE_OVERRIDE: força um dia específico pra um modo em particular,
// sem mexer no sorteio de verdade dos outros dias (fica igual pra quem olhar
// de fora — "🎲 modo sorteado de hoje" continua fazendo sentido). 02/08/2026
// foi Formas, com o pool de naipes de baralho; 03/08/2026 foi Formas Reverso,
// com um pool próprio de 9 formas (6 padrão + coração/trapézio/pentágono);
// 07/08/2026 é Formas de novo, agora com 8 formas (6 padrão + trapézio/
// pentágono, sem o coração dessa vez — ver DAILY_SHAPES_OVERRIDE em
// constants.js) — sem esse override, o sorteio normal (DAILY_ROTATION_MODES)
// teria caído em Reverso.
const DAILY_MODE_OVERRIDE = { '2026-07-28': 'reverse', '2026-07-29': 'classic', '2026-07-30': 'classic', '2026-07-31': 'reverse', '2026-08-01': 'classic', '2026-08-02': 'shapes', '2026-08-03': 'shapes-reverse', '2026-08-07': 'shapes' };
function dailyModeForToday(dateStr) {
  if (DAILY_MODE_OVERRIDE[dateStr]) return DAILY_MODE_OVERRIDE[dateStr];
  return seededPick(mulberry32(hashSeed(dateStr + '|daily-mode-v1')), DAILY_ROTATION_MODES);
}
// mesma regra de fuso do servidor (America/Sao_Paulo, sempre UTC-3 — sem
// horário de verão desde 2019): dia do desafio + horário em que ele fecha
function dailyLocalDateStr(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD
}
// exposta em window pra js/daily-ranking.js, js/ranking-cache.js e
// js/replay.js poderem usar sem precisar importar o módulo inteiro
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

// mesma ideia de poolFor, mas pro desafio diário: Clássico/Reverso usam a
// paleta estendida (DAILY_COLORS, ou o override do dia — ver
// DAILY_PALETTE_OVERRIDE acima); Formas/Formas Reverso usam o SHAPES normal,
// a menos que o dia tenha um override próprio (DAILY_SHAPES_OVERRIDE, ex.:
// os naipes de baralho de 02/08/2026). "dateStr" opcional (default: hoje de
// verdade) só existe pra window.previewDailyForDate poder pedir o pool de
// OUTRO dia sem mexer no relógio real — o jogo em si nunca passa esse
// argumento, sempre usa o dia de hoje.
const dailyPoolFor = (m, dateStr = dailyLocalDateStr()) => (m === 'classic' || m === 'reverse')
  ? (DAILY_PALETTE_OVERRIDE[dateStr] || DAILY_COLORS)
  : (m === 'shapes' || m === 'shapes-reverse')
    ? (DAILY_SHAPES_OVERRIDE[dateStr] || poolFor(m))
    : poolFor(m);

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
  if (state.offline || !state.currentUser || !state.myData.nick) { window.goSignup(); return; }
  if (blockIfBanned()) return; // conta suspensa não joga nenhum modo
  if (dailyAttemptsUsed >= dailyMaxAttempts()) {
    $('daily-blocked-msg').textContent = T[state.lang].daily_blocked_msg;
    $('daily-intro').style.display = 'none';
    $('daily-play').style.display = 'none';
    $('daily-result').style.display = 'none';
    $('daily-blocked').style.display = 'flex';
    show('daily-screen');
    return;
  }
  window.showDailyIntro();
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
  $('daily-intro-attempts').textContent = T[state.lang].daily_card_attempts(dailyMaxAttempts() - dailyAttemptsUsed, dailyMaxAttempts());
  $('daily-intro-best').textContent = dailyBestScore;
  renderDailyCardCountdown(); // atualiza o cronômetro na hora, sem esperar o próximo tique do segundo
  $('daily-intro-tut-btn').onclick = () => window.startTutorial(dailyMode, { fromDaily: true });
  { const introStartBtn = $('daily-intro-start-btn'); introStartBtn.onclick = () => withBtnLoading(introStartBtn, () => startDailyChallenge()); }
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
  // a renderização da caixa de entrada mudou de formato junto com o campo
  // "type" (ver renderInboxList) — quem ainda está com o JS antigo em
  // memória (aba aberta de antes de um deploy, sem ter dado refresh) não
  // sabe ler mensagens de tipos novos e mostra texto quebrado (ex.:
  // "undefinedº lugar"). Em vez de arriscar exibir isso, recarrega a página
  // na hora — não é um meio de partida pra proteger, então não precisa do
  // modal com botão (ver window.startGame), só reinicia direto.
  if (!(await window.isClientUpToDate())) { window.forceReloadNow(); return; }
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
    const box = document.createElement('div');
    box.className = 'daily-inbox-msg';
    if (msg.claimed) box.style.opacity = '0.6';

    // "admin_message": aviso avulso escrito por um admin (ex.: compensação de
    // bug corrigido), com título/corpo livres já prontos no próprio
    // documento — não segue o formato fixo de "parabéns, você ficou em Nº"
    // do prêmio do desafio diário abaixo. Mesma linha de resgate (coins/
    // botão) pras duas, só a parte de texto muda.
    if (msg.type === 'admin_message') {
      const titleLine = document.createElement('div');
      titleLine.className = 'pos-line';
      titleLine.textContent = msg.title || '';
      box.appendChild(titleLine);
      const bodyLine = document.createElement('div');
      bodyLine.className = 'muted';
      bodyLine.style.cssText = 'text-align:left; margin-top:4px; white-space:pre-line;';
      bodyLine.textContent = msg.body || '';
      box.appendChild(bodyLine);
    } else if (msg.type === 'guild_battle_prize') {
      // prêmio da Batalha de Clã (ver resolveGuildBattleEvent em
      // functions/index.js) -- Pigmentos já foram direto pro Cofre do clã
      // (não passam por aqui), essa mensagem só EXPLICA isso (pra parecer
      // que também está sendo resgatado) e credita o XP individual de
      // verdade, único valor que o botão de resgatar concede aqui
      const pos = msg.position;
      const posLabel = pos === 1 ? T[state.lang].daily_pos_1 : pos === 2 ? T[state.lang].daily_pos_2 : pos === 3 ? T[state.lang].daily_pos_3 : T[state.lang].daily_pos_n(pos);
      const titleLine = document.createElement('div');
      titleLine.className = 'pos-line';
      titleLine.textContent = T[state.lang].guild_battle_reward_title;
      box.appendChild(titleLine);
      const bodyLine = document.createElement('div');
      bodyLine.className = 'muted';
      bodyLine.style.cssText = 'text-align:left; margin-top:4px;';
      bodyLine.textContent = T[state.lang].guild_battle_inbox_body(msg.guildTag || '', posLabel, msg.guildPigmentos || 0);
      box.appendChild(bodyLine);
      // lista do que ganhou (só 1 item aqui -- o XP; o Pigmentos do clã já
      // foi mencionado acima) -- mesma setinha/estilo do popup do Passe
      // Semanal (.wp-benefit-arrow em css/style.css), reaproveitado
      const benefitLine = document.createElement('div');
      benefitLine.style.cssText = 'text-align:left; margin-top:6px; font-size:0.85rem; display:flex; align-items:center; gap:5px;';
      benefitLine.innerHTML = `<span class="wp-benefit-arrow">▸</span> ${T[state.lang].guild_battle_inbox_xp_line}: <b>+${msg.xp || 0} XP</b>`;
      box.appendChild(benefitLine);
    } else if (msg.type === 'weekly_pass_daily') {
      // bônus diário do Passe Semanal (ver grantWeeklyPass/
      // grantWeeklyPassDailyPigmentos em functions/index.js) -- título/corpo
      // fixos (i18n), igual ao prêmio do desafio diário abaixo; o resgate em
      // si (linha de coins + botão) já é genérico mais embaixo, sem precisar
      // de nada especial aqui
      const titleLine = document.createElement('div');
      titleLine.className = 'pos-line';
      titleLine.textContent = T[state.lang].weekly_pass_daily_title;
      box.appendChild(titleLine);
      const bodyLine = document.createElement('div');
      bodyLine.className = 'muted';
      bodyLine.style.cssText = 'text-align:left; margin-top:4px;';
      bodyLine.textContent = T[state.lang].weekly_pass_daily_body;
      box.appendChild(bodyLine);
    } else {
      // mesmo formato título (negrito) + corpo do admin_message acima, só que
      // com texto fixo em vez de vir do documento -- título sempre
      // "Recompensa do desafio diário", corpo com o parabéns/posição/data/
      // pontuação de sempre
      const pos = msg.position;
      const posLabel = pos === 1 ? T[state.lang].daily_pos_1 : pos === 2 ? T[state.lang].daily_pos_2 : pos === 3 ? T[state.lang].daily_pos_3 : T[state.lang].daily_pos_n(pos);
      const titleLine = document.createElement('div');
      titleLine.className = 'pos-line';
      titleLine.textContent = T[state.lang].daily_reward_title;
      box.appendChild(titleLine);
      const bodyLine = document.createElement('div');
      bodyLine.className = 'muted';
      bodyLine.style.cssText = 'text-align:left; margin-top:4px;';
      bodyLine.textContent = T[state.lang].daily_inbox_congrats(posLabel, formatDailyDateShort(msg.dateStr), msg.score);
      box.appendChild(bodyLine);
    }

    const claimRow = document.createElement('div');
    claimRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px;';
    const coinsSpan = document.createElement('span');
    coinsSpan.style.cssText = 'display:flex; align-items:center; gap:4px; font-weight:700;';
    if (msg.type === 'guild_battle_prize') {
      // resgate aqui é XP, não Pigmentos -- sem o ícone de pigmento, que
      // seria enganoso (o Pigmentos do clã já foi creditado sozinho)
      coinsSpan.textContent = `⭐ +${msg.xp || 0} XP`;
    } else {
      coinsSpan.insertAdjacentHTML('beforeend', pigmentIconSvg(16));
      const coinsNum = document.createElement('span');
      coinsNum.textContent = `+${msg.coins}`;
      coinsSpan.appendChild(coinsNum);
    }
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
      claimBtn.style.cssText = 'padding:6px 14px; font-size:0.72rem;';
      claimBtn.textContent = T[state.lang].btn_claim;
      // usa o id do documento (não msg.dateStr) — pro prêmio do desafio
      // diário os dois sempre coincidem (o doc é salvo com o dateStr como id
      // em resolveDailyChallenge), mas um admin_message pode ter um id fixo
      // que não é uma data (ex.: "admin_mosaic_bugfix"), então só o id serve
      // de referência confiável pro resgate
      claimBtn.onclick = () => withBtnLoading(claimBtn, () => claimOneDailyReward(msg.id));
      claimRow.appendChild(claimBtn);
    }

    box.appendChild(claimRow);
    list.appendChild(box);
  });
}
// bolinha de notificação no ícone 📬 do menu — mesma ideia da de pedido de
// amizade pendente (menu-quick-friends-badge); conta quantas mensagens ainda
// não foram resgatadas
export async function refreshInboxBadge() {
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

// mesmo problema/solução da bolinha de pedido de amizade (ver
// ensureFriendRequestsListener em js/friends.js): refreshInboxBadge acima só
// roda quando algo específico chama (showMenu, resgatar prêmio, terminar uma
// partida...), então um prêmio novo caindo na caixa por conta do cron
// noturno (resolveDailyChallenge, ver functions/index.js) só aparecia depois
// de sair/voltar do menu ou dar refresh na página. Este listener ouve a
// query em tempo real e atualiza a bolinha assim que o documento aparece.
let inboxBadgeUnsub = null;
export function ensureInboxBadgeListener() {
  if (inboxBadgeUnsub || state.offline || !state.currentUser) return;
  const myUid = state.currentUser.uid;
  const q = query(collection(db, 'dailyInbox', myUid, 'messages'), where('claimed', '==', false));
  inboxBadgeUnsub = onSnapshot(q, snap => {
    const btn = $('inbox-btn');
    if (!btn) return;
    btn.style.display = (!state.offline && state.currentUser && state.myData.nick) ? '' : 'none';
    const badge = $('inbox-badge');
    badge.textContent = snap.size;
    badge.style.display = snap.size > 0 ? '' : 'none';
  }, () => {});
}
window.ensureInboxBadgeListener = ensureInboxBadgeListener;

window.stopInboxBadgeListener = () => {
  if (inboxBadgeUnsub) { inboxBadgeUnsub(); inboxBadgeUnsub = null; }
};

window.claimOneDailyReward = async (dateStr) => {
  try {
    const res = await callClaimDailyReward({ dateStr });
    const coins = (res.data && res.data.coins) || 0;
    if (coins > 0) state.myData.pigmentos = (state.myData.pigmentos || 0) + coins;
    // prêmio de XP da Batalha de Clã (ver type:'guild_battle_prize') -- só
    // essa function credita algo diferente de Pigmentos, daí o campo extra.
    // Atualiza a barra do menu na hora (renderMenuXpBar, ver js/levels.js) e
    // dispara o mesmo banner de "subiu de nível" de uma partida normal
    // (window.showLevelUp, exposto por js/game-core.js) se o nível mudou.
    const xp = (res.data && res.data.xp) || 0;
    if (xp > 0) {
      const beforeXp = state.myData.xp || 0;
      const afterXp = beforeXp + xp;
      state.myData.xp = afterXp;
      renderMenuXpBar();
      if (levelFromXp(beforeXp) !== levelFromXp(afterXp)) window.showLevelUp(levelFromXp(afterXp));
    }
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
    const xp = (res.data && res.data.xp) || 0;
    if (xp > 0) {
      const beforeXp = state.myData.xp || 0;
      const afterXp = beforeXp + xp;
      state.myData.xp = afterXp;
      renderMenuXpBar();
      if (levelFromXp(beforeXp) !== levelFromXp(afterXp)) window.showLevelUp(levelFromXp(afterXp));
    }
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
export async function updateDailyMenuCard() {
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
  // Xº do lado do 📊 (mesmo emoji dos cards de modo) — mesma posição
  // mostrada no ranking "Hoje" do desafio diário (ver computeMyDailyTodayRank)
  const myDailyRank = await computeMyDailyTodayRank();
  $('daily-card-best').innerHTML = `${myDailyRank ? myDailyRank + 'º ' : ''}📊 ${T[state.lang].daily_card_best(dailyBestScore)}`;
  $('daily-card-attempts').textContent = (dailyAttemptsUsed >= dailyMaxAttempts())
    ? T[state.lang].daily_card_already_played
    : T[state.lang].daily_card_attempts(dailyMaxAttempts() - dailyAttemptsUsed, dailyMaxAttempts());
}

/* -------- jogo do desafio (mesmo modo Clássico, RNG determinística) -------- */
window.startDailyChallenge = async () => {
  if (state.offline || !state.currentUser || !state.myData.nick) { window.goSignup(); return; }
  if (!(await window.isClientUpToDate())) {
    $('daily-blocked-msg').textContent = T[state.lang].daily_update_required;
    $('daily-intro').style.display = 'none';
    $('daily-play').style.display = 'none';
    $('daily-result').style.display = 'none';
    $('daily-blocked').style.display = 'flex';
    show('daily-screen');
    return;
  }
  // versão do APP NATIVO desatualizada (não do JS do site, checagem acima) —
  // ver isNativeVersionUpToDate em js/bootstrap.js
  if (!(await window.isNativeVersionUpToDate())) {
    $('daily-blocked-msg').textContent = T[state.lang].daily_native_update_required;
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
      state.sawTouchThisMatch = false; // ver comentário no campo, em state.js (listener de touchstart fica em game-core.js, cobre os 2 modos)
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
      if (lastNum !== 'go') { lastNum = 'go'; window.sfx.countdown(true); }
      dailyCountdownTimerId = setTimeout(() => {
        $('daily-countdown').style.display = 'none';
        dailyCountdownTimerId = null;
        onDone();
      }, 400);
      return;
    }
    const num = Math.max(1, Math.ceil(remaining / 1000));
    $('daily-countdown-num').textContent = String(num);
    if (lastNum !== num) { lastNum = num; window.sfx.countdown(false); }
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
      // shapeSide.glyph: formas com override que usam glyph Unicode em vez
      // de clip-path (ver DAILY_SHAPES_OVERRIDE em constants.js e
      // .shape-fill.shape-glyph no CSS) -- curvas complexas demais (naipes de
      // baralho) pra aproximar bem com polygon() como as 6 formas normais.
      const fillHtml = shapeSide.glyph
        ? `<span class="shape-fill shape-glyph">${shapeSide.glyph}</span>`
        : `<span class="shape-fill ${shapeSide.shapeClass}"></span>`;
      el.innerHTML = `${fillHtml}<span class="word">${cName(wordSide)}</span>`;
    } else {
      const bg   = (dailyMode === 'classic') ? item : paired;
      const word = (dailyMode === 'classic') ? paired : item;
      const bgHex = jitterHex(bg.hex);
      el.style.background = bg.pattern || bgHex; // "zebra" (só no desafio diário) usa listras em vez de hex sólido
      el.style.boxShadow = `0 0 18px ${bgHex}99, 0 0 40px ${bgHex}55, inset 0 0 20px rgba(255,255,255,0.12)`;
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
    if (left <= 0) { window.sfx.timeout(); return dailyGameOver(T[state.lang].reason_timeout); }
    if (left < 0.35 && now - lastTick > 250) { lastTick = now; window.sfx.tick(); }
    dailyRafId = requestAnimationFrame(tick);
  };
  dailyRafId = requestAnimationFrame(tick);
}

function dailyHandleClick(item, e) {
  if (!dailyPlaying) return;
  if (item === dailyTarget) {
    dailyScore++;
    if (dailySessionId) dailyPendingRoundSync.push(callSyncProgress({ sessionId: dailySessionId, trusted: !e || e.isTrusted }).catch(() => {}));
    window.sfx.correct(dailyScore);
    $('daily-score').textContent = dailyScore;
    dailyTarget = dailyNextTarget;
    dailyDuration *= 0.95;
    dailyNewRound(false);
  } else {
    window.sfx.wrong();
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
      if (levelFromXp(myXp()) > lvBefore) window.sfx.levelUp();
    }
  } catch (e) {
    // não foi possível confirmar com o servidor — o placar oficial (ranking)
    // só considera o que o servidor validou; a tela ainda mostra o resultado local
  }
  if (dailyScore >= bestScore && dailyScore > 0 && dailyScore > dailyBestScore) {
    window.sfx.record(); spawnConfetti();
    // mesma ideia do modo livre (ver persistGameResult) — só sobe o "filme"
    // da tentativa quando ela vira a melhor pontuação do dia, em segundo
    // plano, sem atrasar a tela de resultado
    if (dailySessionId) saveMatchReplayWithRetry({ sessionId: dailySessionId, mode: dailyMode, kind: 'daily', rounds: dailyReplayRounds, mouseTrail: dailyReplayMouse, inputTouch: state.sawTouchThisMatch }).catch(() => {}); // já logou dentro; aqui só evita unhandled rejection
  }
  dailyBestScore = bestScore;
  $('daily-result-best').textContent = dailyBestScore;

  const left = Math.max(0, dailyMaxAttempts() - dailyAttemptsUsed);
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
  window.showMenu();
};

// pré-visualização VISUAL de um dia específico do desafio diário, sem
// esperar a data chegar de verdade -- útil pra conferir modo/paleta/pool
// forçados (DAILY_MODE_OVERRIDE/DAILY_PALETTE_OVERRIDE/DAILY_SHAPES_OVERRIDE
// acima) antes de publicar. Fora do fluxo real de partida de propósito: SEM
// sessão do servidor (callStartDailyAttempt), SEM RNG/timer/pontuação, SEM
// cliques funcionais -- só monta um grid de exemplo pra olhar visualmente.
// Não mexe em dailyMode/dailyRng/dailySessionId (estado da partida real),
// então não atrapalha nem se rodado no meio de uma tentativa de verdade
// (embora não faça sentido usar assim). Uso, no console do navegador:
//   window.previewDailyForDate('2026-08-02')
window.previewDailyForDate = (dateStr) => {
  const mode = dailyModeForToday(dateStr);
  const pool = dailyPoolFor(mode, dateStr);
  console.log(`[preview] ${dateStr} → modo sorteado: ${mode}`, pool.map(p => p.name.pt));
  const grid = $('daily-grid');
  grid.innerHTML = '';
  pool.slice(0, SQUARES).forEach((item, i) => {
    const paired = pool[(i + 1) % pool.length];
    const el = document.createElement('div');
    el.className = 'square';
    if (mode === 'shapes' || mode === 'shapes-reverse') {
      el.classList.add('shape-square', item.shapeClass);
      const fillHtml = item.glyph
        ? `<span class="shape-fill shape-glyph">${item.glyph}</span>`
        : `<span class="shape-fill ${item.shapeClass}"></span>`;
      el.innerHTML = `${fillHtml}<span class="word">${cName(paired)}</span>`;
    } else {
      el.style.background = item.pattern || item.hex;
      el.style.boxShadow = `0 0 18px ${item.hex}99, 0 0 40px ${item.hex}55, inset 0 0 20px rgba(255,255,255,0.12)`;
      el.innerHTML = `<span class="word">${cName(paired)}</span>`;
    }
    grid.appendChild(el);
  });
  $('daily-countdown').style.display = 'none';
  $('daily-intro').style.display = 'none';
  $('daily-result').style.display = 'none';
  $('daily-blocked').style.display = 'none';
  $('daily-play').style.display = 'flex';
  show('daily-screen');
};
