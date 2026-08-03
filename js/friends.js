import { doc, getDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db, callable } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { show, resetScroll } from './nav.js';
import { lvChip } from './levels.js';
import { openProfileFromRanking, profileSectionLabel } from './profile-public.js';
import { fetchAllScores, rowData } from './ranking-cache.js';

// amigos — igual ao resto: nenhuma escrita cruzada (pedido/aceite/remoção)
// acontece direto do navegador, sempre via function (ver functions/index.js)
const callSendFriendRequest = callable('sendFriendRequest');
const callRespondFriendRequest = callable('respondFriendRequest');
const callCancelFriendRequest = callable('cancelFriendRequest');
const callRemoveFriend = callable('removeFriend');

// Espelhado em dois documentos por conta (ver functions/index.js):
//   friends/{uid}        -> { list: { [amigoUid]: { nick, since } } }
//   friendRequests/{uid} -> { incoming: {...}, outgoing: {...} }
// Cache local curto só pra não reler o mesmo documento várias vezes seguidas
// (abrir vários perfis, checar o menu etc.) — qualquer ação de amizade
// invalida o cache na hora, então nunca fica visivelmente desatualizado.
let myFriendsCache = null, myFriendsCacheAt = 0;
let myFriendReqCache = null, myFriendReqCacheAt = 0;
const FRIENDS_CACHE_MS = 20 * 1000;

export async function fetchMyFriends(force) {
  if (state.offline || !state.currentUser) return {};
  if (!force && myFriendsCache && (Date.now() - myFriendsCacheAt) < FRIENDS_CACHE_MS) return myFriendsCache;
  const snap = await getDoc(doc(db, 'friends', state.currentUser.uid));
  myFriendsCache = (snap.exists() && snap.data().list) || {};
  myFriendsCacheAt = Date.now();
  return myFriendsCache;
}
// exposta em window pra js/ranking.js (filtro de ranking de amigos) poder
// chamar sem esperar amigos ganhar seu próprio módulo (fase futura)
window.fetchMyFriends = fetchMyFriends;

export async function fetchMyFriendRequests(force) {
  if (state.offline || !state.currentUser) return { incoming: {}, outgoing: {} };
  if (!force && myFriendReqCache && (Date.now() - myFriendReqCacheAt) < FRIENDS_CACHE_MS) return myFriendReqCache;
  const snap = await getDoc(doc(db, 'friendRequests', state.currentUser.uid));
  const data = snap.exists() ? snap.data() : {};
  myFriendReqCache = { incoming: data.incoming || {}, outgoing: data.outgoing || {} };
  myFriendReqCacheAt = Date.now();
  return myFriendReqCache;
}

function invalidateFriendsCache() {
  myFriendsCache = null;
  myFriendReqCache = null;
}

// bolinha vermelha de pedido de amizade no menu — antes só era recalculada
// quando showMenu() rodava (ver js/menu.js), então um pedido chegando
// enquanto a pessoa já estava com o menu aberto (ou em outra tela) só
// aparecia depois de sair e voltar pro menu (ou dar refresh). Este listener
// ouve friendRequests/{uid} em tempo real e atualiza a bolinha na hora,
// mesmo padrão de ensureDmSummaryListener em js/dms.js.
let friendReqUnsub = null;
export function ensureFriendRequestsListener() {
  if (friendReqUnsub || state.offline || !state.currentUser) return;
  const myUid = state.currentUser.uid;
  friendReqUnsub = onSnapshot(doc(db, 'friendRequests', myUid), snap => {
    const data = snap.exists() ? snap.data() : {};
    myFriendReqCache = { incoming: data.incoming || {}, outgoing: data.outgoing || {} };
    myFriendReqCacheAt = Date.now();
    updateFriendRequestsBadge();
  }, () => {});
}
window.ensureFriendRequestsListener = ensureFriendRequestsListener;

function updateFriendRequestsBadge() {
  const badge = $('menu-quick-friends-badge');
  if (!badge) return;
  const n = Object.keys((myFriendReqCache && myFriendReqCache.incoming) || {}).length;
  badge.textContent = n;
  badge.style.display = n > 0 ? '' : 'none';
}

// chamado no logout (ver doLogout em js/auth.js, mesmo padrão de
// window.stopDmListeners/window.stopGuildListeners) — sem isso, trocar de
// conta na mesma aba deixaria o listener da conta anterior vazando pedidos
// de amizade dela pra dentro da sessão da conta nova
window.stopFriendRequestsListener = () => {
  if (friendReqUnsub) { friendReqUnsub(); friendReqUnsub = null; }
  myFriendReqCache = null;
};

