import {
  doc, setDoc, serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db, callable } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { pushScreenAndShow, popScreenBack, resetScroll, show } from './nav.js';
import { avatarOrDefaultIcon, applyNickFrame, applyGuildTagStyle, lvChip, myXp } from './levels.js';
import {
  BADGE_ORDER, BADGE_DEFS, TIER_COLORS, unlockedTier, badgePillHtml,
  newBadgeCountFor, markAllBadgesSeen
} from './badges.js';
import { renderProfileFriendAction } from './friends.js';
import {
  computeModeRanks, renderPublicProfileRanks, renderPublicProfileBadges,
  profileSectionLabel
} from './profile-public.js';
import { renderAdminPanel, renderAdminToolsHtml } from './admin.js';

const callClaimPendingScore = callable('claimPendingScore');

window.goSignup = () => {
  state.offline = false;
  show('auth-screen');
};

/* ================== perfil / conquistas ================== */
window.showProfile = () => {
  pushScreenAndShow('profile-screen', 'menu-screen');
  renderProfile();
};
window.profileBack = () => popScreenBack();

// sem argumentos: perfil PRÓPRIO (editável, lê de state.myData ao vivo, badges
// completos com progresso). Com viewStats/viewNick/viewUid: perfil de OUTRO
// jogador — somente leitura, medalha atual de cada categoria + posição no
// ranking em cada modo (ver openProfileFromRanking em profile-public.js).
async function renderProfile(viewStats, viewNick, viewUid) {
  const isOther = !!viewStats;
  const stats = isOther ? viewStats : state.myData;

  $('profile-invite-btn').style.display = (!isOther && !state.offline) ? '' : 'none';
  const showOwnRefCode = !isOther && !state.offline && !!state.myData.refCode;
  $('profile-refcode-row').style.display = showOwnRefCode ? 'flex' : 'none';
  if (showOwnRefCode) $('profile-refcode-value').textContent = state.myData.refCode;
  // "ficar invisível" — só no próprio perfil (ver toggleHideOnlineStatus
  // abaixo e a bolinha de online em js/dms.js)
  const showOnlineToggle = !isOther && !state.offline;
  $('profile-online-toggle-row').style.display = showOnlineToggle ? 'flex' : 'none';
  if (showOnlineToggle) updateHideOnlineToggleUI();

  if (!isOther && state.offline) {
    $('profile-nick-avatar').innerHTML = '';
    $('profile-nick-text').textContent = T[state.lang].profile_offline_label;
    $('profile-nick-lv').innerHTML = '';
    $('profile-summary').textContent = '';
    $('profile-friend-action').style.display = 'none';
    $('profile-friend-action').innerHTML = '';
    $('profile-friend-status').textContent = '';
    $('profile-guild-invite-action').innerHTML = '';
    $('profile-body').innerHTML = `
      <div class="card" style="text-align:center;">
        <p>${T[state.lang].profile_offline_msg1}</p>
        <p class="muted">${T[state.lang].profile_offline_msg2}</p>
        <button onclick="goSignup()">${T[state.lang].btn_create_account}</button>
      </div>`;
    resetScroll('profile-screen');
    return;
  }

  // avatar e nível são markup fixo/confiável (innerHTML tudo bem); o nick
  // sempre via textContent (nunca innerHTML) pra não abrir brecha de injeção.
  // Cada pedaço tem seu próprio <span> dedicado (profile-nick-avatar/-text/-lv)
  // e é sempre SUBSTITUÍDO (nunca acrescentado) — antes usava insertAdjacentHTML
  // direto no #profile-nick, o que podia deixar ícone duplicado se essa função
  // rodasse mais de uma vez em sequência (ex.: ao trocar a medalha equipada).
  $('profile-nick-avatar').innerHTML = avatarOrDefaultIcon(stats.equipped && stats.equipped.avatar, 42) + ' ';
  $('profile-nick-text').textContent = T[state.lang].profile_nick_label(isOther ? (viewNick || '') : (state.myData.nick || ''));
  $('profile-nick-lv').innerHTML = ' ' + lvChip(isOther ? (stats.xp || 0) : myXp());
  applyNickFrame($('profile-nick'), stats);
  // sigla do clã (se tiver) — clicável, mesmo padrão de buildRankRowNick em
  // js/ranking-cache.js (window.openGuildFromTag, ver js/guilds.js)
  const tagEl = $('profile-nick-guild-tag');
  tagEl.innerHTML = '';
  if (stats.guildTag && stats.guildId) {
    const tagSpan = document.createElement('span');
    tagSpan.textContent = ` [${stats.guildTag}]`;
    tagSpan.className = 'guild-tag-link';
    applyGuildTagStyle(tagSpan, stats.guildTagStyle);
    tagSpan.onclick = () => window.openGuildFromTag(stats.guildId, 'profile-screen');
    tagEl.appendChild(tagSpan);
  }

  if (isOther) {
    $('profile-summary').textContent = '';
    renderProfileFriendAction(viewUid, viewNick || '');
    // botão "convidar pro clã" — window.renderGuildInviteAction vem de
    // js/guilds.js (perfil ainda não conhece o domínio de clãs, mesmo padrão
    // de window.openGuildFromTag logo acima)
    if (window.renderGuildInviteAction) window.renderGuildInviteAction(viewUid, viewNick || '');
    const ranks = await computeModeRanks(viewUid);
    const ranksHtml = renderPublicProfileRanks(stats, ranks);
    let html = '';
    if (ranksHtml) html += profileSectionLabel(T[state.lang].profile_ranks_section) + ranksHtml;
    html += profileSectionLabel(T[state.lang].profile_badges_section) + renderPublicProfileBadges(stats);
    // painel só pra admin (state.myData.admin, setado à mão no Firebase Console) —
    // último login, últimos duelos e amigos de QUALQUER jogador, com opção de
    // editar o nick e banir a conta, tudo validado de novo no servidor (ver
    // requireAdmin em functions/index.js — o cliente decidir mostrar isso aqui
    // é só conveniência de UI, não é o que garante a permissão)
    if (state.myData.admin === true) {
      html += profileSectionLabel('🛠️ Admin') + `<div class="card" id="admin-panel-body"><div class="muted" style="text-align:center;">Carregando dados de admin...</div></div>`;
    }
    $('profile-body').innerHTML = html;
    resetScroll('profile-screen');
    if (state.myData.admin === true) renderAdminPanel(viewUid, viewNick || '', stats);
    return;
  }

  $('profile-friend-action').style.display = 'none';
  $('profile-friend-action').innerHTML = '';
  $('profile-friend-status').textContent = '';
  $('profile-guild-invite-action').innerHTML = '';

  // conta cada NÍVEL desbloqueado dentro de cada categoria (não só se a categoria
  // foi iniciada) — cada categoria tem 6 níveis, então o total é 4×6 = 24
  const unlockedCount = BADGE_ORDER.reduce((n, k) => {
    const t = unlockedTier(BADGE_DEFS[k], stats);
    return n + (t >= 0 ? t + 1 : 0);
  }, 0);
  const totalLevels = BADGE_ORDER.reduce((n, k) => n + BADGE_DEFS[k].tiers.length, 0);
  $('profile-summary').textContent = T[state.lang].profile_summary(unlockedCount, totalLevels);
  $('profile-body').innerHTML = BADGE_ORDER.map(key => renderBadgeCard(key, BADGE_DEFS[key], stats)).join('');
  // ferramentas avulsas só pra admin (state.myData.admin, setado à mão no
  // Firebase Console) — ver renderAdminToolsHtml em js/admin.js
  if (state.myData.admin === true) {
    $('profile-body').insertAdjacentHTML('beforeend', renderAdminToolsHtml());
  }
  $('profile-body').insertAdjacentHTML('beforeend', `
    <div class="card" style="text-align:left;">
      <b data-i18n="delete_account_title">⚠️ Excluir conta</b>
      <p class="muted" style="margin-top:6px;" data-i18n="delete_account_desc">Apaga permanentemente sua conta e todos os dados vinculados a ela (pontuações, XP, amigos, medalhas, Pigmentos). Essa ação não pode ser desfeita.</p>
      <button class="secondary" style="border-color:var(--neon-red,#ff2d6b); color:var(--neon-red,#ff2d6b); margin-top:6px;" onclick="startDeleteMyAccount(this)" data-i18n="delete_account_btn">Excluir minha conta</button>
      <div class="muted" id="delete-account-status" style="margin-top:6px;"></div>
    </div>`);
  resetScroll('profile-screen');
  // agora que a pessoa viu o próprio perfil (com todas as categorias e a
  // bolinha mostrando qual tinha novidade), marca tudo como visto — some a
  // bolinha do nick até desbloquear algo novo de novo
  markAllBadgesSeen();
}
// exposta em window pra js/profile-public.js (openProfileFromRanking) poder
// chamar sem esperar o perfil ganhar seu próprio módulo (fase futura)
window.renderProfile = renderProfile;

