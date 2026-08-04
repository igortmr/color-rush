import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';

/* ================== evento semanal "Batalha de Clãs" ==================
   Sexta 18h (Brasília) até domingo 23h59m59s (Brasília), toda semana. Este
   módulo só cuida do card do MENU (título + cronômetro contando pro próximo
   início, ou pro fim se já estiver rolando — mesmo estilo do card do
   desafio diário, ver renderDailyCardCountdown em js/daily-challenge.js). O
   card é clicável (onclick="showGuildHome('battle')" em index.html/
   teste.html) e leva pra aba "Batalha" de verdade dentro do clã — essa aba
   (rankings, pontuação, premiação futura) vive em js/guilds.js, não aqui.
*/

// meia-noite de Brasília = 03h UTC (sem horário de verão desde 2019 — mesma
// regra de dailyLocalDateStr em js/daily-challenge.js, repetida aqui pra
// este módulo não precisar depender do domínio do desafio diário)
function guildBattleLocalDateStr(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

// início/fim (em ms UTC) da janela do evento na semana de "now" — a
// sexta 18h já passada (ou de hoje, se hoje for sexta) até domingo
// 23h59m59s, ambos de Brasília. Serve tanto pra saber se está rolando
// agora quanto, se ainda não chegou, pra onde o cronômetro deve contar.
function guildBattleWeekWindow(now = new Date()) {
  const [y, m, d] = guildBattleLocalDateStr(now).split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay(); // 0=dom...5=sex...6=sáb — só do calendário, não depende de fuso
  const daysSinceFriday = (weekday - 5 + 7) % 7; // quantos dias já se passaram desde a sexta mais recente (0 se hoje for sexta)
  const friday = new Date(y, m - 1, d - daysSinceFriday);
  const startMs = Date.UTC(friday.getFullYear(), friday.getMonth(), friday.getDate(), 21, 0, 0, 0); // sexta 18h Brasília = 21h UTC
  const sunday = new Date(friday.getFullYear(), friday.getMonth(), friday.getDate() + 2);
  const endMs = Date.UTC(sunday.getFullYear(), sunday.getMonth(), sunday.getDate(), 26, 59, 59, 0); // domingo 23h59m59s Brasília = 02h59m59s UTC de 2ª (Date.UTC rola o dia sozinho com hora=26)
  return { startMs, endMs };
}
function guildBattleIsLive(now = new Date()) {
  const { startMs, endMs } = guildBattleWeekWindow(now);
  const t = now.getTime();
  return t >= startMs && t <= endMs;
}
// próximo marco relevante do cronômetro: se ainda não começou, conta pro
// início desta semana; se está rolando agora, conta pro fim; se a janela
// desta semana já fechou, pula pra sexta que vem (+7 dias corridos — sem
// horário de verão no Brasil, dá pra somar em ms puro sem errar 1h)
function guildBattleCountdownTargetMs(now = new Date()) {
  const { startMs, endMs } = guildBattleWeekWindow(now);
  const t = now.getTime();
  if (t <= endMs) return guildBattleIsLive(now) ? endMs : startMs;
  return startMs + 7 * 24 * 60 * 60 * 1000;
}

// "3d 20:15:42" quando falta mais de 1 dia, ou só "20:15:42" quando falta
// menos de 24h — mesmo formato HH:MM:SS do desafio diário, com o prefixo de
// dias na frente quando faz sentido
function formatGuildBattleCountdown(msLeft) {
  if (msLeft < 0) msLeft = 0;
  const totalSeconds = Math.floor(msLeft / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const hms = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return days > 0 ? `${days}d ${hms}` : hms;
}

// cronômetro roda pra sempre em segundo plano (mesmo padrão de
// startDailyCardTicker em js/daily-challenge.js) — só atualiza texto,
// não pesa nada ficar rodando mesmo fora do menu ou deslogado (o próprio
// updateGuildBattleCard esconde o card quando não deve aparecer)
let guildBattleTicker = null;
function renderGuildBattleCountdown() {
  const card = $('card-guild-battle');
  if (!card) return;
  const live = guildBattleIsLive();
  const msLeft = guildBattleCountdownTargetMs() - Date.now();
  const labelEl = $('guild-battle-countdown-label');
  const timeEl = card.querySelector('.daily-badge-time');
  if (labelEl) labelEl.textContent = live ? T[state.lang].daily_ends_in : T[state.lang].daily_starts_in;
  if (timeEl) timeEl.textContent = formatGuildBattleCountdown(msLeft);
  // só é clicável enquanto a batalha está rolando de verdade — antes disso
  // (contando pro início) ou depois (contando pra próxima sexta) o card
  // volta a ser só informativo, mesmo tratamento "coming-soon" do card do
  // desafio diário (ver .mode-card.daily-card.coming-soon em css/style.css)
  card.classList.toggle('coming-soon', !live);
}
function startGuildBattleTicker() {
  if (guildBattleTicker) return;
  renderGuildBattleCountdown();
  guildBattleTicker = setInterval(renderGuildBattleCountdown, 1000);
}
startGuildBattleTicker();

// mostra/esconde o card e atualiza o cronômetro na hora — chamado pelo
// showMenu() (mesmo padrão de updateDailyMenuCard em js/daily-challenge.js).
// Precisa de conta (igual o desafio diário), mas SEM trava de nível: o
// objetivo aqui é incentivar todo mundo, até quem está começando agora, a
// já ir formando clã antes do evento valer de verdade.
export function updateGuildBattleCard() {
  const card = $('card-guild-battle');
  if (!card) return;
  if (state.offline || !state.currentUser || !state.myData.nick) { card.style.display = 'none'; return; }
  card.style.display = '';
  renderGuildBattleCountdown();
}

// onclick do card (ver index.html/teste.html) — só navega enquanto a
// batalha está rolando (guildBattleIsLive), senão não faz nada; o toggle de
// .coming-soon acima já tira o cursor de "clicável" nesse caso, então o
// clique nem deveria chegar aqui fora da janela, mas confere de novo por
// segurança (ex.: clique disparado bem no instante em que a janela fecha)
window.guildBattleCardClick = () => {
  if (!guildBattleIsLive()) return;
  window.showGuildHome('battle');
};
