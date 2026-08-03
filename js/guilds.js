import {
  doc, getDoc, collection, query, orderBy, limit, onSnapshot, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db, callable } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { show, pushScreenAndShow, popScreenBack, resetScroll } from './nav.js';
import { T } from './i18n.js';
import { myXp, levelFromXp, GUILD_CREATE_MIN_LEVEL, GUILD_JOIN_MIN_LEVEL, GUILD_MAX_MEMBERS, guildLevelFromXp, pigmentIconSvg } from './levels.js';

// clãs (Espectro) — igual ao resto: nenhuma escrita de verdade (criar,
// entrar, expulsar, transferir liderança, desfazer, mandar mensagem) sai
// direto do navegador, sempre via function (ver functions/index.js). O
// cliente só faz leitura direta (pública) de guilds/{id} e do chat, e usa
// listeners ao vivo enquanto a tela de um clã está aberta.
const callCreateGuild = callable('createGuild');
const callRequestJoinGuild = callable('requestJoinGuild');
const callCancelGuildJoinRequest = callable('cancelGuildJoinRequest');
const callRespondGuildJoinRequest = callable('respondGuildJoinRequest');
const callLeaveGuild = callable('leaveGuild');
const callKickGuildMember = callable('kickGuildMember');
const callInitiateGuildLeaderTransfer = callable('initiateGuildLeaderTransfer');
const callRespondGuildLeaderTransfer = callable('respondGuildLeaderTransfer');
const callDisbandGuild = callable('disbandGuild');
const callSendGuildMessage = callable('sendGuildMessage');

/* ================== estado local da tela do clã aberto ================== */
let currentGuildId = null;
let currentGuildData = null;
let guildUnsub = null;
let joinReqUnsub = null;
let chatUnsub = null;
let guildTab = 'members'; // 'members' | 'chat'

function stopGuildListeners() {
  if (guildUnsub) { guildUnsub(); guildUnsub = null; }
  if (joinReqUnsub) { joinReqUnsub(); joinReqUnsub = null; }
  if (chatUnsub) { chatUnsub(); chatUnsub = null; }
  currentGuildId = null;
  currentGuildData = null;
}
// chamado no logout (ver doLogout em js/auth.js) — nenhum listener de clã
// deve sobreviver a uma troca de conta
window.stopGuildListeners = stopGuildListeners;

/* ================== atalho do menu ================== */
// "CLÃS" no menu vai direto pro próprio clã se a pessoa já estiver em um;
// senão, abre a listagem geral pra procurar/criar um
window.showGuildHome = () => {
  if (state.myData.guildId) {
    pushScreenAndShow('guild-screen', 'menu-screen');
    openGuildScreen(state.myData.guildId);
  } else {
    window.showGuildList();
  }
};

/* ================== listagem de clãs ================== */
let guildListCache = null;

window.showGuildList = () => {
  stopGuildListeners();
  show('guild-list-screen');
  renderGuildList();
};

async function fetchAllGuilds(force) {
  if (!force && guildListCache) return guildListCache;
  const snap = await getDocs(collection(db, 'guilds'));
  // clã criado por conta admin não aparece na listagem/ranking pra quem não
  // é admin (mesmo filtro dos rankings de jogador — ver fetchScoresLive em
  // js/ranking-cache.js); window.IS_TESTE (só true em teste.html) é a mesma
  // exceção de sempre pra dar pra testar
  guildListCache = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(g => !g.adminGuild || window.IS_TESTE);
  return guildListCache;
}