function renderBadgeCard(key, def, stats) {
  const tier = unlockedTier(def, stats);
  const val = def.metric(stats);
  const maxed = tier === def.tiers.length - 1;
  const color = tier >= 0 ? TIER_COLORS[tier] : '#0f3460';
  const currentName = tier >= 0 ? def.names[state.lang][tier] : T[state.lang].badge_not_unlocked;
  const newCount = newBadgeCountFor(key); // quantos níveis novos essa categoria tem ainda não vistos

  let progressHtml;
  if (maxed) {
    progressHtml = `<div class="muted" style="text-align:left;">${T[state.lang].badge_maxed}</div>`;
  } else {
    const nextThreshold = def.tiers[tier + 1];
    if (def.inverse) {
      const posText = (val === Infinity) ? T[state.lang].badge_rank_unknown : T[state.lang].badge_rank_current(val);
      progressHtml = `<div class="muted" style="text-align:left;">${posText}<br>${T[state.lang].badge_next_goal(def.desc(nextThreshold))}</div>`;
    } else {
      const pct = Math.min(100, Math.max(0, (val / nextThreshold) * 100));
      progressHtml = `
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="muted" style="text-align:left;">${val} / ${nextThreshold} — ${def.desc(nextThreshold)}</div>`;
    }
  }

  // qual nível desta categoria está sendo exibido no ranking agora (-1 se a
  // categoria nem está equipada) — não precisa ser o mais alto desbloqueado,
  // ver setEquippedBadgeTier/equippedBadgeLabel
  const equippedTier = (state.myData.equippedBadge === key)
    ? ((typeof state.myData.equippedBadgeTier === 'number' && state.myData.equippedBadgeTier <= tier) ? state.myData.equippedBadgeTier : tier)
    : -1;

  // cada chip DESBLOQUEADO é clicável — escolhe direto aquele nível pra
  // exibir no ranking (não precisa ser o mais alto). Clicar no que já está
  // sendo exibido desequipa a categoria inteira.
  const chips = def.tiers.map((th, i) => {
    const unlocked = i <= tier;
    const lockOverlay = unlocked ? '' : '<span class="chip-lock">🔒</span>';
    const isShown = i === equippedTier;
    const clickAttr = unlocked ? ` onclick="setEquippedBadgeTier('${key}', ${i})"` : '';
    const cursorStyle = unlocked ? 'cursor:pointer;' : '';
    return `<span class="chip-wrap"><span class="badge-chip${unlocked ? '' : ' locked'}${isShown ? ' equipped' : ''}" style="background:${TIER_COLORS[i]};${cursorStyle}" title="${def.names[state.lang][i]}"${clickAttr}>${def.icon}</span>${lockOverlay}</span>`;
  }).join('');

  // legenda embaixo dos chips — só existe pra medalha já desbloqueada (tier >= 0)
  let equipHtml = '';
  if (tier >= 0) {
    equipHtml = (equippedTier >= 0)
      ? `<div class="muted" style="text-align:left; margin-top:6px;">${T[state.lang].profile_badge_equipped_btn}: ${badgePillHtml(def, equippedTier)}</div>`
      : `<div class="muted" style="text-align:left; margin-top:6px;">${T[state.lang].profile_badge_equip_btn}</div>`;
  }

  return `
    <div class="card badge-card">
      <div class="badge-card-head">
        <span class="badge-chip big" style="background:${color}; position:relative;">${def.icon}${newCount > 0 ? `<span class="notif-dot">${newCount}</span>` : ''}</span>
        <div>
          <div class="name">${def.label[state.lang]}</div>
          <div class="muted" style="text-align:left;">${currentName}</div>
        </div>
      </div>
      ${progressHtml}
      <div class="chip-row">${chips}</div>
      ${equipHtml}
    </div>`;
}

