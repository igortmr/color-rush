import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { show, resetScroll, pushScreenAndShow, popScreenBack } from './nav.js';
import { renderDailyPrizesLegend, modeUnlocked, applyRowTheme } from './levels.js';
import { equippedBadgeLabel, sharerTierLabel } from './badges.js';
import {
  fetchAllScores, rowData, compareRankRows, buildRankRowNick, RANKING_PAGE_SIZE
} from './ranking-cache.js';
import { loadDailyTodayRanking, resetDailyRankSubtabToToday } from './daily-ranking.js';
import { loadGuildRanking } from './guilds.js';

window.rankingBack = () => popScreenBack();

export const RANK_FIELDS = { classic: 'classic', reverse: 'reverse', shapes: 'shapes', 'shapes-reverse': 'shapes-reverse', trio: 'trio', caos: 'caos', mosaic: 'mosaic', level: 'xp', geral: 'total', divulgador: 'referrals' };

let rankingRows = [];
let rankingPage = 0;
let rankingTab = 'geral';
let rankingScope = 'geral'; // 'geral' = todo mundo (como já era), 'amigos' = só quem está na sua lista de amigos (+ você)

// exposta em window pra applyLanguage() (game-teste.js) poder re-renderizar
// a aba certa depois de trocar de idioma, sem esperar esse arquivo virar o
// dono de applyLanguage também (fase futura)
window.getRankingTab = () => rankingTab;

window.setRankingScope = (scope) => {
  rankingScope = scope;
  window.loadRanking(rankingTab);
};