async function renderGuildList() {
  const body = $('guild-list-body');
  const createBtn = $('guild-create-btn');
  const createHint = $('guild-create-hint');

  if (state.offline || !state.currentUser) {
    body.innerHTML = `
      <div class="card" style="text-align:center;">
        <p>${T[state.lang].profile_offline_msg1}</p>
        <button onclick="goSignup()">${T[state.lang].btn_create_account}</button>
      </div>`;
    createBtn.style.display = 'none';
    createHint.style.display = 'none';
    resetScroll('guild-list-screen');
    return;
  }

  const myLevel = levelFromXp(myXp());
  const canCreate = (myLevel >= GUILD_CREATE_MIN_LEVEL || state.myData.admin === true) && !state.myData.guildId;
  createBtn.style.display = canCreate ? '' : 'none';
  if (canCreate) createBtn.innerHTML = `${T[state.lang].guild_btn_create} <b>500</b> ${pigmentIconSvg(16)}`;
  createHint.style.display = (!state.myData.guildId && !canCreate) ? '' : 'none';
  if (createHint.style.display !== 'none') {
    createHint.textContent = T[state.lang].guild_create_level_hint(GUILD_CREATE_MIN_LEVEL);
  }

  body.innerHTML = `<div class="muted" style="text-align:center;">${T[state.lang].loading_text}</div>`;
  try {
    const guilds = await fetchAllGuilds(true);
    guilds.sort((a, b) => (b.level || 1) - (a.level || 1) || (b.xp || 0) - (a.xp || 0) || a.name.localeCompare(b.name));
    body.innerHTML = '';
    if (!guilds.length) {
      body.insertAdjacentHTML('beforeend', `<div class="muted" style="text-align:center;">${T[state.lang].guild_list_empty}</div>`);
    }
    guilds.forEach(g => body.appendChild(guildListRow(g)));
  } catch (e) {
    body.innerHTML = `<div class="muted" style="text-align:center;">${T[state.lang].ranking_error}</div>`;
  }
  resetScroll('guild-list-screen');
}

function guildListRow(g) {
  const row = document.createElement('div');
  row.className = 'card';
  row.style.cssText = 'flex-direction:row; align-items:center; justify-content:space-between; padding:12px 16px; gap:10px; flex-wrap:wrap; cursor:pointer;';

  const left = document.createElement('span');
  left.style.cssText = 'display:flex; align-items:center; gap:8px;';
  const tagSpan = document.createElement('span');
  tagSpan.textContent = `[${g.tag}]`;
  tagSpan.style.cssText = 'font-family:\'Orbitron\',sans-serif; font-weight:800; color:var(--neon-purple); text-shadow:0 0 6px rgba(177,77,255,0.5);';
  left.appendChild(tagSpan);
  const nameSpan = document.createElement('span');
  nameSpan.textContent = g.name;
  nameSpan.style.fontWeight = '700';
  left.appendChild(nameSpan);
  row.appendChild(left);

  const right = document.createElement('span');
  right.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:0.85rem;';
  const count = g.memberCount || 0;
  const full = count >= GUILD_MAX_MEMBERS;
  const countSpan = document.createElement('span');
  countSpan.className = 'muted';
  countSpan.textContent = `👥 ${count}/${GUILD_MAX_MEMBERS}`;
  right.appendChild(countSpan);
  const vacSpan = document.createElement('span');
  vacSpan.textContent = full ? T[state.lang].guild_full : T[state.lang].guild_has_vacancy;
  vacSpan.style.cssText = full ? 'color:var(--neon-red);' : 'color:var(--neon-green);';
  right.appendChild(vacSpan);
  row.appendChild(right);

  row.onclick = () => {
    pushScreenAndShow('guild-screen', 'guild-list-screen');
    openGuildScreen(g.id);
  };
  return row;
}

/* ================== criar clã ================== */
window.openCreateGuildModal = () => {
  $('create-guild-error').textContent = '';
  $('create-guild-name').value = '';
  $('create-guild-tag').value = '';
  $('create-guild-modal').style.display = 'flex';
};
window.closeCreateGuildModal = () => {
  $('create-guild-modal').style.display = 'none';
};
window.submitCreateGuild = async () => {
  const errEl = $('create-guild-error');
  errEl.textContent = '';
  const name = $('create-guild-name').value.trim();
  const tag = $('create-guild-tag').value.trim().toUpperCase();
  if (name.length < 3 || name.length > 24) { errEl.textContent = T[state.lang].guild_err_name_length; return; }
  if (!/^[A-Za-z]{2,3}$/.test(tag)) { errEl.textContent = T[state.lang].guild_err_tag_format; return; }

  try {
    const res = await callCreateGuild({ name, tag });
    const guildId = res.data && res.data.guildId;
    state.myData.guildId = guildId;
    state.myData.guildTag = tag;
    state.myData.pigmentos = (state.myData.pigmentos || 0) - 500;
    closeCreateGuildModal();
    guildListCache = null;
    pushScreenAndShow('guild-screen', 'guild-list-screen');
    openGuildScreen(guildId);
  } catch (e) {
    errEl.textContent = (e && e.message) || T[state.lang].guild_err_generic;
  }
};