async function getFriendRelation(theirUid) {
  const [friends, reqs] = await Promise.all([fetchMyFriends(), fetchMyFriendRequests()]);
  if (friends[theirUid]) return 'friends';
  if (reqs.outgoing[theirUid]) return 'sent';
  if (reqs.incoming[theirUid]) return 'received';
  return 'none';
}

// abre o perfil de alguém a partir só do uid (usado na tela de amigos, onde
// não temos as stats completas em mãos) — reaproveita o cache do ranking
// geral quando dá, senão busca o documento avulso. backTarget é pra onde o
// botão "voltar" do perfil leva (padrão tela de amigos; js/guilds.js passa
// 'guild-screen' pros nicks da lista de membros/solicitações)
export async function openProfileByUid(uid, fallbackNick, backTarget = 'friends-screen') {
  const all = await fetchAllScores();
  const found = all.find(r => r.uid === uid);
  if (found) {
    const data = rowData(found);
    openProfileFromRanking({ uid, nick: data.nick, stats: data }, backTarget);
    return;
  }
  try {
    const snap = await getDoc(doc(db, 'scores', uid));
    const data = snap.exists() ? snap.data() : {};
    openProfileFromRanking({ uid, nick: data.nick || fallbackNick, stats: data }, backTarget);
  } catch {
    openProfileFromRanking({ uid, nick: fallbackNick, stats: {} }, backTarget);
  }
}

export function showFriendActionError() {
  [$('profile-friend-status'), $('friends-status')].forEach(el => {
    if (!el) return;
    el.textContent = T[state.lang].friend_action_error;
    setTimeout(() => { if (el.textContent === T[state.lang].friend_action_error) el.textContent = ''; }, 3000);
  });
}

// botão de ação no perfil de outra pessoa (adicionar / já é amigo / pedido
// enviado / pedido recebido) — atualizado sempre que o perfil abre e depois
// de qualquer ação de amizade feita nessa tela
export async function renderProfileFriendAction(theirUid, theirNick) {
  const box = $('profile-friend-action');
  if (!box) return;
  box.dataset.uid = theirUid;
  if (state.offline || !state.currentUser) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.innerHTML = `<span class="muted">${T[state.lang].loading_text}</span>`;
  const rel = await getFriendRelation(theirUid);
  if (box.dataset.uid !== theirUid) return; // perfil trocou enquanto isso carregava
  box.innerHTML = '';
  box.appendChild(friendActionNode(rel, theirUid, theirNick));
}

function friendActionNode(rel, theirUid, theirNick) {
  if (rel === 'friends') {
    const wrap = document.createElement('div');
    wrap.className = 'btn-row';
    wrap.style.width = '100%';
    // "iniciar chat" — abre o balãozinho de DM (js/dms.js) já direto na
    // conversa com essa pessoa; exposta via window porque o perfil ainda
    // não conhece o domínio de DMs, mesmo padrão de window.openGuildFromTag
    const chatBtn = document.createElement('button');
    chatBtn.style.cssText = 'flex:1; padding:9px 12px; font-size:0.85rem;';
    chatBtn.textContent = T[state.lang].dm_chat_start_btn;
    chatBtn.onclick = () => window.openDmChatWithFriend(theirUid, theirNick || '');
    wrap.appendChild(chatBtn);
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = T[state.lang].btn_remove_friend_profile;
    btn.style.cssText = 'flex:1; padding:9px 12px; font-size:0.85rem;';
    btn.onclick = () => uiRemoveFriend(theirUid);
    wrap.appendChild(btn);
    return wrap;
  }
  if (rel === 'sent') {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:6px;';
    const label = document.createElement('div');
    label.className = 'muted';
    label.textContent = T[state.lang].friend_request_sent_label;
    wrap.appendChild(label);
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = T[state.lang].btn_cancel_request;
    btn.onclick = () => uiCancelFriendRequest(theirUid);
    wrap.appendChild(btn);
    return wrap;
  }
  if (rel === 'received') {
    const wrap = document.createElement('div');
    wrap.className = 'btn-row';
    wrap.style.width = '100%';
    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = T[state.lang].btn_accept;
    acceptBtn.style.cssText = 'flex:1;';
    acceptBtn.onclick = () => uiRespondFriendRequest(theirUid, true);
    wrap.appendChild(acceptBtn);
    const declineBtn = document.createElement('button');
    declineBtn.className = 'secondary';
    declineBtn.textContent = T[state.lang].btn_decline;
    declineBtn.style.cssText = 'flex:1;';
    declineBtn.onclick = () => uiRespondFriendRequest(theirUid, false);
    wrap.appendChild(declineBtn);
    return wrap;
  }
  const btn = document.createElement('button');
  btn.textContent = T[state.lang].btn_add_friend;
  btn.onclick = () => uiSendFriendRequest(theirUid);
  return btn;
}