// escolhe qual medalha (já desbloqueada) E QUAL NÍVEL dela aparece ao lado do
// próprio nick no ranking — não precisa ser o nível mais alto desbloqueado
// (ex.: já tem "Imortal" mas prefere mostrar "Lenda"). Grava direto em
// scores/{uid} (permitido pelas regras, ver isValidEquippedBadge/
// isValidEquippedBadgeTier no firestore.rules); é seguro sem Cloud Function
// porque equippedBadgeLabel() sempre reconfere unlockedTier() contra as
// stats reais antes de mostrar qualquer coisa (clicar num nível não
// desbloqueado de verdade nunca chega a acontecer pela UI, mas mesmo que
// alguém forje isso direto no Firestore, não muda o que aparece pra ninguém).
window.setEquippedBadgeTier = async (key, tierIdx) => {
  if (state.offline || !state.currentUser || !state.myData.nick) return;
  // clicar no nível que já está sendo exibido desequipa a categoria inteira
  // (volta a não mostrar nada); clicar em outro nível (da mesma categoria ou
  // de outra) troca na hora, sem precisar desequipar antes
  const alreadyShown = state.myData.equippedBadge === key
    && ((typeof state.myData.equippedBadgeTier === 'number' ? state.myData.equippedBadgeTier : unlockedTier(BADGE_DEFS[key], state.myData)) === tierIdx);
  const nextKey = alreadyShown ? null : key;
  const nextTier = alreadyShown ? null : tierIdx;
  state.myData.equippedBadge = nextKey;
  state.myData.equippedBadgeTier = nextTier;
  // renderProfile() sempre chama resetScroll('profile-screen') no final, que
  // joga a página pro topo — é o certo ao ENTRAR na tela, mas aqui a pessoa já
  // está nela só trocando a medalha, então guarda a posição e restaura logo
  // depois, pra não pular a tela pra cima.
  const scrollY = window.scrollY;
  renderProfile(); // atualiza o chip/legenda na hora, antes mesmo do Firestore confirmar
  window.scrollTo(0, scrollY);
  try {
    await setDoc(doc(db, 'scores', state.currentUser.uid), { equippedBadge: nextKey, equippedBadgeTier: nextTier, updatedAt: serverTimestamp() }, { merge: true });
  } catch (e) {
    // não foi possível salvar agora — a escolha fica só localmente até a próxima tentativa
  }
};