// aberta a partir da sigla [TAG] clicável ao lado de qualquer nick (ver
// buildRankRowNick em js/ranking-cache.js, friendRow em js/friends.js etc.)
// — chamada via window de propósito, mesmo padrão do uiChallengeFriend
window.openGuildFromTag = (guildId, backScreenId) => {
  pushScreenAndShow('guild-screen', backScreenId || 'menu-screen');
  openGuildScreen(guildId);
};

/* ================== tela do clã ================== */
function openGuildScreen(guildId) {
  stopGuildListeners();
  currentGuildId = guildId;
  guildTab = 'members';
  show('guild-screen');
  $('guild-body').innerHTML = `<div class="muted" style="text-align:center;">${T[state.lang].loading_text}</div>`;

  guildUnsub = onSnapshot(doc(db, 'guilds', guildId), snap => {
    if (!snap.exists()) {
      currentGuildData = null;
      renderGuildScreen();
      return;
    }
    currentGuildData = { id: snap.id, ...snap.data() };
    const myUid = state.currentUser && state.currentUser.uid;
    // mantém state.myData.guildId/guildTag em dia mesmo sem recarregar a
    // página — cobre o caso de ver a própria solicitação sendo aceita (ou
    // ser expulsa) enquanto esta tela está aberta, sem precisar de outra
    // leitura (já temos os dados do clã aqui)
    const stillMember = !!(myUid && currentGuildData.members && currentGuildData.members[myUid]);
    if (stillMember && state.myData.guildId !== guildId) {
      state.myData.guildId = guildId;
      state.myData.guildTag = currentGuildData.tag;
      state.myData.pendingGuildRequest = null;
    } else if (!stillMember && state.myData.guildId === guildId) {
      state.myData.guildId = null;
      state.myData.guildTag = null;
    }
    renderGuildScreen();
    // se eu sou a líder, mantém o listener de solicitações em dia; se deixei
    // de ser líder (ou saí), desliga
    if (myUid && currentGuildData.leaderUid === myUid) {
      ensureJoinRequestsListener(guildId);
    } else if (joinReqUnsub) {
      joinReqUnsub(); joinReqUnsub = null;
    }
    // se deixei de ser membro (expulsa/saí em outra aba), desliga o chat
    if (!stillMember && chatUnsub) { chatUnsub(); chatUnsub = null; }
  }, () => {});
}

function ensureJoinRequestsListener(guildId) {
  if (joinReqUnsub) return;
  joinReqUnsub = onSnapshot(doc(db, 'guildJoinRequests', guildId), snap => {
    currentJoinRequests = (snap.exists() && snap.data().incoming) || {};
    renderGuildScreen();
  }, () => {});
}
let currentJoinRequests = {};

window.guildBack = () => {
  stopGuildListeners();
  popScreenBack();
};