window.loadRanking = async (m) => {
  rankingTab = m;
  $('ranking-select').value = m;

  // desafio diário tem sua própria estrutura (2 abas, sem escopo amigos/todos
  // — ver js/daily-ranking.js); clãs também tem estrutura própria (linhas de
  // CLà, não de jogador — ver js/guilds.js)
  $('daily-subtabs').style.display = (m === 'daily') ? '' : 'none';
  $('scope-tabs-row').style.display = (m === 'daily' || m === 'guilds') ? 'none' : '';
  $('daily-prizes-legend').style.display = (m === 'daily') ? '' : 'none';
  if (m === 'daily') {
    renderDailyPrizesLegend();
    $('ranking-pagination').innerHTML = '';
    $('ranking-explain').textContent = ''; // sem frase explicativa no ranking do desafio diário
    resetDailyRankSubtabToToday();
    $('ranking-table-card').style.display = '';
    $('daily-alltime-card').style.display = 'none';
    $('guild-ranking-card').style.display = 'none';
    loadDailyTodayRanking();
    return;
  }
  if (m === 'guilds') {
    $('ranking-pagination').innerHTML = '';
    $('ranking-explain').textContent = T[state.lang].guild_ranking_explain;
    $('ranking-table-card').style.display = 'none';
    $('daily-alltime-card').style.display = 'none';
    $('guild-ranking-card').style.display = '';
    loadGuildRanking();
    return;
  }

  // saindo do desafio diário/clãs — "ranking-table-card" é compartilhado com
  // o daily-today, e "daily-alltime-card"/"guild-ranking-card" só são
  // escondidos nos ramos acima; sem isso, sair do Salão da Fama ou da aba
  // Clãs pra outro ranking deixa a lista escondida mesmo com os dados
  // carregados certinho
  $('ranking-table-card').style.display = '';
  $('daily-alltime-card').style.display = 'none';
  $('guild-ranking-card').style.display = 'none';

  $('scope-geral-btn').classList.toggle('active', rankingScope === 'geral');
  $('scope-amigos-btn').classList.toggle('active', rankingScope === 'amigos');
  $('ranking-explain').textContent = (m === 'level') ? T[state.lang].level_explain : (m === 'divulgador') ? T[state.lang].divulgador_explain : '';
  $('ranking-points-header').textContent = (m === 'divulgador') ? T[state.lang].points_header_divulgador : (m === 'level') ? T[state.lang].points_header_level : T[state.lang].points_header;
  const field = RANK_FIELDS[m];
  const body = $('ranking-body');
  $('ranking-pagination').innerHTML = '';

  // ranking de amigos exige conta (não dá pra ter amigos jogando sem login)
  if (rankingScope === 'amigos' && (state.offline || !state.currentUser)) {
    body.innerHTML = `
      <tr><td colspan="3">
        <div class="card" style="text-align:center;">
          <p>${T[state.lang].profile_offline_msg1}</p>
          <button onclick="goSignup()">${T[state.lang].btn_create_account}</button>
        </div>
      </td></tr>`;
    rankingRows = [];
    resetScroll('ranking-screen');
    return;
  }

  body.innerHTML = `<tr><td colspan="3" class="muted">${T[state.lang].loading_text}</td></tr>`;
  try {
    const all = await fetchAllScores();
    // filtro de amigos usa o mesmo cache já lido pra tela de amigos — sem leitura extra
    const friendUids = (rankingScope === 'amigos') ? new Set(Object.keys(await window.fetchMyFriends())) : null;
    const rows = [];
    for (const r of all) {
      if (friendUids && r.uid !== state.currentUser.uid && !friendUids.has(r.uid)) continue;
      const data = rowData(r);
      // no ranking de nível todo mundo entra (mesmo com 0 XP)
      if (m === 'level') {
        rows.push({ uid: r.uid, nick: data.nick, pts: data.xp || 0, at: null, stats: data });
      } else if (data[field] > 0) {
        rows.push({ uid: r.uid, nick: data.nick, pts: data[field], at: data[field + 'At'], durationMs: data[field + 'DurationMs'], stats: data, replaySessionId: data[field + 'ReplaySessionId'] });
      }
    }
    // conta recém-criada pode ainda não estar no cache — insere a própria linha se faltar
    // TESTE.HTML: admin também entra aqui de propósito (ver fetchAllScores),
    // em produção não. Banido não entra nem aqui.
    if (!state.offline && state.currentUser && state.myData.nick && state.myData.banned !== true && (window.IS_TESTE || state.myData.admin !== true) && !rows.some(r => r.uid === state.currentUser.uid)) {
      if (m === 'level') rows.push({ uid: state.currentUser.uid, nick: state.myData.nick, pts: state.myData.xp || 0, at: null, stats: state.myData });
      else if ((state.myData[field] || 0) > 0) rows.push({ uid: state.currentUser.uid, nick: state.myData.nick, pts: state.myData[field], at: state.myData[field + 'At'], durationMs: state.myData[field + 'DurationMs'], stats: state.myData, replaySessionId: state.myData[field + 'ReplaySessionId'] });
    }
    rows.sort(compareRankRows);
    rankingRows = rows;
    rankingPage = 0;
    renderRankingPage();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="3" class="muted">${T[state.lang].ranking_error}</td></tr>`;
  }
};

function renderRankingPage() {
  const body = $('ranking-body');
  const start = rankingPage * RANKING_PAGE_SIZE;
  const pageRows = rankingRows.slice(start, start + RANKING_PAGE_SIZE);

  body.innerHTML = '';
  pageRows.forEach((r, i) => {
    const pos = start + i + 1;
    const medal = pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : pos;
    const ptsDisplay = r.pts;
    const tr = document.createElement('tr');
    if (state.currentUser && r.uid === state.currentUser.uid) tr.className = 'me';
    tr.innerHTML = `<td class="pos">${medal}</td><td class="nick-cell"></td><td class="pts">${ptsDisplay}</td>`;
    const nickCell = tr.children[1];
    const rankingBadgeHtml = (rankingTab === 'divulgador') ? sharerTierLabel(r.stats) : (rankingTab === 'level') ? '' : equippedBadgeLabel(r.stats);
    buildRankRowNick(nickCell, r, rankingBadgeHtml, 'ranking-screen');
    applyRowTheme(tr, r.stats);
    // botão de replay só aparece se o MODO desse ranking (rankingTab) já
    // estiver desbloqueado pro nível de quem está olhando — dá pra ver
    // ranking/pontuação de um modo ainda travado (curiosidade/motivação pra
    // subir de nível), só não libera espiar o replay de um modo que a pessoa
    // ainda nem pode jogar. modeUnlocked() já cobre sozinho os casos sem
    // trava (classic) e as abas que não são modo (geral/level/divulgador —
    // essas nem chegam a ter replaySessionId, ver window.loadRanking).
    if (r.replaySessionId && modeUnlocked(rankingTab)) {
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
  if (rankingRows.length === 0) body.innerHTML = `<tr><td colspan="3" class="muted">${rankingScope === 'amigos' ? T[state.lang].ranking_no_friends : T[state.lang].ranking_no_players}</td></tr>`;

  const totalPages = Math.max(1, Math.ceil(rankingRows.length / RANKING_PAGE_SIZE));
  const pag = $('ranking-pagination');
  if (totalPages <= 1) {
    pag.innerHTML = '';
  } else {
    pag.innerHTML = `
      <button class="link" onclick="rankingGoPage(${rankingPage - 1})" ${rankingPage === 0 ? 'disabled style="opacity:0.3;"' : ''}>${T[state.lang].pagination_prev}</button>
      <span class="muted">${T[state.lang].pagination_page(rankingPage + 1, totalPages)}</span>
      <button class="link" onclick="rankingGoPage(${rankingPage + 1})" ${rankingPage >= totalPages - 1 ? 'disabled style="opacity:0.3;"' : ''}>${T[state.lang].pagination_next}</button>`;
  }
  resetScroll('ranking-screen');
}

window.rankingGoPage = (p) => {
  const totalPages = Math.max(1, Math.ceil(rankingRows.length / RANKING_PAGE_SIZE));
  rankingPage = Math.max(0, Math.min(p, totalPages - 1));
  renderRankingPage();
};