// linha de amigo/pedido montada via DOM (nunca via innerHTML com o nick
// interpolado — nick é livre em qualquer caractere não-espaço, então precisa
// ir sempre por textContent, igual já é feito no resto do ranking)
function friendRow(uid, nick, xp, isAdmin, guildTag, guildId) {
  const row = document.createElement('div');
  row.className = 'card';
  row.style.cssText = 'flex-direction:row; align-items:center; justify-content:space-between; padding:12px 16px; gap:10px; flex-wrap:wrap;';

  const left = document.createElement('span');
  left.style.cssText = 'display:flex; align-items:center; gap:8px;';
  left.insertAdjacentHTML('beforeend', lvChip(xp || 0)); // conteúdo fixo (número/cor), seguro via innerHTML
  // sigla do clã (se tiver) — clicável, mesmo padrão de buildRankRowNick em
  // js/ranking-cache.js (window.openGuildFromTag, ver js/guilds.js)
  if (guildTag && guildId) {
    const tagSpan = document.createElement('span');
    tagSpan.textContent = `[${guildTag}]`;
    tagSpan.className = 'guild-tag-link';
    tagSpan.onclick = () => window.openGuildFromTag(guildId, 'friends-screen');
    left.appendChild(tagSpan);
  }
  const nickSpan = document.createElement('span');
  nickSpan.textContent = nick;
  nickSpan.className = 'nick-click';
  nickSpan.onclick = () => openProfileByUid(uid, nick);
  left.appendChild(nickSpan);
  row.appendChild(left);

  const actions = document.createElement('span');
  actions.style.cssText = 'display:flex; gap:5px;';

  const challengeBtn = document.createElement('button');
  challengeBtn.textContent = T[state.lang].btn_challenge;
  challengeBtn.style.cssText = 'padding:4px 8px; font-size:0.7rem;';
  // openChallengeModeModal é do domínio de PvP, ainda não modularizado (fase
  // futura) — chamado via window de propósito, ver comentário equivalente
  // em js/tutorial.js sobre esse mesmo padrão
  challengeBtn.onclick = () => window.openChallengeModeModal(uid, nick, xp, isAdmin);
  actions.appendChild(challengeBtn);

  const btn = document.createElement('button');
  btn.className = 'secondary';
  btn.textContent = T[state.lang].btn_remove_friend;
  btn.style.cssText = 'padding:4px 8px; font-size:0.7rem;';
  btn.onclick = () => uiRemoveFriend(uid);
  actions.appendChild(btn);

  row.appendChild(actions);

  return row;
}

function friendRequestRow(uid, nick, incoming) {
  const row = document.createElement('div');
  row.className = 'card';
  row.style.cssText = 'flex-direction:row; align-items:center; justify-content:space-between; padding:12px 16px; gap:10px; flex-wrap:wrap;';

  const nickSpan = document.createElement('span');
  nickSpan.textContent = nick;
  nickSpan.className = 'nick-click';
  nickSpan.onclick = () => openProfileByUid(uid, nick);
  row.appendChild(nickSpan);

  const actions = document.createElement('span');
  actions.style.cssText = 'display:flex; gap:5px;';

  if (incoming) {
    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = T[state.lang].btn_accept;
    acceptBtn.style.cssText = 'padding:4px 8px; font-size:0.7rem;';
    acceptBtn.onclick = () => uiRespondFriendRequest(uid, true);
    actions.appendChild(acceptBtn);

    const declineBtn = document.createElement('button');
    declineBtn.className = 'secondary';
    declineBtn.textContent = T[state.lang].btn_decline;
    declineBtn.style.cssText = 'padding:4px 8px; font-size:0.7rem;';
    declineBtn.onclick = () => uiRespondFriendRequest(uid, false);
    actions.appendChild(declineBtn);
  } else {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'secondary';
    cancelBtn.textContent = T[state.lang].btn_cancel_request;
    cancelBtn.style.cssText = 'padding:4px 8px; font-size:0.7rem;';
    cancelBtn.onclick = () => uiCancelFriendRequest(uid);
    actions.appendChild(cancelBtn);
  }

  row.appendChild(actions);
  return row;
}

window.showFriends = () => {
  show('friends-screen');
  renderFriendsScreen();
};