function renderGuildScreen() {
  const body = $('guild-body');
  const header = $('guild-header');
  body.innerHTML = '';
  header.innerHTML = '';

  if (!currentGuildData) {
    header.textContent = '';
    body.innerHTML = `<div class="muted" style="text-align:center;">${T[state.lang].guild_not_found}</div>`;
    resetScroll('guild-screen');
    return;
  }

  const g = currentGuildData;
  const myUid = state.currentUser && state.currentUser.uid;
  const isMember = !!(myUid && g.members && g.members[myUid]);
  const isLeader = myUid && g.leaderUid === myUid;
  const level = guildLevelFromXp(g.xp || 0);

  header.innerHTML = `
    <span style="font-family:'Orbitron',sans-serif; font-weight:800; color:var(--neon-purple); text-shadow:0 0 6px rgba(177,77,255,0.5);">[${g.tag}]</span>
    <span style="font-weight:700; font-size:1.2rem;"></span>
    <span class="lv-chip" style="margin-left:6px; color:var(--neon-purple); border-color:var(--neon-purple); text-shadow:0 0 6px rgba(177,77,255,0.5);">${T[state.lang].guild_level_chip(level)}</span>`;
  header.children[1].textContent = g.name; // nome livre — sempre via textContent

  // aviso de transferência de liderança pendente pra mim
  if (myUid && g.pendingTransferToUid === myUid) {
    body.insertAdjacentHTML('beforeend', `
      <div class="card" style="text-align:center; border-color:var(--neon-yellow);">
        <p>${T[state.lang].guild_transfer_offer(g.name)}</p>
        <div class="btn-row" style="width:100%;">
          <button style="flex:1;" onclick="respondGuildTransfer(true)">${T[state.lang].btn_accept}</button>
          <button class="secondary" style="flex:1;" onclick="respondGuildTransfer(false)">${T[state.lang].btn_decline}</button>
        </div>
      </div>`);
  }

  // não sou membro: pedir entrada / cancelar pedido / avisos de bloqueio
  if (!isMember) {
    body.appendChild(nonMemberActionCard(g, myUid));
  }

  // abas (só faz sentido pra quem é membro ver o chat)
  if (isMember) {
    const tabs = document.createElement('div');
    tabs.className = 'scope-tabs';
    tabs.innerHTML = `
      <button class="scope-tab ${guildTab === 'members' ? 'active' : ''}" onclick="setGuildTab('members')">${T[state.lang].guild_tab_members}</button>
      <button class="scope-tab ${guildTab === 'chat' ? 'active' : ''}" onclick="setGuildTab('chat')">${T[state.lang].guild_tab_chat}</button>`;
    body.appendChild(tabs);
  }

  if (!isMember || guildTab === 'members') {
    body.appendChild(membersSection(g, myUid, isLeader));
    if (isLeader) body.appendChild(joinRequestsSection());
    if (isLeader) body.appendChild(leaderToolsSection(g));
    else if (isMember) body.appendChild(leaveSection());
  } else {
    body.appendChild(chatSection(g, myUid));
    ensureChatListener(g.id);
  }

  resetScroll('guild-screen');
}

window.setGuildTab = (tab) => { guildTab = tab; renderGuildScreen(); };

function nonMemberActionCard(g, myUid) {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  wrap.style.textAlign = 'center';

  if (state.offline || !state.currentUser) {
    wrap.innerHTML = `<p>${T[state.lang].profile_offline_msg1}</p><button onclick="goSignup()">${T[state.lang].btn_create_account}</button>`;
    return wrap;
  }
  const pending = state.myData.pendingGuildRequest;
  if (pending && pending.guildId === g.id) {
    wrap.innerHTML = `<p class="muted">${T[state.lang].guild_request_pending}</p>`;
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = T[state.lang].btn_cancel_request;
    btn.onclick = uiCancelGuildRequest;
    wrap.appendChild(btn);
    return wrap;
  }
  if (state.myData.guildId) {
    wrap.innerHTML = `<p class="muted">${T[state.lang].guild_already_in_another}</p>`;
    return wrap;
  }
  if (pending) {
    wrap.innerHTML = `<p class="muted">${T[state.lang].guild_request_pending_other}</p>`;
    return wrap;
  }
  const myLevel = levelFromXp(myXp());
  if (myLevel < GUILD_JOIN_MIN_LEVEL && state.myData.admin !== true) {
    wrap.innerHTML = `<p class="muted">${T[state.lang].guild_join_level_hint(GUILD_JOIN_MIN_LEVEL)}</p>`;
    return wrap;
  }
  if ((g.memberCount || 0) >= GUILD_MAX_MEMBERS) {
    wrap.innerHTML = `<p class="muted">${T[state.lang].guild_full}</p>`;
    return wrap;
  }
  const btn = document.createElement('button');
  btn.textContent = T[state.lang].guild_btn_request_join;
  btn.onclick = () => uiRequestJoinGuild(g.id);
  wrap.appendChild(btn);
  return wrap;
}

