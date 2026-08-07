import {
  doc, getDoc, getDocs, collection, query, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { pushScreenAndShow } from './nav.js';
import { modeLabel, MODE_ICON, MODE_UNLOCK, modeUnlocked, pigmentIconSvg } from './levels.js';
import { fetchAllScores, rowData, buildLevelNickBlock } from './ranking-cache.js';

/* ================== evento semanal "Batalha de Clãs" ==================
   Sexta 18h (Brasília) até domingo 23h59m59s (Brasília), toda semana. Este
   módulo concentra TUDO da feature do lado do cliente — card do menu
   (cronômetro), a tela cheia (#guild-battle-screen: os 2 modos sorteados
   com botão de jogar + ranking geral entre clãs) e a popup de detalhe de um
   clã (top-5 dos 2 modos, com replay pra provar a pontuação). De propósito
   NADA disso mora dentro da tela do clã (js/guilds.js) — é uma feature à
   parte, só acessada pelo card do menu.
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
  // desafio diário (ver .mode-card.daily-card.coming-soon em css/style.css).
  // Em teste.html (window.IS_TESTE) essa trava de calendário é ignorada —
  // guildBattleIsLive só sabe calcular a janela REAL (sexta 18h-domingo),
  // sem olhar o Firestore, então travaria o teste em qualquer outro dia da
  // semana mesmo com um evento de teste já criado via adminForceStartGuildBattle
  card.classList.toggle('coming-soon', !window.IS_TESTE && !live);
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

// onclick do card (ver index.html/teste.html) — só faz algo enquanto a
// batalha está rolando (guildBattleIsLive); o toggle de .coming-soon acima
// já tira o cursor de "clicável" fora da janela, mas confere de novo por
// segurança (ex.: clique disparado bem no instante em que a janela fecha).
// Mesma exceção de teste.html do toggle acima — window.IS_TESTE ignora a
// trava de calendário, senão não dava pra testar em nenhum dia que não
// fosse sexta/fim de semana de verdade.
// Sem clã → popup avisando que precisa entrar num primeiro; com clã → tela
// cheia da Batalha.
window.guildBattleCardClick = () => {
  if (!window.IS_TESTE && !guildBattleIsLive()) return;
  if (!state.myData.guildId) {
    $('guild-battle-no-guild-modal').style.display = 'flex';
    return;
  }
  pushScreenAndShow('guild-battle-screen', 'menu-screen');
  renderGuildBattleScreen();
};

window.closeGuildBattleNoGuildModal = () => {
  $('guild-battle-no-guild-modal').style.display = 'none';
};
// botão único da popup "sem clã" — fecha a popup e manda pra listagem de
// clãs, pra pessoa já poder criar/entrar em um (ver showGuildList em
// js/guilds.js)
window.guildBattleGoToGuilds = () => {
  window.closeGuildBattleNoGuildModal();
  window.showGuildList();
};

// legenda de premiação dentro da popup de regras -- uma linha por posição,
// com o ícone SVG colorido de verdade dos Pigmentos (mesmo padrão de
// renderDailyPrizesLegend em js/levels.js) em vez do emoji 💧 estático
function renderGuildBattlePrizesLegend() {
  const el = $('guild-battle-prizes-legend');
  if (!el) return;
  const cfg = T[state.lang].guild_battle_prizes_legend;
  const rows = cfg.rows.map(r => `
    <div style="display:flex; justify-content:space-between; align-items:center; max-width:260px; margin:2px auto;">
      <span>${r.label}</span>
      <span style="display:inline-flex; align-items:center; gap:3px; font-weight:700;">${r.amount} ${pigmentIconSvg(14)}</span>
    </div>`).join('');
  el.innerHTML = `<div style="margin-bottom:4px; text-align:center;">${cfg.title}</div>${rows}`;
}

// popup do "?" ao lado do título da tela cheia, explicando em detalhe as
// regras de pontuação/desempate (ver #guild-battle-rules-modal em
// index.html/teste.html) — texto 100% estático via data-i18n-html, só a
// legenda de premiação é montada em JS (ver renderGuildBattlePrizesLegend
// acima), não precisa de nenhum dado do evento pra ser exibida
window.openGuildBattleRulesModal = () => {
  renderGuildBattlePrizesLegend();
  $('guild-battle-rules-modal').style.display = 'flex';
};
window.closeGuildBattleRulesModal = () => {
  $('guild-battle-rules-modal').style.display = 'none';
};

// único ponto de entrada é o card do menu, então "voltar" sempre é pro
// menu mesmo (mesmo padrão simples do botão VOLTAR de #shop-screen, sem
// pilha de navegação — ver pushScreenAndShow/popScreenBack em js/nav.js)
window.guildBattleBack = () => { stopBattleScreenTicker(); window.showMenu(); };

/* ================== tela cheia (#guild-battle-screen) ================== */
// token evita que um fetch antigo (ex.: a pessoa saiu e voltou rápido pra
// tela) pinte por cima do estado mais novo — mesmo padrão de
// guildRenderToken em js/guilds.js
let battleScreenToken = 0;
// evento já buscado, cacheado só pra popup de detalhe não precisar buscar
// de novo (tag/nome/nota de cada clã já vêm nele, ver guildScores)
let currentBattleEvent = null;

async function renderGuildBattleScreen() {
  stopBattleScreenTicker();
  const myToken = ++battleScreenToken;
  const body = $('guild-battle-body');
  const statusEl = $('guild-battle-status');
  body.innerHTML = `<div class="muted" style="text-align:center;">${T[state.lang].loading_text}</div>`;
  if (statusEl) statusEl.innerHTML = '';
  currentBattleEvent = null;

  // window.IS_TESTE (só true em teste.html) escolhe a coleção de teste —
  // mesmo flag já usado em outros módulos (ver js/ranking-cache.js) pra
  // isolar completamente dado de teste do dado real
  const eventsCollection = window.IS_TESTE ? 'guildBattleEventsTest' : 'guildBattleEvents';
  try {
    const snap = await getDocs(query(collection(db, eventsCollection), orderBy('startsAt', 'desc'), limit(1)));
    if (myToken !== battleScreenToken) return;
    if (snap.empty) {
      // o card só deixa entrar aqui quando o cronômetro (calculado no
      // cliente) diz que já devia estar rolando — mas a função agendada que
      // cria o documento pode não ter disparado ainda (raríssimo, alguns
      // segundos de folga); mesma mensagem de "nenhum evento" serve
      body.innerHTML = `<div class="card muted" style="text-align:center;">${T[state.lang].guild_battle_no_event}</div>`;
      return;
    }
    const eventDoc = snap.docs[0];
    currentBattleEvent = { id: eventDoc.id, ...eventDoc.data() };
    renderBattleStatus();
    renderGuildBattleBody(body);
  } catch (e) {
    if (myToken !== battleScreenToken) return;
    body.innerHTML = `<div class="muted" style="text-align:center; font-size:0.8rem;">${T[state.lang].ranking_error}</div>`;
  }
}

// cronômetro da tela cheia (diferente do guildBattleTicker do card do menu,
// que só sabe contar pro início/fim REAL de calendário) — conta direto pro
// endsAt do evento já buscado do Firestore, então funciona igual em
// teste.html com um evento de teste criado fora da janela real. Só roda
// enquanto #guild-battle-screen está aberta (ver start/stop abaixo).
let battleScreenTicker = null;
function stopBattleScreenTicker() {
  if (battleScreenTicker) { clearInterval(battleScreenTicker); battleScreenTicker = null; }
}
function renderBattleScreenCountdown() {
  const el = $('guild-battle-screen-countdown');
  const event = currentBattleEvent;
  if (!el || !event) { stopBattleScreenTicker(); return; }
  const endsAtMs = event.endsAt && event.endsAt.toMillis ? event.endsAt.toMillis() : 0;
  const msLeft = endsAtMs - Date.now();
  if (msLeft <= 0) {
    // a pessoa ficou olhando a tela até a batalha acabar de verdade —
    // re-renderiza o status (pro balão sumir) e o corpo (pra esconder os
    // cards de "jogar") pro estado "encerrada", sem re-buscar do Firestore
    // (o doc do evento em si não muda só por isso)
    stopBattleScreenTicker();
    renderBattleStatus();
    const body = $('guild-battle-body');
    if (body) renderGuildBattleBody(body);
    return;
  }
  el.textContent = formatGuildBattleCountdown(msLeft);
}
function startBattleScreenTicker() {
  stopBattleScreenTicker();
  renderBattleScreenCountdown();
  battleScreenTicker = setInterval(renderBattleScreenCountdown, 1000);
}

// status/cronômetro mora num elemento estático próprio (#guild-battle-status,
// ver index.html/teste.html), ACIMA do botão "❓ Como funciona" — separado
// de #guild-battle-body (que só tem os cards de modo + a classificação) pra
// dar pra reordenar os dois na tela sem depender de where cada bloco nasce
// no innerHTML gerado dinamicamente
function renderBattleStatus() {
  const statusEl = $('guild-battle-status');
  const event = currentBattleEvent;
  if (!statusEl || !event) return;
  const endsAtMs = event.endsAt && event.endsAt.toMillis ? event.endsAt.toMillis() : 0;
  const isActive = event.status === 'active' && Date.now() <= endsAtMs;
  if (isActive) {
    // mesmo "balão" do cronômetro do desafio diário (.daily-badge-today/
    // .daily-badge-time em css/style.css) — lá ele fica position:absolute
    // flutuando por cima da borda de um .mode-card; aqui não tem nenhum card
    // por baixo pra flutuar sobre, então troca pra position:static (o resto
    // do visual é reaproveitado). .guild-battle-badge (verde) por cima do
    // amarelo padrão, mesma cor do cronômetro do card na tela principal.
    statusEl.innerHTML = `<span class="daily-badge-today guild-battle-badge" style="position:static; display:inline-block;">${T[state.lang].guild_battle_ends_in_label}<span class="daily-badge-time" id="guild-battle-screen-countdown"></span></span>`;
    startBattleScreenTicker();
  } else {
    statusEl.innerHTML = `<div class="muted" style="font-size:0.85rem;">${T[state.lang].guild_battle_ended}</div>`;
    stopBattleScreenTicker();
  }
}

function renderGuildBattleBody(body) {
  const event = currentBattleEvent;
  body.innerHTML = '';

  const endsAtMs = event.endsAt && event.endsAt.toMillis ? event.endsAt.toMillis() : 0;
  const isActive = event.status === 'active' && Date.now() <= endsAtMs;

  // botão de jogar só faz sentido enquanto ainda dá tempo de pontuar — os
  // 2 modos sorteados lado a lado (flex-wrap pra empilhar se a tela for
  // estreita demais pros 2 caberem), cada um com seu próprio card/botão
  if (isActive) {
    const modesTitle = document.createElement('div');
    modesTitle.innerHTML = `<b>${T[state.lang].guild_battle_modes_title}</b>`;
    body.appendChild(modesTitle);
    const modesRow = document.createElement('div');
    modesRow.style.cssText = 'display:flex; gap:10px; flex-wrap:wrap;';
    (event.modes || []).forEach(mode => {
      const card = battlePlayCard(mode);
      card.style.flex = '1 1 140px';
      modesRow.appendChild(card);
    });
    body.appendChild(modesRow);
  }

  // ranking geral entre TODOS os clãs — vem denormalizado no próprio doc do
  // evento (guildScores), atualizado a cada pontuação válida (ver
  // creditGuildBattleScore em functions/index.js); mapa pequeno, ordena/
  // renderiza direto no cliente
  const guildScores = event.guildScores || {};
  // empate de nota final → menor soma de tempo dos dois top-5 vence (mesmo
  // critério calculado no servidor, ver compareBattleEntries em functions/index.js)
  const ranked = Object.entries(guildScores).sort((a, b) =>
    (b[1].score || 0) - (a[1].score || 0) || (a[1].totalDurationMs || 0) - (b[1].totalDurationMs || 0));
  const rankTitle = document.createElement('div');
  rankTitle.innerHTML = `<b>${T[state.lang].guild_battle_overall_ranking}</b>`;
  body.appendChild(rankTitle);
  if (!ranked.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.cssText = 'text-align:center; font-size:0.8rem;';
    empty.textContent = T[state.lang].guild_battle_no_scores_yet;
    body.appendChild(empty);
    return;
  }
  // cabeçalho "tabela" (Clã / Média Final) alinhado com as mesmas duas
  // pontas de cada linha abaixo (nome à esquerda, nota à direita) — a lista
  // em si continua sendo cards, não um <table> de verdade, então isso é só
  // um rótulo visual por cima, não precisa bater pixel a pixel com a coluna
  const header = document.createElement('div');
  header.className = 'muted';
  header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:0 14px; font-size:0.75rem; font-weight:700; letter-spacing:0.3px;';
  header.innerHTML = `<span>${T[state.lang].guild_battle_col_guild}</span><span>${T[state.lang].guild_battle_col_final_score}</span>`;
  body.appendChild(header);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
  ranked.forEach(([guildId, gs], i) => {
    const pos = i + 1;
    const medal = pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : pos;
    const row = document.createElement('div');
    row.className = 'card';
    row.style.cssText = 'padding:8px 14px; gap:2px; cursor:pointer;'
      + (guildId === state.myData.guildId ? ' border-color:var(--neon-purple);' : '');
    // qualquer clã da lista é clicável, não só o próprio — pedido explícito:
    // dá pra conferir a pontuação/quem jogou de qualquer um
    row.onclick = () => openGuildBattleDetail(guildId);
    const topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px;';
    const left = document.createElement('span');
    left.style.cssText = 'display:flex; align-items:center; gap:8px; min-width:0;';
    const posSpan = document.createElement('span');
    posSpan.style.cssText = 'font-weight:800; min-width:1.4em; text-align:center; flex-shrink:0;';
    posSpan.textContent = medal;
    left.appendChild(posSpan);
    const tagSpan = document.createElement('span');
    tagSpan.style.cssText = 'font-weight:700; flex-shrink:0;';
    tagSpan.textContent = `[${gs.tag || '?'}]`;
    left.appendChild(tagSpan);
    const nameSpan = document.createElement('span');
    nameSpan.textContent = gs.name || '';
    nameSpan.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    left.appendChild(nameSpan);
    topRow.appendChild(left);
    const scoreSpan = document.createElement('span');
    scoreSpan.style.cssText = 'font-weight:700; flex-shrink:0;';
    scoreSpan.textContent = (gs.score || 0).toFixed(1);
    topRow.appendChild(scoreSpan);
    row.appendChild(topRow);
    // dica visual de que a linha inteira é clicável (o clique já funciona
    // na linha toda, isso aqui só deixa explícito o que vai acontecer)
    const viewHint = document.createElement('div');
    viewHint.style.cssText = 'font-size:0.72rem; text-align:right; color:var(--neon-blue);';
    viewHint.textContent = T[state.lang].guild_battle_view_scores_btn;
    row.appendChild(viewHint);
    list.appendChild(row);
  });
  body.appendChild(list);
}

function battlePlayCard(mode) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.textAlign = 'center';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:800; font-size:1.1rem; margin-bottom:6px;';
  title.textContent = `${MODE_ICON[mode] || ''} ${modeLabel(mode)}`;
  card.appendChild(title);
  if (!modeUnlocked(mode)) {
    // mesmo aviso "desbloqueia no nível X" dos cards do menu (ver menu.js) —
    // startGame(mode) já se recusa a começar um modo bloqueado sozinho, mas
    // sem essa mensagem o clique pareceria simplesmente não fazer nada
    const lockMsg = document.createElement('div');
    lockMsg.className = 'muted';
    lockMsg.style.fontSize = '0.8rem';
    lockMsg.textContent = T[state.lang].unlock_at(MODE_UNLOCK[mode]);
    card.appendChild(lockMsg);
  } else {
    const btn = document.createElement('button');
    // botão pequeno/centralizado — não o CTA grande padrão, reservado pra
    // ações primárias reais (ver preferência já registrada no projeto).
    // align-self:center anula o align-items:stretch de .card (flex-direction
    // column, cross-axis = largura), que senão esticaria o botão pra ocupar
    // a largura toda do card — sem isso "pequeno" no cssText não bastava.
    btn.style.cssText = 'padding:6px 14px; font-size:0.72rem; margin-top:4px; align-self:center;';
    btn.textContent = T[state.lang].guild_battle_play_btn;
    btn.onclick = () => {
      // avisa a tela de fim de partida (ver gameOver em js/game-core.js) pra
      // mostrar o aviso da Batalha em vez do mini-ranking normal do modo
      state.playingForGuildBattle = true;
      window.startGame(mode); // mesmo fluxo de sempre — a pontuação credita sozinha em submitGameResult
    };
    card.appendChild(btn);
  }
  return card;
}