async function renderFriendsScreen(force) {
  const body = $('friends-body');
  $('friends-status').textContent = '';

  if (state.offline || !state.currentUser) {
    $('friends-refcode-row').style.display = 'none';
    body.innerHTML = `
      <div class="card" style="text-align:center;">
        <p>${T[state.lang].profile_offline_msg1}</p>
        <button onclick="goSignup()">${T[state.lang].btn_create_account}</button>
      </div>`;
    resetScroll('friends-screen');
    return;
  }

  const showOwnRefCode = !!state.myData.refCode;
  $('friends-refcode-row').style.display = showOwnRefCode ? 'flex' : 'none';
  if (showOwnRefCode) $('friends-refcode-value').textContent = state.myData.refCode;

  body.innerHTML = `<div class="muted" style="text-align:center;">${T[state.lang].loading_text}</div>`;
  const [friends, reqs] = await Promise.all([fetchMyFriends(force), fetchMyFriendRequests(force)]);
  body.innerHTML = '';

  const incomingEntries = Object.entries(reqs.incoming || {});
  if (incomingEntries.length) {
    body.insertAdjacentHTML('beforeend', profileSectionLabel(T[state.lang].friends_incoming_title));
    incomingEntries.forEach(([uid, data]) => body.appendChild(friendRequestRow(uid, data.nick || '', true)));
  }

  body.insertAdjacentHTML('beforeend', profileSectionLabel(T[state.lang].friends_list_title));
  const friendEntries = Object.entries(friends);
  if (!friendEntries.length) {
    body.insertAdjacentHTML('beforeend', `<div class="muted" style="text-align:center;">${T[state.lang].friends_empty}</div>`);
  } else {
    // nível (e admin, pra checagem de modo desbloqueado ao desafiar) de cada
    // amigo vem do cache geral de pontuações (mesmo já usado pelo ranking),
    // pra não precisar de uma leitura extra por amigo
    const all = await fetchAllScores();
    const xpByUid = {}, adminByUid = {}, guildByUid = {};
    all.forEach(r => { const d = rowData(r); xpByUid[r.uid] = d.xp || 0; adminByUid[r.uid] = d.admin === true; guildByUid[r.uid] = { tag: d.guildTag || null, id: d.guildId || null }; });
    friendEntries.forEach(([uid, data]) => {
      const gu = guildByUid[uid] || {};
      body.appendChild(friendRow(uid, data.nick || '', xpByUid[uid], adminByUid[uid], gu.tag, gu.id));
    });
  }

  // pedidos ENVIADOS (aguardando resposta do outro lado) ficam por último —
  // são o caso menos comum de olhar, então não empurram pra baixo a lista de
  // amigos de verdade nem os pedidos RECEBIDOS (que pedem uma ação da pessoa)
  const outgoingEntries = Object.entries(reqs.outgoing || {});
  if (outgoingEntries.length) {
    body.insertAdjacentHTML('beforeend', profileSectionLabel(T[state.lang].friends_outgoing_title));
    outgoingEntries.forEach(([uid, data]) => body.appendChild(friendRequestRow(uid, data.nick || '', false)));
  }
  resetScroll('friends-screen');
}

// depois de qualquer ação de amizade, atualiza a tela de amigos (se estiver
// aberta) e o botão de ação no perfil da pessoa envolvida (se estiver aberto)
async function refreshFriendUiFor(uid) {
  if ($('friends-screen').classList.contains('active')) {
    await renderFriendsScreen(true);
  }
  const box = $('profile-friend-action');
  if ($('profile-screen').classList.contains('active') && box && box.dataset.uid === uid) {
    await renderProfileFriendAction(uid);
  }
}

window.uiSendFriendRequest = async (toUid) => {
  try {
    await callSendFriendRequest({ toUid });
  } catch {
    showFriendActionError();
  }
  invalidateFriendsCache();
  await refreshFriendUiFor(toUid);
};

window.uiCancelFriendRequest = async (toUid) => {
  try {
    await callCancelFriendRequest({ toUid });
  } catch {
    showFriendActionError();
  }
  invalidateFriendsCache();
  await refreshFriendUiFor(toUid);
};

window.uiRespondFriendRequest = async (fromUid, accept) => {
  try {
    await callRespondFriendRequest({ fromUid, accept });
  } catch {
    showFriendActionError();
  }
  invalidateFriendsCache();
  await refreshFriendUiFor(fromUid);
};

window.uiRemoveFriend = async (friendUid) => {
  try {
    await callRemoveFriend({ friendUid });
  } catch {
    showFriendActionError();
  }
  invalidateFriendsCache();
  await refreshFriendUiFor(friendUid);
};