function membersSection(g, myUid, isLeader) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%; display:flex; flex-direction:column; gap:8px;';
  const entries = Object.entries(g.members || {}).sort((a, b) => (a[1].joinedAt && b[1].joinedAt) ? a[1].joinedAt.toMillis() - b[1].joinedAt.toMillis() : 0);
  entries.forEach(([uid, data]) => wrap.appendChild(memberRow(g, uid, data, myUid, isLeader)));
  return wrap;
}

function memberRow(g, uid, data, myUid, isLeader) {
  const row = document.createElement('div');
  row.className = 'card';
  row.style.cssText = 'flex-direction:row; align-items:center; justify-content:space-between; padding:10px 14px; gap:8px; flex-wrap:wrap;';

  const left = document.createElement('span');
  left.style.cssText = 'display:flex; align-items:center; gap:6px;';
  if (uid === g.leaderUid) {
    const crown = document.createElement('span');
    crown.textContent = '👑';
    crown.title = T[state.lang].guild_leader_label;
    left.appendChild(crown);
  }
  const nickSpan = document.createElement('span');
  nickSpan.textContent = data.nick || '';
  left.appendChild(nickSpan);
  row.appendChild(left);

  if (isLeader && uid !== myUid) {
    const actions = document.createElement('span');
    actions.style.cssText = 'display:flex; gap:5px;';
    const transferBtn = document.createElement('button');
    transferBtn.className = 'secondary';
    transferBtn.style.cssText = 'padding:4px 8px; font-size:0.7rem;';
    transferBtn.textContent = T[state.lang].guild_btn_make_leader;
    transferBtn.onclick = () => uiInitiateGuildTransfer(uid, data.nick || '');
    actions.appendChild(transferBtn);
    const kickBtn = document.createElement('button');
    kickBtn.className = 'secondary';
    kickBtn.style.cssText = 'padding:4px 8px; font-size:0.7rem; color:var(--neon-red);';
    kickBtn.textContent = T[state.lang].guild_btn_kick;
    kickBtn.onclick = () => uiKickGuildMember(uid, data.nick || '');
    actions.appendChild(kickBtn);
    row.appendChild(actions);
  }
  return row;
}

function joinRequestsSection() {
  const entries = Object.entries(currentJoinRequests || {});
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%; display:flex; flex-direction:column; gap:8px; margin-top:6px;';
  if (!entries.length) return wrap;
  wrap.insertAdjacentHTML('beforeend', `<div class="muted" style="text-align:center; margin-top:6px;">${T[state.lang].guild_requests_title}</div>`);
  entries.forEach(([uid, data]) => {
    const row = document.createElement('div');
    row.className = 'card';
    row.style.cssText = 'flex-direction:row; align-items:center; justify-content:space-between; padding:10px 14px; gap:8px; flex-wrap:wrap;';
    const nickSpan = document.createElement('span');
    nickSpan.textContent = data.nick || '';
    row.appendChild(nickSpan);
    const actions = document.createElement('span');
    actions.style.cssText = 'display:flex; gap:5px;';
    const acceptBtn = document.createElement('button');
    acceptBtn.style.cssText = 'padding:4px 8px; font-size:0.7rem;';
    acceptBtn.textContent = T[state.lang].btn_accept;
    acceptBtn.onclick = () => uiRespondGuildRequest(uid, true);
    actions.appendChild(acceptBtn);
    const declineBtn = document.createElement('button');
    declineBtn.className = 'secondary';
    declineBtn.style.cssText = 'padding:4px 8px; font-size:0.7rem;';
    declineBtn.textContent = T[state.lang].btn_decline;
    declineBtn.onclick = () => uiRespondGuildRequest(uid, false);
    actions.appendChild(declineBtn);
    row.appendChild(actions);
    wrap.appendChild(row);
  });
  return wrap;
}

function leaderToolsSection() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%; text-align:center; margin-top:10px;';
  const btn = document.createElement('button');
  btn.className = 'secondary';
  btn.style.color = 'var(--neon-red)';
  btn.textContent = T[state.lang].guild_btn_disband;
  btn.onclick = uiDisbandGuild;
  wrap.appendChild(btn);
  return wrap;
}