/* ================== popup de detalhe de um clã ================== */
async function fetchXpByUid() {
  const xpByUid = {};
  try {
    const all = await fetchAllScores();
    all.forEach(r => { xpByUid[r.uid] = rowData(r).xp || 0; });
  } catch { /* sem nível não quebra a lista, só mostra sem o chip */ }
  return xpByUid;
}

async function openGuildBattleDetail(guildId) {
  const event = currentBattleEvent;
  if (!event) return;
  const battleSubcollection = window.IS_TESTE ? 'battleScoresTest' : 'battleScores';
  const gs = (event.guildScores && event.guildScores[guildId]) || {};
  $('guild-battle-detail-title').textContent = `[${gs.tag || '?'}] ${gs.name || ''}`;
  const modalBody = $('guild-battle-detail-body');
  modalBody.innerHTML = `<div class="muted" style="text-align:center;">${T[state.lang].loading_text}</div>`;
  $('guild-battle-detail-modal').style.display = 'flex';

  try {
    const [battleSnap, xpByUid] = await Promise.all([
      getDoc(doc(db, 'guilds', guildId, battleSubcollection, event.id)),
      fetchXpByUid(),
    ]);
    modalBody.innerHTML = '';
    const finalScoreLine = document.createElement('div');
    finalScoreLine.className = 'muted';
    finalScoreLine.style.cssText = 'text-align:center; font-size:0.85rem; margin-bottom:4px;';
    finalScoreLine.textContent = `${T[state.lang].guild_battle_final_score}: ${(gs.score || 0).toFixed(1)}`;
    modalBody.appendChild(finalScoreLine);

    const battleData = battleSnap.exists() ? battleSnap.data() : {};
    const perUser = battleData.perUser || {};
    const modeAverages = battleData.modeAverages || {};
    (event.modes || []).forEach(mode => {
      modalBody.appendChild(battleDetailModeTable(mode, perUser, modeAverages[mode] || 0, xpByUid));
    });
  } catch (e) {
    modalBody.innerHTML = `<div class="muted" style="text-align:center; font-size:0.8rem;">${T[state.lang].ranking_error}</div>`;
  }
}