// "ficar invisível" pros amigos — hideOnlineStatus grava direto em
// scores/{uid} (mesmo espírito de setEquippedBadgeTier acima, campo simples
// sem validação de servidor precisando de Cloud Function, ver
// scoreClientFields no firestore.rules). Só afeta a bolinha de online que
// js/dms.js mostra na lista de amigos do balãozinho — enviar/receber
// mensagem continua funcionando normalmente pra quem está invisível.
function updateHideOnlineToggleUI() {
  const btn = $('hide-online-toggle');
  if (!btn) return;
  const visible = !state.myData.hideOnlineStatus;
  btn.classList.toggle('on', visible);
  const icon = btn.querySelector('.tgl-icon');
  if (icon) icon.textContent = visible ? '👁️' : '🙈';
  const label = $('hide-online-label');
  if (label) label.textContent = visible ? T[state.lang].privacy_online_visible : T[state.lang].privacy_online_hidden;
}
window.toggleHideOnlineStatus = async () => {
  if (state.offline || !state.currentUser) return;
  state.myData.hideOnlineStatus = !state.myData.hideOnlineStatus;
  updateHideOnlineToggleUI();
  try {
    await setDoc(doc(db, 'scores', state.currentUser.uid), { hideOnlineStatus: state.myData.hideOnlineStatus, updatedAt: serverTimestamp() }, { merge: true });
  } catch (e) {
    // não foi possível salvar agora — a escolha fica só localmente até a próxima tentativa
  }
};

export async function submitPendingScore() {
  if (!state.pendingScore || !state.currentUser || !state.myData.nick) return;
  const { mode: m, score: s, xp: pendingXp = 0 } = state.pendingScore;
  state.pendingScore = null;

  // pontuação feita antes de ter conta — não existe sessão de servidor pra validar
  // o tempo (foi jogada state.offline), mas o servidor ainda valida o valor e só ele grava
  try {
    const res = await callClaimPendingScore({ mode: m, score: s, xpGain: pendingXp });
    const d = res.data || {};
    if (d.xpEarned) state.myData.xp = (state.myData.xp || 0) + d.xpEarned;
    if (d.isNewRecord) {
      state.myData[m] = s;
      state.myData[m + 'At'] = Timestamp.now(); // mesmo motivo do persistGameResult() acima
      if (d.total !== undefined) { state.myData.total = d.total; state.myData.totalAt = Timestamp.now(); }
    }
  } catch {}
}
