import {
  doc, getDoc, getDocs, query, collection, limit
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { db } from './firebase.js';
import { lvChip, applyNickFrame, applyRowTheme, applyGuildTagStyle, modeLabel } from './levels.js';
import { equippedBadgeLabel } from './badges.js';

export const RANKING_PAGE_SIZE = 20;

// maior pontuação primeiro; empate é desempatado por quem bateu o recorde primeiro
// desempate por MENOS TEMPO gasto na partida que gerou a pontuação (não mais
// "quem fez primeiro"). durationMs vem de <modo>DurationMs (ou
// bestScoreDurationMs no desafio diário — ver submitGameResult/
// submitDailyResult em functions/index.js), gravado a partir do mesmo
// elapsedMs que o anti-cheat já calculava, só quando aquela tentativa bate
// um recorde novo. Registros de antes dessa mudança (ou pontuação feita sem
// conta, sem sessão de servidor pra medir tempo — ver claimPendingScore) não
// têm esse campo; só nesse caso os dois lados caem de volta pro critério
// antigo (quem pontuou primeiro).
export function compareRankRows(a, b) {
  if (b.pts !== a.pts) return b.pts - a.pts;
  if (a.durationMs != null && b.durationMs != null) return a.durationMs - b.durationMs;
  const at = a.at ? a.at.toMillis() : Infinity;
  const bt = b.at ? b.at.toMillis() : Infinity;
  return at - bt;
}

// monta o conteúdo de uma célula de ranking: nível, nick e conquista/classe
// tudo numa coluna só (ver .nick-cell no <style>). Usado nas 4 tabelas de
// ranking (mini-ranking, ranking completo, desafio diário hoje e Salão da
// Fama) pra não duplicar essa estrutura 4x. badgeHtml já vem pronto de quem
// chama (equippedBadgeLabel/sharerTierLabel/'' variam conforme a tabela/aba).
//
// window.IS_TESTE (só teste.html) experimenta um layout novo: nível+clã+nick
// numa linha, título de conquista numa linha separada embaixo (mais
// discreto), em vez de tudo espremido numa linha só — protótipo visual, só
// tem CSS correspondente em css/style-teste.css de propósito, pra não
// arriscar nada na produção enquanto ainda tá em avaliação.
export function buildRankRowNick(nickCell, r, badgeHtml, backTarget) {
  // no layout de teste, o nível vira uma coluna própria (grid) que ocupa a
  // altura das duas linhas — daí o título ficar alinhado embaixo do NICK,
  // não embaixo do nível (pedido explícito depois de ver o protótipo v1,
  // onde o título começava lá da esquerda, debaixo do "Lv")
  const topRow = window.IS_TESTE ? document.createElement('div') : nickCell;
  if (window.IS_TESTE) {
    nickCell.classList.add('nick-cell-v2');
    nickCell.insertAdjacentHTML('beforeend', lvChip(r.stats && r.stats.xp));
    topRow.className = 'nick-top-row';
    nickCell.appendChild(topRow);
  } else {
    topRow.insertAdjacentHTML('beforeend', lvChip(r.stats && r.stats.xp));
  }
  // sigla do clã (se tiver) — clicável, abre a tela do clã (ver
  // window.openGuildFromTag em js/guilds.js, chamado via window de
  // propósito pelo mesmo motivo do uiChallengeFriend em js/friends.js)
  if (r.stats && r.stats.guildTag && r.stats.guildId) {
    const tagSpan = document.createElement('span');
    tagSpan.textContent = `[${r.stats.guildTag}]`; // sigla é sempre A-Z, mas por segurança vai via textContent também
    tagSpan.className = 'guild-tag-link';
    applyGuildTagStyle(tagSpan, r.stats.guildTagStyle);
    tagSpan.onclick = (ev) => { ev.stopPropagation(); window.openGuildFromTag(r.stats.guildId, backTarget); };
    topRow.appendChild(tagSpan);
  }
  const nickSpan = document.createElement('span'); // nick sempre via textContent, nunca interpolado
  nickSpan.textContent = r.nick;
  nickSpan.className = 'nick-click';
  applyNickFrame(nickSpan, r.stats);
  nickSpan.onclick = () => window.openProfileFromRanking(r, backTarget);
  topRow.appendChild(nickSpan);
  if (window.IS_TESTE) {
    if (badgeHtml) { // conteúdo fixo/confiável (ver equippedBadgeLabel/sharerTierLabel)
      const titleRow = document.createElement('div');
      titleRow.className = 'nick-title-row';
      titleRow.innerHTML = badgeHtml;
      nickCell.appendChild(titleRow);
    } else {
      // sem conquista equipada: não sobra uma 2ª linha vazia — em vez
      // disso centraliza nível+nick juntos na altura toda da linha (ver
      // .no-title em css/style-teste.css), pra ficar alinhado com o nível
      // igual pediram, em vez de ficar "puxado pra cima"
      nickCell.classList.add('no-title');
    }
  } else if (badgeHtml) {
    nickCell.insertAdjacentHTML('beforeend', badgeHtml);
  }
  return nickSpan;
}

// cache de 5min alinhado com a cadência do retrato pré-calculado (ver
// recomputeScoresSnapshot em functions/index.js) — não tem por que checar de
// novo antes disso, os dados só mudam quando aquela function roda. Os dados
// do PRÓPRIO jogador são sempre mesclados por cima do cache, então o seu
// recorde aparece na hora — só o dos outros pode demorar até 5 min.
const SCORES_CACHE_MS = 5 * 60 * 1000;
let scoresCache = { rows: null, at: 0 };
// usado pelo botão de admin "recalcular ranking agora" (ver game-teste.js)
// pra forçar a próxima leitura a ignorar o cache local de 5min
export function invalidateScoresCache() {
  scoresCache = { rows: null, at: 0 };
}

// se o retrato não for recalculado há mais que isso, algo parou de funcionar
// (function quebrada, agendamento removido etc.) — cai pro modo antigo em vez
// de deixar o ranking eternamente desatualizado ou vazio
const SCORES_SNAPSHOT_STALE_MS = 30 * 60 * 1000;

// lê o retrato em pedaços (ver recomputeScoresSnapshot) — poucas leituras
// (1 + nº de pedaços) em vez de até 300. Retorna null se o retrato ainda não
// existe (ex.: acabou de ser implantado, 1ª rodada da function ainda não
// rodou) ou parece velho demais — nesses casos fetchAllScores() cai pro modo
// antigo (ler a coleção "scores" ao vivo) como rede de segurança.
export async function fetchScoresFromSnapshot() {
  const metaSnap = await getDoc(doc(db, 'scoresSnapshot', 'meta'));
  if (!metaSnap.exists()) return null;
  const meta = metaSnap.data();
  const updatedMs = (meta.updatedAt && typeof meta.updatedAt.toMillis === 'function') ? meta.updatedAt.toMillis() : 0;
  if (!updatedMs || Date.now() - updatedMs > SCORES_SNAPSHOT_STALE_MS) return null;
  const chunkCount = meta.chunkCount || 0;
  if (chunkCount <= 0) return [];
  const chunkSnaps = await Promise.all(
    Array.from({ length: chunkCount }, (_, i) => getDoc(doc(db, 'scoresSnapshot', 'chunk_' + i)))
  );
  const rows = [];
  // contas banidas nunca aparecem em ranking nenhum (nem aqui em teste.html).
  // Admin fica de fora só em produção (window.IS_TESTE, setado em
  // main-teste.js) — em teste.html aparece de propósito, pra dar pra testar
  // com a própria conta admin. O retrato (recomputeScoresSnapshot em
  // functions/index.js) não filtra admin no servidor, então precisa filtrar
  // aqui igual fetchScoresLive logo abaixo.
  chunkSnaps.forEach(cs => { if (cs.exists()) (cs.data().rows || []).forEach(r => { if (r.data && r.data.banned !== true && (window.IS_TESTE || r.data.admin !== true)) rows.push(r); }); });
  return rows;
}

// leitura AO VIVO da coleção "scores" (sem cache, sem depender do retrato de
// 5min) — mesmo filtro de admin/banido de sempre. Usada como "modo antigo"
// de fetchAllScores() (rede de segurança se o retrato falhar) E pelo Salão
// da Fama (loadDailyAlltimeRanking), que precisa refletir dailyWins/
// pigmentos na hora — sem esperar o próximo ciclo do retrato nem o cache de
// 5min que o resto dos rankings continua usando normalmente.
export async function fetchScoresLive() {
  const snap = await getDocs(query(collection(db, 'scores'), limit(300)));
  const rows = [];
  snap.forEach(d => {
    const data = d.data();
    // TESTE.HTML: admin aparece normalmente em qualquer ranking aqui de
    // propósito (pra dar pra testar/depurar com a própria conta) — no
    // index.html (produção, window.IS_TESTE undefined) a exclusão de admin
    // continua valendo. Já banido fica de fora dos dois: não tem motivo pra
    // aparecer nem em teste
    if (data.nick && data.banned !== true && (window.IS_TESTE || data.admin !== true)) rows.push({ uid: d.id, data });
  });
  return rows;
}

export async function fetchAllScores() {
  if (scoresCache.rows && Date.now() - scoresCache.at < SCORES_CACHE_MS) return scoresCache.rows;
  try {
    const rows = await fetchScoresFromSnapshot();
    if (rows) { scoresCache = { rows, at: Date.now() }; return rows; }
  } catch (e) {
    console.warn('[scoresSnapshot] falha ao ler retrato, caindo pro modo antigo', e);
  }
  // modo antigo: lê a coleção "scores" ao vivo (até 300 leituras) — só
  // acontece se o retrato ainda não existir, estiver velho, ou a leitura
  // dele falhar por algum motivo; nunca deixa o ranking aparecer vazio
  const rows = await fetchScoresLive();
  scoresCache = { rows, at: Date.now() };
  return rows;
}
// linha de ranking com os dados do próprio jogador sempre frescos
export function rowData(r) {
  return (!state.offline && state.currentUser && r.uid === state.currentUser.uid) ? { ...r.data, ...state.myData } : r.data;
}

export async function renderRankPreview(field, bodyElId, myPts) {
  const body = $(bodyElId);
  body.innerHTML = `<tr><td colspan="3" class="muted">${T[state.lang].loading_text}</td></tr>`;
  try {
    const all = await fetchAllScores();
    const rows = [];
    for (const r of all) {
      const data = rowData(r);
      if (data[field] > 0) rows.push({ uid: r.uid, nick: data.nick, pts: data[field], at: data[field + 'At'], durationMs: data[field + 'DurationMs'], stats: data, replaySessionId: data[field + 'ReplaySessionId'] });
    }

    // localiza (ou insere) a linha do jogador — TESTE.HTML: admin também
    // entra aqui de propósito (ver comentário em fetchAllScores), em
    // produção não. Já banido não entra nem aqui: a própria conta banida
    // não deve se ver no ranking
    const youLabel = state.lang === 'en' ? 'YOU' : state.lang === 'es' ? 'TÚ' : 'VOCÊ';
    let myIndex = (!state.offline && state.currentUser) ? rows.findIndex(r => r.uid === state.currentUser.uid) : -1;
    if (myIndex === -1 && state.myData.banned !== true && (window.IS_TESTE || state.myData.admin !== true)) {
      rows.push({ uid: '__me__', nick: state.offline ? youLabel : (state.myData.nick || youLabel), pts: myPts, at: null, durationMs: state.offline ? undefined : state.myData[field + 'DurationMs'], stats: state.offline ? null : state.myData, replaySessionId: state.offline ? undefined : state.myData[field + 'ReplaySessionId'] });
    }

    rows.sort(compareRankRows);
    myIndex = rows.findIndex(r => r.uid === (!state.offline && state.currentUser ? state.currentUser.uid : '__me__'));

    // janela: 2 antes e 2 depois (expande pra manter 5 linhas quando possível)
    let start = Math.max(0, myIndex - 2);
    let end = Math.min(rows.length, myIndex + 3);
    while (end - start < 5 && (start > 0 || end < rows.length)) {
      if (start > 0) start--;
      else end++;
    }

    body.innerHTML = '';
    for (let i = start; i < end; i++) {
      const r = rows[i];
      const pos = i + 1;
      const medal = pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : pos + (state.lang === 'en' ? '' : 'º');
      const tr = document.createElement('tr');
      if (i === myIndex) tr.className = 'me';
      tr.innerHTML = `<td class="pos">${medal}</td><td class="nick-cell"></td><td class="pts">${r.pts}</td>`;
      const nickCell = tr.children[1];
      buildRankRowNick(nickCell, r, r.stats ? equippedBadgeLabel(r.stats) : '', 'over-screen');
      applyRowTheme(tr, r.stats);
      if (r.replaySessionId) {
        const ptsCell = tr.children[2];
        const replayBtn = document.createElement('button');
        replayBtn.className = 'replay-btn';
        replayBtn.textContent = '▶️';
        replayBtn.title = T[state.lang].btn_watch_replay;
        replayBtn.onclick = (ev) => { ev.stopPropagation(); window.openReplay(r.replaySessionId, r.nick, r.stats); };
        ptsCell.appendChild(replayBtn);
      }
      body.appendChild(tr);
    }
    if (rows.length === 0) body.innerHTML = `<tr><td colspan="3" class="muted">${T[state.lang].ranking_no_players_mini}</td></tr>`;
  } catch {
    body.innerHTML = `<tr><td colspan="3" class="muted">${T[state.lang].ranking_error_mini}</td></tr>`;
  }
}

// myScore: pontuação da rodada que acabou de terminar (só importa em modo
// offline, quando ainda não tem nada salvo em state.myData) — vem de quem
// chama porque a variável "score" do loop principal do jogo ainda não é
// compartilhada entre módulos (ver js/game-core.js quando existir)
export function renderMiniRankings(m, myScore) {
  $('mini-mode').textContent = modeLabel(m);
  const myModePts = state.offline ? myScore : (state.myData[m] || 0);
  renderRankPreview(m, 'mini-ranking-body', myModePts);
}
