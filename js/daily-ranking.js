import {
  getDocs, query, collection, where
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { db } from './firebase.js';
import { resetScroll } from './nav.js';
import { applyRowTheme, isWeeklyPassActive } from './levels.js';
import { equippedBadgeLabel } from './badges.js';
import { DAILY_MAX_ATTEMPTS } from './constants.js';
import {
  fetchAllScores, fetchScoresLive, rowData, compareRankRows, buildRankRowNick,
  RANKING_PAGE_SIZE
} from './ranking-cache.js';

/* ================== ranking do desafio diário ==================
   "Hoje": lê dailyScores filtrando por dateStr==hoje (índice simples, sem
   precisar de índice composto) e ordena no JS pela melhor pontuação.
   "Salão da Fama": reaproveita o mesmo fetchAllScores() (coleção scores) que
   já alimenta os outros rankings — dailyWins/pigmentos são só mais dois
   campos daquele mesmo documento. */
let dailyRankSubtab = 'today'; // 'today' | 'alltime'
let dailyTodayRows = [], dailyTodayPage = 0;
let dailyAlltimeRows = [], dailyAlltimePage = 0;

// linhas do ranking "Hoje" do desafio diário, já ordenadas — extraído de
// loadDailyTodayRanking pra poder ser reaproveitado por computeMyDailyTodayRank
// (card do menu) sem duplicar a consulta/filtro/desempate
async function fetchDailyTodayRows() {
  const dateStr = window.dailyLocalDateStr();
  const snap = await getDocs(query(collection(db, 'dailyScores'), where('dateStr', '==', dateStr)));
  const all = await fetchAllScores(); // só pra enriquecer com nível/chip de quem já está no cache (2 min)
  const statsByUid = {};
  all.forEach(r => { statsByUid[r.uid] = rowData(r); });
  const rows = [];
  snap.forEach(d => {
    const data = d.data();
    if ((data.attempts || 0) <= 0 || !data.nick) return;
    const isMe = state.currentUser && data.uid === state.currentUser.uid;
    // aproveita que a própria linha já vem nesse mesmo snap (é só mais um
    // documento de dailyScores) pra atualizar o nº de tentativas usadas com
    // dado fresco direto do servidor — usado logo abaixo em
    // renderDailyTodayPage pra decidir se os botões de replay já podem
    // aparecer (ver comentário lá)
    if (isMe) window.setDailyAttemptsUsed(data.attempts || 0);
    // TESTE.HTML: admin aparece normalmente aqui de propósito (pra dar pra
    // testar/depurar o ranking do desafio diário com a própria conta) — no
    // index.html (produção, window.IS_TESTE undefined) a exclusão de admin
    // continua valendo
    const stats = statsByUid[data.uid] || (isMe ? state.myData : null);
    // banido não aparece nem no próprio ranking dele: statsByUid já veio
    // filtrado (fetchAllScores exclui banned), então isso só cobre o caso
    // isMe acima, que usa state.myData direto e não passa por esse filtro
    if (!stats || stats.banned === true) return;
    // idem pra admin: statsByUid já vem filtrado por fetchAllScores em
    // produção, mas o caso isMe (state.myData direto) não passa por lá
    if (!window.IS_TESTE && stats.admin === true) return;
    // bestScoreAt/bestScoreDurationMs só avançam no servidor quando a
    // tentativa bate um recorde novo do dia (ver submitDailyResult em
    // functions/index.js) — não é só "última tentativa enviada", então dá
    // pra usar de verdade pro desempate por menos tempo gasto, igual já é
    // feito nos outros rankings (compareRankRows)
    rows.push({ uid: data.uid, nick: data.nick, pts: data.bestScore || 0, at: data.bestScoreAt || null, durationMs: data.bestScoreDurationMs, stats, replaySessionId: data.bestScoreSessionId });
  });
  rows.sort(compareRankRows);
  return rows;
}

export async function loadDailyTodayRanking() {
  const body = $('ranking-body');
  body.innerHTML = `<tr><td colspan="3" class="muted">${T[state.lang].loading_text}</td></tr>`;
  try {
    dailyTodayRows = await fetchDailyTodayRows();
    dailyTodayPage = 0;
    renderDailyTodayPage();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="3" class="muted">${T[state.lang].ranking_error}</td></tr>`;
  }
}

// posição de hoje no desafio diário (mesmo critério do sub-ranking "Hoje"
// acima) — usada só pelo card do menu (Xº do lado do 🎯 Melhor), sem
// paginar/montar linha nenhuma, só a posição de quem tá logado
export async function computeMyDailyTodayRank() {
  if (state.offline || !state.currentUser) return null;
  try {
    const rows = await fetchDailyTodayRows();
    const idx = rows.findIndex(r => r.uid === state.currentUser.uid);
    return idx === -1 ? null : idx + 1;
  } catch {
    return null;
  }
}

function renderDailyTodayPage() {
  const body = $('ranking-body');
  const start = dailyTodayPage * RANKING_PAGE_SIZE;
  const pageRows = dailyTodayRows.slice(start, start + RANKING_PAGE_SIZE);
  body.innerHTML = '';
  pageRows.forEach((r, i) => {
    const pos = start + i + 1;
    const medal = pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : pos;
    const tr = document.createElement('tr');
    if (state.currentUser && r.uid === state.currentUser.uid) tr.className = 'me';
    tr.innerHTML = `<td class="pos">${medal}</td><td class="nick-cell"></td><td class="pts">${r.pts}</td>`;
    const nickCell = tr.children[1];
    buildRankRowNick(nickCell, r, equippedBadgeLabel(r.stats), 'ranking-screen');
    applyRowTheme(tr, r.stats);
    // botão de replay só aparece depois que VOCÊ (quem está olhando) já usou
    // as 3 tentativas de hoje — a rodada do desafio diário é igual pra todo
    // mundo, então assistir o replay de alguém ANTES de terminar suas
    // próprias tentativas seria colar (você veria o tabuleiro inteiro de
    // antemão). Não depende de quantas tentativas o DONO da linha usou, só
    // das suas.
    // DAILY_MAX_ATTEMPTS + 1 se o Passe Semanal estiver ativo (ver
    // dailyMaxAttempts em js/daily-challenge.js — mesmo cálculo, duplicado
    // aqui pra não criar import circular entre os dois arquivos)
    const myDailyMaxAttempts = DAILY_MAX_ATTEMPTS + (isWeeklyPassActive(state.myData) ? 1 : 0);
    if (r.replaySessionId && window.getDailyAttemptsUsed() >= myDailyMaxAttempts) {
      const ptsCell = tr.children[2];
      const replayBtn = document.createElement('button');
      replayBtn.className = 'replay-btn';
      replayBtn.textContent = '▶️';
      replayBtn.title = T[state.lang].btn_watch_replay;
      replayBtn.onclick = (ev) => { ev.stopPropagation(); window.openReplay(r.replaySessionId, r.nick, r.stats); };
      ptsCell.insertBefore(replayBtn, ptsCell.firstChild); // à ESQUERDA da pontuação, não à direita
    }
    body.appendChild(tr);
  });
  if (dailyTodayRows.length === 0) body.innerHTML = `<tr><td colspan="3" class="muted">${T[state.lang].daily_no_today_players}</td></tr>`;
  const totalPages = Math.max(1, Math.ceil(dailyTodayRows.length / RANKING_PAGE_SIZE));
  const pag = $('ranking-pagination');
  pag.innerHTML = totalPages <= 1 ? '' : `
    <button class="link" onclick="dailyTodayGoPage(${dailyTodayPage - 1})" ${dailyTodayPage === 0 ? 'disabled style="opacity:0.3;"' : ''}>${T[state.lang].pagination_prev}</button>
    <span class="muted">${T[state.lang].pagination_page(dailyTodayPage + 1, totalPages)}</span>
    <button class="link" onclick="dailyTodayGoPage(${dailyTodayPage + 1})" ${dailyTodayPage >= totalPages - 1 ? 'disabled style="opacity:0.3;"' : ''}>${T[state.lang].pagination_next}</button>`;
  resetScroll('ranking-screen');
}
window.dailyTodayGoPage = (p) => {
  const totalPages = Math.max(1, Math.ceil(dailyTodayRows.length / RANKING_PAGE_SIZE));
  dailyTodayPage = Math.max(0, Math.min(p, totalPages - 1));
  renderDailyTodayPage();
};

export async function loadDailyAlltimeRanking() {
  const body = $('daily-alltime-body');
  body.innerHTML = `<tr><td colspan="4" class="muted">${T[state.lang].loading_text}</td></tr>`;
  try {
    // Salão da Fama sempre lê AO VIVO (fetchScoresLive), não o retrato de
    // 5min nem o cache de fetchAllScores — é o único ranking que precisa
    // refletir dailyWins/pigmentos na hora, logo depois do resolveDailyChallenge
    const all = await fetchScoresLive();
    const rows = [];
    for (const r of all) {
      const data = rowData(r);
      const wins = data.dailyWins || 0;
      // pigmentosEarned: total ganho participando do desafio diário, desde
      // sempre — só sobe (ver resolveDailyChallenge), nunca desce quando a
      // pessoa gasta pigmentos na loja (esse gasto mexe só em "pigmentos",
      // o saldo gastável, não nesse total histórico).
      const pig = data.pigmentosEarned || 0;
      if (wins > 0 || pig > 0) rows.push({ uid: r.uid, nick: data.nick, wins, pig, stats: data });
    }
    // mais colunas => a ordenação mais importante é o nº de vitórias de 1º lugar
    rows.sort((a, b) => (b.wins - a.wins) || (b.pig - a.pig));
    dailyAlltimeRows = rows;
    dailyAlltimePage = 0;
    renderDailyAlltimePage();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="4" class="muted">${T[state.lang].ranking_error}</td></tr>`;
  }
}
function renderDailyAlltimePage() {
  const body = $('daily-alltime-body');
  const start = dailyAlltimePage * RANKING_PAGE_SIZE;
  const pageRows = dailyAlltimeRows.slice(start, start + RANKING_PAGE_SIZE);
  body.innerHTML = '';
  pageRows.forEach((r, i) => {
    const pos = start + i + 1;
    const medal = pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : pos;
    const tr = document.createElement('tr');
    if (state.currentUser && r.uid === state.currentUser.uid) tr.className = 'me';
    tr.innerHTML = `<td class="pos">${medal}</td><td class="nick-cell"></td><td class="pts">${r.wins}</td><td class="pts">${r.pig}</td>`;
    const nickCell = tr.children[1];
    buildRankRowNick(nickCell, r, equippedBadgeLabel(r.stats), 'ranking-screen');
    applyRowTheme(tr, r.stats);
    body.appendChild(tr);
  });
  if (dailyAlltimeRows.length === 0) body.innerHTML = `<tr><td colspan="4" class="muted">${T[state.lang].daily_no_wins_yet}</td></tr>`;
  const totalPages = Math.max(1, Math.ceil(dailyAlltimeRows.length / RANKING_PAGE_SIZE));
  const pag = $('ranking-pagination');
  pag.innerHTML = totalPages <= 1 ? '' : `
    <button class="link" onclick="dailyAlltimeGoPage(${dailyAlltimePage - 1})" ${dailyAlltimePage === 0 ? 'disabled style="opacity:0.3;"' : ''}>${T[state.lang].pagination_prev}</button>
    <span class="muted">${T[state.lang].pagination_page(dailyAlltimePage + 1, totalPages)}</span>
    <button class="link" onclick="dailyAlltimeGoPage(${dailyAlltimePage + 1})" ${dailyAlltimePage >= totalPages - 1 ? 'disabled style="opacity:0.3;"' : ''}>${T[state.lang].pagination_next}</button>`;
  resetScroll('ranking-screen');
}
window.dailyAlltimeGoPage = (p) => {
  const totalPages = Math.max(1, Math.ceil(dailyAlltimeRows.length / RANKING_PAGE_SIZE));
  dailyAlltimePage = Math.max(0, Math.min(p, totalPages - 1));
  renderDailyAlltimePage();
};
// zera a sub-aba do Salão da Fama pra "hoje" sem disparar o carregamento
// (quem chama já vai chamar loadDailyTodayRanking/loadDailyAlltimeRanking
// em seguida) — usado só por window.loadRanking (ranking.js) ao entrar na
// aba "daily" vindo de outro ranking
export function resetDailyRankSubtabToToday() {
  dailyRankSubtab = 'today';
  $('daily-subtab-today-btn').classList.add('active');
  $('daily-subtab-alltime-btn').classList.remove('active');
}
window.setDailyRankSubtab = (tab) => {
  dailyRankSubtab = tab;
  $('daily-subtab-today-btn').classList.toggle('active', tab === 'today');
  $('daily-subtab-alltime-btn').classList.toggle('active', tab === 'alltime');
  $('ranking-table-card').style.display = (tab === 'today') ? '' : 'none';
  $('daily-alltime-card').style.display = (tab === 'alltime') ? '' : 'none';
  if (tab === 'today') loadDailyTodayRanking(); else loadDailyAlltimeRanking();
};
