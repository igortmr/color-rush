import { state } from './state.js';
import { T } from './i18n.js';
import { pushScreenAndShow } from './nav.js';
import { ALL_MODES } from './constants.js';
import { modeLabel } from './levels.js';
import { BADGE_ORDER, BADGE_DEFS, TIER_COLORS, unlockedTier } from './badges.js';
import { fetchAllScores, rowData, compareRankRows } from './ranking-cache.js';
import { RANK_FIELDS } from './ranking.js';

// abre o perfil ao clicar num nick do ranking (mini ou completo). Se for você
// mesmo, abre a versão própria de sempre (editável, dados sempre frescos);
// senão, abre a versão somente-leitura (medalhas + posição no ranking).
// window.renderProfile vem de game-teste.js (ainda não é um módulo próprio —
// fase futura), exposta lá só pra essa ponte funcionar
export function openProfileFromRanking(r, backTarget) {
  pushScreenAndShow('profile-screen', backTarget);
  const isMe = !state.offline && state.currentUser && (r.uid === state.currentUser.uid || r.uid === '__me__');
  if (isMe) window.renderProfile();
  else window.renderProfile(r.stats, r.nick, r.uid);
}
// exposta em window pra js/ranking-cache.js (buildRankRowNick) poder chamar
// sem esperar o perfil ganhar seu próprio módulo (fase futura)
window.openProfileFromRanking = openProfileFromRanking;

// pra cada ranking em que o jogador já pontuou (os 4 modos + geral/nível/
// divulgador via RANK_FIELDS, mais o Salão da Fama do desafio diário à parte),
// calcula a posição dele — reaproveita o mesmo cache de fetchAllScores() que já
// alimenta os rankings normais, então não gera nenhuma consulta nova ao
// Firestore (a não ser que o cache de 5min já tenha expirado).
export async function computeModeRanks(uid) {
  const all = await fetchAllScores();
  const ranks = {};
  for (const key of Object.keys(RANK_FIELDS)) {
    const field = RANK_FIELDS[key];
    const rows = [];
    for (const r of all) {
      const data = rowData(r);
      if ((data[field] || 0) > 0) rows.push({ uid: r.uid, pts: data[field], at: data[field + 'At'], durationMs: data[field + 'DurationMs'] });
    }
    rows.sort(compareRankRows);
    const idx = rows.findIndex(x => x.uid === uid);
    if (idx !== -1) ranks[key] = idx + 1;
  }
  // Salão da Fama (desafio diário) — ranking à parte: ordena por vitórias de
  // 1º lugar e depois por pigmentos acumulados (mesma lógica de
  // loadDailyAlltimeRanking), não é um campo simples então fica fora do loop
  const dailyRows = [];
  for (const r of all) {
    const data = rowData(r);
    const wins = data.dailyWins || 0;
    const pig = (data.pigmentos || 0) + (data.pendingPigmentos || 0);
    if (wins > 0 || pig > 0) dailyRows.push({ uid: r.uid, wins, pig });
  }
  dailyRows.sort((a, b) => (b.wins - a.wins) || (b.pig - a.pig));
  const dailyIdx = dailyRows.findIndex(x => x.uid === uid);
  if (dailyIdx !== -1) ranks.daily = dailyIdx + 1;
  return ranks;
}