function leaveSection() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%; text-align:center; margin-top:10px;';
  const btn = document.createElement('button');
  btn.className = 'secondary';
  btn.textContent = T[state.lang].guild_btn_leave;
  btn.onclick = uiLeaveGuild;
  wrap.appendChild(btn);
  return wrap;
}

/* ================== chat do clã ================== */
let chatMessages = [];
function ensureChatListener(guildId) {
  if (chatUnsub) return;
  const q = query(collection(db, 'guilds', guildId, 'chat'), orderBy('at', 'desc'), limit(50));
  chatUnsub = onSnapshot(q, snap => {
    chatMessages = snap.docs.map(d => d.data()).reverse();
    if (guildTab === 'chat') renderChatMessages();
  }, () => {});
}

function chatSection() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%; display:flex; flex-direction:column; gap:8px;';
  wrap.innerHTML = `
    <div id="guild-chat-messages" style="display:flex; flex-direction:column; gap:6px; max-height:340px; overflow-y:auto; padding:4px;"></div>
    <div style="display:flex; gap:6px;">
      <input type="text" id="guild-chat-input" maxlength="${300}" data-i18n-placeholder="guild_chat_ph" placeholder="${T[state.lang].guild_chat_ph}" style="flex:1;" onkeydown="if(event.key==='Enter') sendGuildChatMessage();">
      <button style="padding:12px 16px;" onclick="sendGuildChatMessage()">${T[state.lang].guild_chat_send}</button>
    </div>`;
  setTimeout(renderChatMessages, 0);
  return wrap;
}

function renderChatMessages() {
  const el = $('guild-chat-messages');
  if (!el) return;
  const myUid = state.currentUser && state.currentUser.uid;
  el.innerHTML = '';
  if (!chatMessages.length) {
    el.innerHTML = `<div class="muted" style="text-align:center;">${T[state.lang].guild_chat_empty}</div>`;
  } else {
    chatMessages.forEach(m => {
      const bubble = document.createElement('div');
      const mine = m.uid === myUid;
      bubble.style.cssText = `align-self:${mine ? 'flex-end' : 'flex-start'}; max-width:80%; background:${mine ? 'rgba(45,214,255,0.12)' : 'rgba(255,255,255,0.06)'}; border:1px solid ${mine ? 'rgba(45,214,255,0.35)' : 'rgba(255,255,255,0.12)'}; border-radius:10px; padding:6px 10px;`;
      const nickEl = document.createElement('div');
      nickEl.style.cssText = 'font-size:0.7rem; font-weight:700; color:#8fa0d6;';
      nickEl.textContent = m.nick || '';
      bubble.appendChild(nickEl);
      const textEl = document.createElement('div');
      textEl.style.cssText = 'font-size:0.9rem; word-break:break-word;';
      textEl.textContent = m.text || '';
      bubble.appendChild(textEl);
      el.appendChild(bubble);
    });
  }
  el.scrollTop = el.scrollHeight;
}