window.closeGuildBattleDetailModal = () => {
  $('guild-battle-detail-modal').style.display = 'none';
};

// top-5 (no máx. 2 por pessoa, sai de graça — mesmo raciocínio do servidor
// em creditGuildBattleScore) de um dos 2 modos do clã clicado, com nick,
// nível e um botão de replay pra provar a pontuação (só aparece quando
// sessionId existe — ver descoberta no plano sobre replay não existir pra
// toda pontuação, só recorde pessoal ou pontuação aceita na Batalha)
function battleDetailModeTable(mode, perUser, modeAvg, xpByUid) {
  const card = document.createElement('div');
  card.style.cssText = 'width:100%; display:flex; flex-direction:column; gap:6px; margin-bottom:10px;';
  const title = document.createElement('div');
  title.innerHTML = `<b>${MODE_ICON[mode] || ''} ${modeLabel(mode)}</b> <span class="muted" style="font-size:0.8rem;">(${T[state.lang].guild_battle_mode_avg}: ${modeAvg.toFixed(1)})</span>`;
  card.appendChild(title);

  const pool = [];
  Object.entries(perUser).forEach(([uid, u]) => {
    const arr = (u && Array.isArray(u[mode])) ? u[mode] : [];
    arr.forEach(entry => pool.push({
      uid, nick: (u && u.nick) || '?', score: entry.score,
      sessionId: entry.sessionId || null, durationMs: entry.durationMs,
    }));
  });
  // mesmo critério de desempate do servidor (compareBattleEntries em
  // functions/index.js): pontuação maior vence; empatando, menor tempo
  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = Number.isFinite(a.durationMs) ? a.durationMs : Infinity;
    const db_ = Number.isFinite(b.durationMs) ? b.durationMs : Infinity;
    return da - db_;
  });
  const top5 = pool.slice(0, 5);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
  if (!top5.length) {
    list.innerHTML = `<div class="muted" style="text-align:center; font-size:0.8rem;">${T[state.lang].guild_battle_no_scores_yet}</div>`;
  } else {
    top5.forEach((entry, i) => {
      const pos = i + 1;
      const medal = pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : pos;
      const row = document.createElement('div');
      row.className = 'card';
      row.style.cssText = 'flex-direction:row; align-items:center; justify-content:space-between; padding:8px 14px; gap:8px;';
      const left = document.createElement('span');
      left.style.cssText = 'display:flex; align-items:center; gap:8px; min-width:0;';
      const posSpan = document.createElement('span');
      posSpan.style.cssText = 'font-weight:800; min-width:1.4em; text-align:center; flex-shrink:0;';
      posSpan.textContent = medal;
      left.appendChild(posSpan);
      left.appendChild(buildLevelNickBlock((xpByUid && xpByUid[entry.uid]) || 0, entry.nick, ''));
      row.appendChild(left);
      const right = document.createElement('span');
      right.style.cssText = 'display:flex; align-items:center; gap:8px;';
      const scoreSpan = document.createElement('span');
      scoreSpan.style.fontWeight = '700';
      scoreSpan.textContent = entry.score;
      right.appendChild(scoreSpan);
      if (entry.sessionId) {
        const replayBtn = document.createElement('button');
        replayBtn.className = 'replay-btn';
        replayBtn.textContent = '▶️';
        replayBtn.onclick = () => {
          // fecha a popup ANTES de abrir o replay — senão a overlay fica
          // flutuando por cima da tela de replay (openReplay só troca entre
          // .screen, não mexe em .modal-overlay, ver js/nav.js)
          window.closeGuildBattleDetailModal();
          window.openReplay(entry.sessionId, entry.nick, {}, 'guild-battle-screen');
        };
        right.insertBefore(replayBtn, scoreSpan); // à ESQUERDA da pontuação, não à direita
      }
      row.appendChild(right);
      list.appendChild(row);
    });
  }
  card.appendChild(list);
  return card;
}