// perfil de OUTRA pessoa: só a medalha mais atual (mais alta) de cada
// categoria, com o nome — sem barra de progresso nem os chips de todos os
// níveis, que só fazem sentido olhando o próprio progresso.
export function renderPublicProfileBadges(stats) {
  const items = BADGE_ORDER.map(key => {
    const def = BADGE_DEFS[key];
    const tier = unlockedTier(def, stats);
    if (tier < 0) return null;
    const color = TIER_COLORS[tier];
    const name = def.names[state.lang][tier];
    const val = def.metric(stats).toLocaleString(state.lang === 'en' ? 'en-US' : state.lang === 'es' ? 'es-ES' : 'pt-BR');
    return `
      <div class="card" style="flex-direction:row; align-items:center; justify-content:space-between; gap:12px; padding:14px;">
        <div style="display:flex; align-items:center; gap:12px;">
          <span class="badge-chip big" style="background:${color}">${def.icon}</span>
          <div>
            <div class="name" style="font-family:'Orbitron',sans-serif; font-weight:700; font-size:0.95rem;">${def.label[state.lang]}</div>
            <div class="muted" style="text-align:left;">${name}</div>
          </div>
        </div>
        <div style="text-align:right; font-family:'Orbitron',sans-serif; font-weight:800; color:#fff; font-size:1.1rem;">${val}</div>
      </div>`;
  }).filter(Boolean);
  return items.length ? items.join('') : `<div class="muted" style="text-align:center;">${T[state.lang].profile_no_badges_yet}</div>`;
}

// posição no ranking de cada modo em que a pessoa já pontuou (medalha pro
// top 3, número pros demais) — vazio se ela ainda não pontuou em nenhum modo
export function renderPublicProfileRanks(stats, ranks) {
  const MODE_ICON = { classic: '🎨', reverse: '🔄', shapes: '🔶', 'shapes-reverse': '🔸', trio: '🔺', caos: '🌀' };
  // cada linha leva pra aba daquele ranking no clique (ver profileRankGoto)
  const row = (label, pos, key) => {
    const medal = pos === 1 ? '🥇 ' : pos === 2 ? '🥈 ' : pos === 3 ? '🥉 ' : '';
    return `
      <div class="card" style="flex-direction:row; align-items:center; justify-content:space-between; padding:12px 16px; cursor:pointer;" onclick="profileRankGoto('${key}')">
        <span>${label}</span>
        <span style="font-family:'Orbitron',sans-serif; font-weight:800; color:var(--neon-orange); font-size:1.1rem;">${medal}#${pos}</span>
      </div>`;
  };
  const items = [];
  // geral primeiro (visão resumida da pessoa), depois os modos individuais,
  // nível, divulgador e por último o Salão da Fama
  if ((stats.total || 0) > 0 && ranks.geral) items.push(row(T[state.lang].tab_geral, ranks.geral, 'geral'));
  ALL_MODES.forEach(m => {
    if (stats[m] > 0 && ranks[m]) items.push(row(`${MODE_ICON[m]} ${modeLabel(m)}`, ranks[m], m));
  });
  // rankings gerais — mesmos campos (RANK_FIELDS) e rótulos com emoji já
  // embutido das <option> da tela de ranking completo, pra ficar consistente
  [['level', T[state.lang].tab_level], ['divulgador', T[state.lang].tab_divulgador]].forEach(([key, label]) => {
    const field = RANK_FIELDS[key];
    if ((stats[field] || 0) > 0 && ranks[key]) items.push(row(label, ranks[key], key));
  });
  // Salão da Fama do desafio diário — não é um RANK_FIELDS comum (ver
  // computeModeRanks), por isso checado à parte aqui
  const dailyPig = (stats.pigmentos || 0) + (stats.pendingPigmentos || 0);
  if (((stats.dailyWins || 0) > 0 || dailyPig > 0) && ranks.daily) items.push(row(T[state.lang].daily_subtab_alltime, ranks.daily, 'daily'));
  return items.join('');
}
// clique numa linha de posição no ranking do perfil de outra pessoa — leva
// direto pra aquela aba do ranking completo. Salão da Fama é tratado à
// parte porque mora numa sub-aba (ver setDailyRankSubtab) dentro da aba
// "daily", não é uma aba própria como as outras
window.profileRankGoto = (key) => {
  window.showRanking(key, 'profile-screen');
  if (key === 'daily') window.setDailyRankSubtab('alltime');
};

export function profileSectionLabel(text) {
  return `<div class="muted" style="text-align:left; font-family:'Orbitron',sans-serif; font-size:0.75rem; letter-spacing:0.5px; text-transform:uppercase; margin-top:4px;">${text}</div>`;
}