window.sendGuildChatMessage = async () => {
  const input = $('guild-chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try { await callSendGuildMessage({ text }); } catch (e) { /* melhor esforço — a mensagem só some da caixa se falhar mesmo */ }
};

/* ================== ações (chamadas às Cloud Functions) ================== */
async function uiRequestJoinGuild(guildId) {
  try {
    await callRequestJoinGuild({ guildId });
    state.myData.pendingGuildRequest = { guildId };
    renderGuildScreen();
  } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
}
window.uiCancelGuildRequest = async () => {
  try {
    await callCancelGuildJoinRequest();
    state.myData.pendingGuildRequest = null;
    renderGuildScreen();
  } catch (e) {}
};
async function uiRespondGuildRequest(applicantUid, accept) {
  try { await callRespondGuildJoinRequest({ applicantUid, accept }); } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
}
window.uiLeaveGuild = async () => {
  try {
    await callLeaveGuild();
    state.myData.guildId = null;
    state.myData.guildTag = null;
    stopGuildListeners();
    window.showGuildList();
  } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
};
async function uiKickGuildMember(uid, nick) {
  if (!confirm(T[state.lang].guild_confirm_kick(nick))) return;
  try { await callKickGuildMember({ uid }); } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
}
async function uiInitiateGuildTransfer(toUid, nick) {
  if (!confirm(T[state.lang].guild_confirm_transfer(nick))) return;
  try { await callInitiateGuildLeaderTransfer({ toUid }); } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
}
window.respondGuildTransfer = async (accept) => {
  try { await callRespondGuildLeaderTransfer({ accept }); } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
};
window.uiDisbandGuild = async () => {
  if (!confirm(T[state.lang].guild_confirm_disband)) return;
  try {
    await callDisbandGuild();
    state.myData.guildId = null;
    state.myData.guildTag = null;
    guildListCache = null;
    stopGuildListeners();
    window.showGuildList();
  } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
};

/* ================== ranking de clãs (aba "Clãs" do ranking) ================== */
// chamada por js/ranking.js quando a aba "guilds" é selecionada — tabela
// própria (nome/sigla + nível), não reaproveita buildRankRowNick porque uma
// linha de clã não tem xp/equipped/avatar de JOGADOR, é outro tipo de linha
export async function loadGuildRanking() {
  const body = $('ranking-body');
  body.innerHTML = `<tr><td colspan="3" class="muted">${T[state.lang].loading_text}</td></tr>`;
  try {
    const guilds = await fetchAllGuilds(true);
    guilds.sort((a, b) => (b.level || 1) - (a.level || 1) || (b.xp || 0) - (a.xp || 0) || a.name.localeCompare(b.name));
    body.innerHTML = '';
    if (!guilds.length) {
      body.innerHTML = `<tr><td colspan="3" class="muted">${T[state.lang].guild_list_empty}</td></tr>`;
      return;
    }
    guilds.forEach((g, i) => {
      const pos = i + 1;
      const medal = pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : pos;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="pos">${medal}</td><td class="nick-cell"></td><td class="pts">${guildLevelFromXp(g.xp || 0)}</td>`;
      const cell = tr.children[1];
      cell.style.cursor = 'pointer';
      const tagSpan = document.createElement('span');
      tagSpan.textContent = `[${g.tag}] `;
      tagSpan.style.cssText = 'font-family:\'Orbitron\',sans-serif; font-weight:800; color:var(--neon-purple);';
      cell.appendChild(tagSpan);
      const nameSpan = document.createElement('span');
      nameSpan.textContent = g.name;
      cell.appendChild(nameSpan);
      cell.onclick = () => {
        pushScreenAndShow('guild-screen', 'ranking-screen');
        openGuildScreen(g.id);
      };
      body.appendChild(tr);
    });
  } catch (e) {
    body.innerHTML = `<tr><td colspan="3" class="muted">${T[state.lang].ranking_error}</td></tr>`;
  }
  resetScroll('ranking-screen');
}

/* ================== badge de notificação no botão do menu ================== */
// solicitações pendentes (se eu for líder) OU convite de liderança
// esperando resposta — mesmo padrão do badge de amigos (ver js/menu.js)
export async function refreshGuildMenuBadge() {
  const badge = $('menu-quick-guild-badge');
  if (!badge) return;
  if (state.offline || !state.currentUser || !state.myData.guildId) { badge.style.display = 'none'; return; }
  try {
    const snap = await getDoc(doc(db, 'guilds', state.myData.guildId));
    if (!snap.exists()) { badge.style.display = 'none'; return; }
    const g = snap.data();
    const myUid = state.currentUser.uid;
    let n = 0;
    if (g.pendingTransferToUid === myUid) n += 1;
    if (g.leaderUid === myUid) {
      const reqSnap = await getDoc(doc(db, 'guildJoinRequests', state.myData.guildId));
      n += Object.keys((reqSnap.exists() && reqSnap.data().incoming) || {}).length;
    }
    badge.textContent = n;
    badge.style.display = n > 0 ? '' : 'none';
  } catch (e) {
    badge.style.display = 'none';
  }
}
