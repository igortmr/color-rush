import {
  doc, getDoc, collection, query, orderBy, limit, onSnapshot, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db, callable } from './firebase.js';
import { $, withBtnLoading } from './dom.js';
import { state } from './state.js';
import { show, pushScreenAndShow, popScreenBack, resetScroll } from './nav.js';
import { T } from './i18n.js';
import { myXp, levelFromXp, GUILD_CREATE_MIN_LEVEL, GUILD_JOIN_MIN_LEVEL, GUILD_MAX_MEMBERS, guildLevelFromXp, pigmentIconSvg, lvChip, applyGuildTagStyle } from './levels.js';
import { isMuted, tone, formatMsgTime, formatMsgFullDateTime } from './utils.js';
import { fetchAllScores, rowData, buildLevelNickBlock } from './ranking-cache.js';
import { openProfileByUid } from './friends.js';
import { COLORS } from './constants.js';

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
const callInviteGuildMember = callable('inviteGuildMember');
const callCancelGuildInvite = callable('cancelGuildInvite');
const callRespondGuildInvite = callable('respondGuildInvite');
const callSetGuildTyping = callable('setGuildTyping');
const callReportGuildMessage = callable('reportGuildMessage');
const callDonateToGuildTreasury = callable('donateToGuildTreasury');
const callBuyGuildTagStyle = callable('buyGuildTagStyle');

/* ================== estado local da tela do clã aberto ================== */
let currentGuildId = null;
let currentGuildData = null;
let guildUnsub = null;
let joinReqUnsub = null;
let inviteUnsub = null;
let chatUnsub = null;
let guildTab = 'members'; // 'members' | 'chat' | 'treasury' | 'shop'
let guildRenderToken = 0; // ver renderGuildScreen abaixo

function stopGuildListeners() {
  if (guildUnsub) { guildUnsub(); guildUnsub = null; }
  if (joinReqUnsub) { joinReqUnsub(); joinReqUnsub = null; }
  if (inviteUnsub) { inviteUnsub(); inviteUnsub = null; }
  if (chatUnsub) { chatUnsub(); chatUnsub = null; }
  stopTypingListener();
  currentGuildId = null;
  currentGuildData = null;
}
// chamado no logout (ver doLogout em js/auth.js) — nenhum listener de clã
// deve sobreviver a uma troca de conta
window.stopGuildListeners = stopGuildListeners;

// convite de clã recebido (gravado em scores/{uid}.pendingGuildInvite por
// inviteGuildMember, ver functions/index.js) — mesmo problema/solução da
// bolinha de pedido de amizade (ver ensureFriendRequestsListener em
// js/friends.js) e da caixa de mensagens do desafio diário (ver
// ensureInboxBadgeListener em js/daily-challenge.js): sem isso, o convite só
// aparecia (bolinha do menu + cartão de aceitar/recusar na tela do clã)
// depois de sair/voltar a entrar no jogo. Diferente do resto do clã (guildUnsub/
// joinReqUnsub/inviteUnsub acima), este listener não é preso à tela de um clã
// específico — fica ativo a sessão toda, então NÃO entra em stopGuildListeners
// (chamada toda vez que se navega pra longe de um clã, o que mataria o
// listener à toa). Ouve o PRÓPRIO doc scores/{uid} inteiro (não existe uma
// coleção dedicada pra "convites que EU recebi", diferente de
// guildInvites/{guildId} que é do lado de quem convida), mas só aplica o
// campo pendingGuildInvite em state.myData — nunca sobrescreve os outros
// campos (xp, recordes, etc.), que já têm suas próprias atualizações
// otimistas espalhadas pelo resto do jogo.
let myScoreInviteUnsub = null;
function ensureGuildInviteListener() {
  if (myScoreInviteUnsub || state.offline || !state.currentUser) return;
  const myUid = state.currentUser.uid;
  myScoreInviteUnsub = onSnapshot(doc(db, 'scores', myUid), snap => {
    const data = snap.exists() ? snap.data() : {};
    state.myData.pendingGuildInvite = data.pendingGuildInvite || null;
    refreshGuildMenuBadge();
  }, () => {});
}
window.ensureGuildInviteListener = ensureGuildInviteListener;
window.stopGuildInviteListener = () => {
  if (myScoreInviteUnsub) { myScoreInviteUnsub(); myScoreInviteUnsub = null; }
};

/* ================== atalho do menu ================== */
// "CLÃS" no menu vai direto pro próprio clã se a pessoa já estiver em um;
// senão, abre a listagem geral pra procurar/criar um
window.showGuildHome = () => {
  if (state.myData.guildId) {
    pushScreenAndShow('guild-screen', 'menu-screen');
    openGuildScreen(state.myData.guildId);
  } else if (state.myData.pendingGuildInvite) {
    // convite pendente tem prioridade — leva direto pro clã que convidou,
    // já mostrando o cartão de aceitar/recusar (ver nonMemberActionCard)
    pushScreenAndShow('guild-screen', 'menu-screen');
    openGuildScreen(state.myData.pendingGuildInvite.guildId);
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
  if (canCreate) createBtn.textContent = T[state.lang].guild_btn_create;
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
  tagSpan.style.cssText = 'font-family:\'Orbitron\',sans-serif; font-weight:800; color:#fff;';
  applyGuildTagStyle(tagSpan, g.tagStyle);
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
  countSpan.textContent = `👥 ${count}/${GUILD_MAX_MEMBERS}`;
  countSpan.style.cssText = `font-weight:700; color:${full ? 'var(--neon-red)' : 'var(--neon-green)'};`;
  right.appendChild(countSpan);
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
  $('create-guild-cost').innerHTML = `${T[state.lang].guild_create_cost_label}<b>500</b>${pigmentIconSvg(16)}`;
  $('create-guild-modal').style.display = 'flex';
};
window.closeCreateGuildModal = () => {
  $('create-guild-modal').style.display = 'none';
};
window.submitCreateGuild = async () => {
  const errEl = $('create-guild-error');
  errEl.textContent = '';
  const name = $('create-guild-name').value.trim();
  const tag = $('create-guild-tag').value.trim(); // maiúscula/minúscula livre, do jeito que a pessoa digitou
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
    // se eu sou a líder, mantém os listeners de solicitações/convites em dia;
    // se deixei de ser líder (ou saí), desliga os dois
    if (myUid && currentGuildData.leaderUid === myUid) {
      ensureJoinRequestsListener(guildId);
      ensureInvitesListener(guildId);
    } else {
      if (joinReqUnsub) { joinReqUnsub(); joinReqUnsub = null; }
      if (inviteUnsub) { inviteUnsub(); inviteUnsub = null; }
    }
    // se deixei de ser membro (expulsa/saí em outra aba), desliga o chat
    if (!stillMember) {
      if (chatUnsub) { chatUnsub(); chatUnsub = null; }
      stopTypingListener();
    }
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

// convites que a líder já mandou (ver inviteGuildMember) — mesmo padrão do
// listener de solicitações acima, só que na direção contrária
function ensureInvitesListener(guildId) {
  if (inviteUnsub) return;
  inviteUnsub = onSnapshot(doc(db, 'guildInvites', guildId), snap => {
    currentInvites = (snap.exists() && snap.data().outgoing) || {};
    renderGuildScreen();
  }, () => {});
}
let currentInvites = {};

window.guildBack = () => {
  stopGuildListeners();
  popScreenBack();
};

async function renderGuildScreen() {
  // essa função é async (por causa do await fetchAllScores() lá embaixo) e é
  // chamada por 3 listeners diferentes (doc do clã, solicitações, convites)
  // que costumam disparar quase juntos ao abrir a tela — sem esse token,
  // cada chamada em voo terminava appendando de novo em cima da anterior
  // (nenhuma delas limpa o body DEPOIS do await, só antes), triplicando a
  // seção de convidar/desfazer clã. Só a chamada mais recente tem permissão
  // de continuar depois do await
  const myRenderToken = ++guildRenderToken;
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
  // admin pode ver as 4 abas (Membros/Chat/Cofre/Loja) de QUALQUER clã, sem
  // precisar ser membro -- só visualização (não vira líder, não some com o
  // "só a líder pode comprar" na Loja etc.); chat/cofre também precisam do
  // bypass nas firestore.rules (guilds/{id}/chat e /treasuryLog), senão a
  // leitura falha mesmo com a aba aparecendo
  const isAdmin = state.myData.admin === true;
  const canSeeTabs = isMember || isAdmin;
  const level = guildLevelFromXp(g.xp || 0);

  header.innerHTML = `
    <span style="font-family:'Orbitron',sans-serif; font-weight:800; color:#fff;">[${g.tag}]</span>
    <span style="font-weight:700; font-size:1.2rem;"></span>
    <span class="lv-chip" style="margin-left:6px; color:var(--neon-purple); border-color:var(--neon-purple); text-shadow:0 0 6px rgba(177,77,255,0.5);">${T[state.lang].guild_level_chip(level)}</span>`;
  header.children[1].textContent = g.name; // nome livre — sempre via textContent
  applyGuildTagStyle(header.children[0], g.tagStyle);

  // aviso de transferência de liderança pendente pra mim
  if (myUid && g.pendingTransferToUid === myUid) {
    body.insertAdjacentHTML('beforeend', `
      <div class="card" style="text-align:center; border-color:var(--neon-yellow);">
        <p>${T[state.lang].guild_transfer_offer(g.name)}</p>
        <div class="btn-row" style="width:100%;">
          <button style="flex:1;" onclick="withBtnLoading(this, () => respondGuildTransfer(true))">${T[state.lang].btn_accept}</button>
          <button class="secondary" style="flex:1;" onclick="withBtnLoading(this, () => respondGuildTransfer(false))">${T[state.lang].btn_decline}</button>
        </div>
      </div>`);
  }

  // não sou membro nem admin: pedir entrada / cancelar pedido / avisos de
  // bloqueio (admin não pede entrada, só observa)
  if (!isMember && !isAdmin) {
    body.appendChild(nonMemberActionCard(g, myUid));
  }

  if (canSeeTabs) {
    const tabs = document.createElement('div');
    tabs.className = 'scope-tabs';
    tabs.innerHTML = `
      <button class="scope-tab ${guildTab === 'members' ? 'active' : ''}" onclick="setGuildTab('members')">${T[state.lang].guild_tab_members}</button>
      <button class="scope-tab ${guildTab === 'chat' ? 'active' : ''}" onclick="setGuildTab('chat')">${T[state.lang].guild_tab_chat}</button>
      <button class="scope-tab ${guildTab === 'treasury' ? 'active' : ''}" onclick="setGuildTab('treasury')">${T[state.lang].guild_tab_treasury}</button>
      <button class="scope-tab ${guildTab === 'shop' ? 'active' : ''}" onclick="setGuildTab('shop')">${T[state.lang].guild_tab_shop}</button>`;
    body.appendChild(tabs);
  }

  if (!canSeeTabs || guildTab === 'members') {
    // nível de cada pessoa (membro ou solicitando entrada) do lado do nick,
    // igual já é no resto do jogo — vem do mesmo cache de pontuações usado
    // pelo ranking/amigos, sem leitura extra por pessoa
    let xpByUid = {};
    try {
      const all = await fetchAllScores();
      all.forEach(r => { xpByUid[r.uid] = rowData(r).xp || 0; });
    } catch { /* sem nível não quebra a lista, só mostra sem o chip */ }
    // uma renderização mais nova já assumiu enquanto essa esperava
    // fetchAllScores (ver comentário no topo da função) — não appenda por
    // cima, senão duplica/triplica a lista de membros e as seções de líder
    if (myRenderToken !== guildRenderToken) return;
    // a pessoa pode ter trocado de aba enquanto isso carregava (fetchAllScores
    // já é cacheado, mas ainda é assíncrono) — sem essa checagem, a lista de
    // membros podia desenhar por cima de outra aba depois que a pessoa já
    // tinha saído dela
    if (guildTab !== 'members' && canSeeTabs) return;

    body.appendChild(membersSection(g, myUid, isLeader, xpByUid));
    if (isLeader) body.appendChild(joinRequestsSection(xpByUid));
    if (isLeader) body.appendChild(invitesSection(xpByUid));
    if (isLeader) body.appendChild(leaderToolsSection(g));
  } else if (guildTab === 'chat') {
    body.appendChild(chatSection(g, myUid, !isMember));
    ensureChatListener(g.id);
  } else if (guildTab === 'treasury') {
    // nível de cada doador do lado do nick, mesmo padrão/cache de
    // membersSection acima (aqui é buscado de novo pq essa aba é um else-if
    // separado, fora daquele bloco). nickByUid junto pq o ranking de doações
    // usa g.treasuryContributions (chaveado por uid) — quem já saiu do clã
    // não tem mais entrada em g.members, então o nick precisa vir de algum
    // lugar que não dependa de continuar sendo membro (ver treasurySection)
    let xpByUid = {};
    let nickByUid = {};
    try {
      const all = await fetchAllScores();
      all.forEach(r => { const d = rowData(r); xpByUid[r.uid] = d.xp || 0; nickByUid[r.uid] = d.nick || ''; });
    } catch { /* sem nível não quebra a lista, só mostra sem o chip */ }
    if (myRenderToken !== guildRenderToken) return;
    body.appendChild(treasurySection(g, xpByUid, nickByUid, !isMember));
  } else if (guildTab === 'shop') {
    body.appendChild(guildShopSection(g, myUid, isLeader));
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
  // convite recebido da líder desse clã (ver inviteGuildMember) — checado
  // ANTES da solicitação enviada por mim, já que só dá pra ter uma das
  // duas coisas de cada vez (não dá pra convidar quem já pediu, nem pedir
  // pra entrar em outro depois de já ter um convite pendente)
  const invite = state.myData.pendingGuildInvite;
  if (invite && invite.guildId === g.id) {
    wrap.innerHTML = `<p>${T[state.lang].guild_invite_received(g.name)}</p>`;
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.style.width = '100%';
    const acceptBtn = document.createElement('button');
    acceptBtn.style.flex = '1';
    acceptBtn.textContent = T[state.lang].btn_accept;
    acceptBtn.onclick = () => withBtnLoading(acceptBtn, () => respondGuildInvite(true));
    row.appendChild(acceptBtn);
    const declineBtn = document.createElement('button');
    declineBtn.className = 'secondary';
    declineBtn.style.flex = '1';
    declineBtn.textContent = T[state.lang].btn_decline;
    declineBtn.onclick = () => withBtnLoading(declineBtn, () => respondGuildInvite(false));
    row.appendChild(declineBtn);
    wrap.appendChild(row);
    return wrap;
  }
  const pending = state.myData.pendingGuildRequest;
  if (pending && pending.guildId === g.id) {
    wrap.innerHTML = `<p class="muted">${T[state.lang].guild_request_pending}</p>`;
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = T[state.lang].btn_cancel_request;
    btn.onclick = () => withBtnLoading(btn, uiCancelGuildRequest);
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
  // sem .card aqui (aquela borda roxa) — só o botão sozinho, mesmo
  // tratamento do botão de convidar pro clã (ver renderGuildInviteAction).
  // Só nesse retorno: os outros "return wrap" acima (convite recebido,
  // pedido pendente, aviso de nível/clã cheio etc.) continuam com o card.
  wrap.className = '';
  const btn = document.createElement('button');
  btn.textContent = T[state.lang].guild_btn_request_join;
  btn.style.cssText = 'padding:6px 16px; font-size:0.75rem;';
  btn.onclick = () => withBtnLoading(btn, () => uiRequestJoinGuild(g.id));
  wrap.appendChild(btn);
  return wrap;
}

function membersSection(g, myUid, isLeader, xpByUid) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%; display:flex; flex-direction:column; gap:8px;';
  const entries = Object.entries(g.members || {}).sort((a, b) => (a[1].joinedAt && b[1].joinedAt) ? a[1].joinedAt.toMillis() - b[1].joinedAt.toMillis() : 0);
  entries.forEach(([uid, data]) => wrap.appendChild(memberRow(g, uid, data, myUid, isLeader, xpByUid)));
  return wrap;
}

function memberRow(g, uid, data, myUid, isLeader, xpByUid) {
  const row = document.createElement('div');
  row.className = 'card';
  row.style.cssText = 'flex-direction:row; align-items:center; justify-content:space-between; padding:10px 14px; gap:8px; flex-wrap:wrap;';

  const left = document.createElement('span');
  left.style.cssText = 'display:flex; align-items:center; gap:6px;';
  left.insertAdjacentHTML('beforeend', lvChip((xpByUid && xpByUid[uid]) || 0)); // conteúdo fixo (número/cor), seguro via innerHTML
  if (uid === g.leaderUid) {
    const crown = document.createElement('span');
    crown.textContent = '👑';
    crown.title = T[state.lang].guild_leader_label;
    left.appendChild(crown);
  }
  const nickSpan = document.createElement('span');
  nickSpan.textContent = data.nick || '';
  nickSpan.className = 'nick-click';
  nickSpan.onclick = () => openProfileByUid(uid, data.nick || '', 'guild-screen');
  left.appendChild(nickSpan);
  row.appendChild(left);

  if (isLeader && uid !== myUid) {
    // ações (tornar líder / expulsar) saíram de dentro da linha e foram pra
    // popup #guild-member-actions-modal (ver openGuildMemberActionsModal
    // abaixo) -- um botão só de "menu" (⋮, padrão universal de "mais opções")
    // em vez dos dois botões que lotavam a linha antes
    const actionsBtn = document.createElement('button');
    actionsBtn.className = 'secondary';
    actionsBtn.style.cssText = 'padding:4px 10px; font-size:0.9rem; line-height:1;';
    actionsBtn.textContent = '⋮';
    actionsBtn.setAttribute('aria-label', T[state.lang].guild_member_actions_title);
    actionsBtn.onclick = () => openGuildMemberActionsModal(uid, data.nick || '');
    row.appendChild(actionsBtn);
  } else if (!isLeader && uid === myUid) {
    // "sair do clã" fica na própria linha do membro (em vez de um botão à
    // parte embaixo da lista toda) — só a líder não vê isso aqui, ela usa
    // "desfazer clã" (ver leaderToolsSection)
    const leaveBtn = document.createElement('button');
    leaveBtn.className = 'secondary';
    leaveBtn.style.cssText = 'padding:4px 8px; font-size:0.7rem;';
    leaveBtn.textContent = T[state.lang].guild_btn_leave;
    leaveBtn.onclick = () => withBtnLoading(leaveBtn, uiLeaveGuild);
    row.appendChild(leaveBtn);
  }
  return row;
}

function joinRequestsSection(xpByUid) {
  const entries = Object.entries(currentJoinRequests || {});
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%; display:flex; flex-direction:column; gap:8px; margin-top:6px;';
  if (!entries.length) return wrap;
  wrap.insertAdjacentHTML('beforeend', `<div class="muted" style="text-align:center; margin-top:6px;">${T[state.lang].guild_requests_title}</div>`);
  entries.forEach(([uid, data]) => {
    const row = document.createElement('div');
    row.className = 'card';
    row.style.cssText = 'flex-direction:row; align-items:center; justify-content:space-between; padding:10px 14px; gap:8px; flex-wrap:wrap;';
    const left = document.createElement('span');
    left.style.cssText = 'display:flex; align-items:center; gap:6px;';
    left.insertAdjacentHTML('beforeend', lvChip((xpByUid && xpByUid[uid]) || 0));
    const nickSpan = document.createElement('span');
    nickSpan.textContent = data.nick || '';
    nickSpan.className = 'nick-click';
    nickSpan.onclick = () => openProfileByUid(uid, data.nick || '', 'guild-screen');
    left.appendChild(nickSpan);
    row.appendChild(left);
    const actions = document.createElement('span');
    actions.style.cssText = 'display:flex; gap:5px;';
    const acceptBtn = document.createElement('button');
    acceptBtn.style.cssText = 'padding:4px 8px; font-size:0.7rem;';
    acceptBtn.textContent = T[state.lang].btn_accept;
    acceptBtn.onclick = () => withBtnLoading(acceptBtn, () => uiRespondGuildRequest(uid, true));
    actions.appendChild(acceptBtn);
    const declineBtn = document.createElement('button');
    declineBtn.className = 'secondary';
    declineBtn.style.cssText = 'padding:4px 8px; font-size:0.7rem;';
    declineBtn.textContent = T[state.lang].btn_decline;
    declineBtn.onclick = () => withBtnLoading(declineBtn, () => uiRespondGuildRequest(uid, false));
    actions.appendChild(declineBtn);
    row.appendChild(actions);
    wrap.appendChild(row);
  });
  return wrap;
}

// convidar alguém pro clã não é mais digitando o nick aqui — agora é um
// botão no PERFIL da pessoa (só visível pra quem lidera um clã, ver
// renderGuildInviteAction mais abaixo), complementa joinRequestsSection
// acima (que é a pessoa PEDINDO pra entrar; aqui é a líder CHAMANDO alguém)

function invitesSection(xpByUid) {
  const entries = Object.entries(currentInvites || {});
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%; display:flex; flex-direction:column; gap:8px; margin-top:6px;';
  if (!entries.length) return wrap;
  wrap.insertAdjacentHTML('beforeend', `<div class="muted" style="text-align:center; margin-top:6px;">${T[state.lang].guild_invites_sent_title}</div>`);
  entries.forEach(([uid, data]) => {
    const row = document.createElement('div');
    row.className = 'card';
    row.style.cssText = 'flex-direction:row; align-items:center; justify-content:space-between; padding:10px 14px; gap:8px; flex-wrap:wrap;';
    const left = document.createElement('span');
    left.style.cssText = 'display:flex; align-items:center; gap:6px;';
    left.insertAdjacentHTML('beforeend', lvChip((xpByUid && xpByUid[uid]) || 0));
    const nickSpan = document.createElement('span');
    nickSpan.textContent = data.nick || '';
    left.appendChild(nickSpan);
    row.appendChild(left);
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'secondary';
    cancelBtn.style.cssText = 'padding:4px 8px; font-size:0.7rem;';
    cancelBtn.textContent = T[state.lang].btn_cancel_request;
    cancelBtn.onclick = () => withBtnLoading(cancelBtn, () => uiCancelGuildInvite(uid));
    row.appendChild(cancelBtn);
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

/* ================== Cofre do Clã (aba "Cofre") ================== */
// qualquer membro doa pigmentos da própria conta (ver donateToGuildTreasury
// em functions/index.js); o saldo (g.treasury) é visível pra todo o clã.
// treasuryContributions é só informativo (quem doou quanto no total), não
// dá nenhum privilégio — só a líder gasta o saldo, na Loja do Clã abaixo.

// splash de pigmentos coloridos (mesma silhueta de gota do pigmentIconSvg em
// js/levels.js, só que em cores sólidas da paleta do jogo em vez do
// gradiente fixo) — toca ao confirmar uma doação, mesmo padrão visual do
// confetti de recorde (ver spawnConfettiVariant em js/game-core.js), só que
// estourando do centro da tela em vez de caindo do topo (ver .pigment-splash-*
// em css/style.css)
const PIGMENT_DROP_PATH = 'M12 2C12 2 5 11 5 15.5C5 19.6 8.13 22 12 22C15.87 22 19 19.6 19 15.5C19 11 12 2 12 2Z';
function spawnPigmentSplash() {
  const layer = document.createElement('div');
  layer.className = 'pigment-splash-layer';
  const palette = COLORS.map(c => c.hex);
  for (let i = 0; i < 24; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 140;
    const size = 14 + Math.random() * 14;
    const drop = document.createElement('div');
    drop.className = 'pigment-splash-bit';
    drop.style.setProperty('--dx', (Math.cos(angle) * dist) + 'px');
    drop.style.setProperty('--dy', (Math.sin(angle) * dist) + 'px');
    drop.style.width = size + 'px';
    drop.style.height = size + 'px';
    drop.style.animationDelay = (Math.random() * 0.15) + 's';
    drop.style.animationDuration = (0.9 + Math.random() * 0.5) + 's';
    drop.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><path d="${PIGMENT_DROP_PATH}" fill="${palette[i % palette.length]}" stroke="rgba(255,255,255,0.5)" stroke-width="1"/></svg>`;
    layer.appendChild(drop);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1700);
}
// "cha-ching" curtinho (arpejo ascendente C-E-G bem agudo) — mesma técnica
// de tone() já usada pro aviso sonoro do chat de clã (ver ensureChatListener
// acima), sem precisar de nenhum arquivo de áudio
function playDonateSound() {
  tone(1046.5, 0.09, 'sine', 0.18, 0);
  tone(1318.5, 0.12, 'sine', 0.18, 0.08);
  tone(1568, 0.16, 'sine', 0.16, 0.16);
}

// readOnly: admin vendo o cofre de um clã que não é o próprio (ver
// renderGuildScreen) -- donateToGuildTreasury no servidor doa pro guildId da
// PRÓPRIA conta (não pro clã aberto na tela), então deixar o formulário de
// doação aqui doaria pro clã errado sem avisar; melhor nem mostrar
function treasurySection(g, xpByUid, nickByUid, readOnly) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%; display:flex; flex-direction:column; gap:10px;';

  const balanceCard = document.createElement('div');
  balanceCard.className = 'card';
  balanceCard.style.textAlign = 'center';
  balanceCard.innerHTML = `
    <div class="muted" style="font-size:0.85rem;">${T[state.lang].guild_treasury_balance_label}</div>
    <div style="font-family:'Orbitron',sans-serif; font-weight:800; font-size:1.6rem; display:flex; align-items:center; justify-content:center; gap:6px; margin-top:4px;">
      <span>${g.treasury || 0}</span>${pigmentIconSvg(20)}
    </div>`;
  wrap.appendChild(balanceCard);

  if (readOnly) {
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.cssText = 'text-align:center; font-size:0.78rem;';
    hint.textContent = T[state.lang].guild_admin_readonly_hint;
    wrap.appendChild(hint);
  } else {
    const donateCard = document.createElement('div');
    donateCard.className = 'card';
    donateCard.style.textAlign = 'center';
    const myPigmentos = state.myData.pigmentos || 0;
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.cssText = 'font-size:0.8rem; margin-bottom:8px; display:flex; align-items:center; justify-content:center; gap:4px;';
    hint.innerHTML = `${T[state.lang].guild_treasury_donate_hint}<b>${myPigmentos}</b>${pigmentIconSvg(12)}`;
    donateCard.appendChild(hint);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; align-items:center; justify-content:center;';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = String(myPigmentos);
    input.placeholder = '0';
    input.style.cssText = 'width:100px; text-align:center; padding:8px;';
    row.appendChild(input);
    const donateBtn = document.createElement('button');
    donateBtn.textContent = T[state.lang].guild_btn_donate;
    donateBtn.style.cssText = 'padding:8px 18px; font-size:0.8rem;';
    row.appendChild(donateBtn);
    donateCard.appendChild(row);
    const status = document.createElement('div');
    status.className = 'muted';
    status.style.cssText = 'margin-top:8px; min-height:1.2em; font-size:0.8rem;';
    donateCard.appendChild(status);

    donateBtn.onclick = () => {
      const amount = parseInt(input.value, 10);
      status.textContent = '';
      if (!Number.isInteger(amount) || amount <= 0) {
        status.textContent = T[state.lang].guild_treasury_invalid_amount;
        return;
      }
      if (amount > myPigmentos) {
        status.textContent = T[state.lang].guild_treasury_not_enough_own;
        return;
      }
      // popup temática de confirmação antes de doar de verdade (mesmo padrão
      // do #buy-shop-modal/#buy-guild-tag-style-modal) — o callback só roda se
      // a pessoa confirmar (ver window.confirmDonateToGuildTreasury abaixo)
      window.startDonateToGuildTreasury(amount, async () => {
        donateBtn.disabled = true;
        try {
          await callDonateToGuildTreasury({ amount });
          state.myData.pigmentos = myPigmentos - amount; // otimista — atualiza local na hora, sem esperar o próximo fetch
          spawnPigmentSplash();
          playDonateSound();
          renderGuildScreen(); // recarrega saldo do cofre + lista/histórico de doações
        } catch (e) {
          status.textContent = (e && e.message) || T[state.lang].guild_err_generic;
          donateBtn.disabled = false;
        }
      });
    };
    wrap.appendChild(donateCard);
  }

  // ranking de maiores doações somadas (total por pessoa, treasuryContributions
  // — só informativo, não dá nenhum privilégio)
  const contributions = g.treasuryContributions || {};
  const entries = Object.entries(contributions).filter(([, amt]) => amt > 0).sort((a, b) => b[1] - a[1]);
  if (entries.length) {
    const listTitle = document.createElement('div');
    listTitle.innerHTML = `<b>${T[state.lang].guild_treasury_ranking_title}</b>`;
    wrap.appendChild(listTitle);
    const list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
    entries.forEach(([uid, amt], i) => {
      const pos = i + 1;
      const medal = pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : pos;
      const memberRow2 = document.createElement('div');
      memberRow2.className = 'card';
      memberRow2.style.cssText = 'flex-direction:row; align-items:center; justify-content:space-between; padding:8px 14px; gap:8px;';
      const left = document.createElement('span');
      left.style.cssText = 'display:flex; align-items:center; gap:8px;';
      const posSpan = document.createElement('span');
      posSpan.style.cssText = 'font-weight:800; min-width:1.4em; text-align:center; flex-shrink:0;';
      posSpan.textContent = medal;
      left.appendChild(posSpan);
      // g.members só tem quem ainda está no clã — quem já saiu não aparece
      // mais lá (por isso o "?" no lugar do nick, bug reportado), então o
      // fallback vem do cache de pontuações (nickByUid), que tem todo mundo
      // que já pontuou uma vez, membro atual ou não
      const nick = (g.members && g.members[uid] && g.members[uid].nick) || (nickByUid && nickByUid[uid]) || '?';
      const nickBlock = buildLevelNickBlock((xpByUid && xpByUid[uid]) || 0, nick, '');
      const nickSpan = nickBlock.querySelector('.nick-top-row span');
      if (nickSpan) {
        nickSpan.className = 'nick-click';
        nickSpan.onclick = () => openProfileByUid(uid, nick, 'guild-screen');
      }
      left.appendChild(nickBlock);
      memberRow2.appendChild(left);
      const amtSpan = document.createElement('span');
      amtSpan.style.cssText = 'display:flex; align-items:center; gap:4px; font-weight:700; flex-shrink:0;';
      amtSpan.innerHTML = `${amt}${pigmentIconSvg(12)}`;
      memberRow2.appendChild(amtSpan);
      list.appendChild(memberRow2);
    });
    wrap.appendChild(list);
  }

  // histórico de doações (últimas 20, mais recente primeiro) — busca avulsa,
  // não listener ao vivo (o chat já usa listener; aqui não precisa atualizar
  // segundo a segundo, e renderGuildScreen já recarrega a aba inteira depois
  // de uma doação sua, ver donateBtn.onclick acima)
  const historyTitle = document.createElement('div');
  historyTitle.innerHTML = `<b>${T[state.lang].guild_treasury_history_title}</b>`;
  wrap.appendChild(historyTitle);
  const historyList = document.createElement('div');
  historyList.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
  historyList.innerHTML = `<div class="muted" style="text-align:center; font-size:0.8rem;">${T[state.lang].loading_text}</div>`;
  wrap.appendChild(historyList);
  loadTreasuryHistory(g.id, historyList, xpByUid);

  return wrap;
}

async function loadTreasuryHistory(guildId, historyList, xpByUid) {
  const myToken = guildRenderToken; // mesma trava de myRenderToken usada acima — evita pintar por cima de uma aba/clã diferente se a pessoa navegar enquanto isso carrega
  try {
    const snap = await getDocs(query(collection(db, 'guilds', guildId, 'treasuryLog'), orderBy('at', 'desc'), limit(20)));
    if (myToken !== guildRenderToken) return;
    historyList.innerHTML = '';
    if (snap.empty) {
      historyList.innerHTML = `<div class="muted" style="text-align:center; font-size:0.8rem;">${T[state.lang].guild_treasury_history_empty}</div>`;
      return;
    }
    snap.forEach(d => {
      const data = d.data();
      const row = document.createElement('div');
      row.className = 'card';
      row.style.cssText = 'flex-direction:row; align-items:center; justify-content:space-between; padding:8px 14px; gap:8px;';
      const left = document.createElement('span');
      left.style.cssText = 'display:flex; flex-direction:column;';
      const nickRow = document.createElement('span');
      nickRow.style.cssText = 'display:flex; align-items:center; gap:6px;';
      nickRow.insertAdjacentHTML('beforeend', lvChip((xpByUid && xpByUid[data.uid]) || 0)); // conteúdo fixo (número/cor), seguro via innerHTML
      const nickSpan = document.createElement('span');
      nickSpan.style.fontWeight = '700';
      nickSpan.textContent = data.nick || '?';
      // data.nick já vem denormalizado no próprio log de doação (gravado no
      // momento da doação, ver donateToGuildTreasury em functions/index.js),
      // então continua certo mesmo pra quem já saiu do clã — só faltava
      // o clique pro perfil
      nickSpan.className = 'nick-click';
      nickSpan.onclick = () => openProfileByUid(data.uid, data.nick || '', 'guild-screen');
      nickRow.appendChild(nickSpan);
      left.appendChild(nickRow);
      const dateSpan = document.createElement('span');
      dateSpan.className = 'muted';
      dateSpan.style.fontSize = '0.7rem';
      dateSpan.textContent = `${formatMsgFullDateTime(data.at)} ${formatMsgTime(data.at)}`;
      left.appendChild(dateSpan);
      row.appendChild(left);
      const amtSpan = document.createElement('span');
      amtSpan.style.cssText = 'display:flex; align-items:center; gap:4px; font-weight:700; flex-shrink:0;';
      amtSpan.innerHTML = `+${data.amount || 0}${pigmentIconSvg(12)}`;
      row.appendChild(amtSpan);
      historyList.appendChild(row);
    });
  } catch (e) {
    if (myToken !== guildRenderToken) return;
    historyList.innerHTML = `<div class="muted" style="text-align:center; font-size:0.8rem;">${T[state.lang].ranking_error}</div>`;
  }
}

/* ================== Loja do Clã (aba "Loja") ================== */
// catálogo de cores/animações pra [TAG] do clã — comprado com o saldo do
// Cofre (não com pigmentos pessoais), só pela líder (ver buyGuildTagStyle em
// functions/index.js). Preço é reconferido no servidor; isso aqui é só
// exibição/preview. Chaves das 8 básicas batem com COLORS[].key de propósito.
const GUILD_TAG_STYLES_CATALOG = [
  // volta pra cor padrão (branco, sem estilo) -- de graça, fica marcada como
  // "atual" sozinha pra quem nunca comprou nada (ver isCurrent em
  // guildTagStyleCard), e serve pra reverter depois de já ter comprado outra
  { id: 'default', price: 0, name: { pt: 'Padrão (branco)', en: 'Default (white)', es: 'Predeterminado (blanco)' } },
  ...COLORS.map(c => ({ id: c.key, price: 5000, name: c.name })),
  { id: 'espectro', price: 10000, name: { pt: 'Espectro', en: 'Spectrum', es: 'Espectro' } },
];

function guildShopSection(g, myUid, isLeader) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%; display:flex; flex-direction:column; gap:10px;';

  const balanceLine = document.createElement('div');
  balanceLine.className = 'muted';
  balanceLine.style.cssText = 'text-align:center; display:flex; align-items:center; justify-content:center; gap:4px;';
  balanceLine.innerHTML = `${T[state.lang].guild_shop_balance_label}<b>${g.treasury || 0}</b>${pigmentIconSvg(14)}`;
  wrap.appendChild(balanceLine);

  if (!isLeader) {
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.cssText = 'text-align:center; font-size:0.78rem;';
    hint.textContent = T[state.lang].guild_shop_leader_only_hint;
    wrap.appendChild(hint);
  }

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:10px;';
  GUILD_TAG_STYLES_CATALOG.forEach(item => grid.appendChild(guildTagStyleCard(item, g, isLeader)));
  wrap.appendChild(grid);

  const status = document.createElement('div');
  status.className = 'muted';
  status.id = 'guild-shop-status';
  status.style.cssText = 'text-align:center; min-height:1.2em; font-size:0.8rem;';
  wrap.appendChild(status);

  return wrap;
}

function guildTagStyleCard(item, g, isLeader) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'text-align:center; padding:14px 10px; gap:4px;';

  // prévia — exatamente a mesma classe/função usada pra [TAG] de verdade em
  // qualquer lugar do jogo (ver applyGuildTagStyle em js/levels.js), então
  // já mostra certinho como vai ficar antes de comprar
  const preview = document.createElement('span');
  preview.className = 'guild-tag-link';
  preview.style.cssText = 'font-size:1rem; cursor:default; pointer-events:none;';
  preview.textContent = `[${g.tag}]`;
  applyGuildTagStyle(preview, item.id);
  card.appendChild(preview);

  const name = document.createElement('div');
  name.style.cssText = 'font-size:0.78rem; margin-top:4px;';
  name.textContent = item.name[state.lang];
  card.appendChild(name);

  const priceLine = document.createElement('div');
  priceLine.className = 'muted';
  priceLine.style.cssText = 'font-size:0.72rem; display:flex; align-items:center; justify-content:center; gap:3px; margin-top:2px;';
  priceLine.innerHTML = item.price > 0 ? `${item.price}${pigmentIconSvg(11)}` : T[state.lang].guild_shop_free_label;
  card.appendChild(priceLine);

  // "default" fica marcado como atual sozinho pra clã que nunca comprou
  // nada (g.tagStyle vem null do servidor até a primeira compra, ver
  // buyGuildTagStyle em functions/index.js) -- sem isso, nenhum card
  // aparecia com o selo de "atual" antes da primeira compra
  const isCurrent = item.id === 'default' ? !g.tagStyle || g.tagStyle === 'default' : g.tagStyle === item.id;
  if (isCurrent) {
    const badge = document.createElement('div');
    badge.style.cssText = 'font-size:0.7rem; font-weight:700; color:var(--neon-green); margin-top:6px;';
    badge.textContent = T[state.lang].guild_shop_current_label;
    card.appendChild(badge);
  } else if (isLeader) {
    if ((g.treasury || 0) < item.price) {
      const insuf = document.createElement('div');
      insuf.className = 'muted';
      insuf.style.cssText = 'font-size:0.68rem; margin-top:6px;';
      insuf.textContent = T[state.lang].guild_shop_not_enough_treasury;
      card.appendChild(insuf);
    } else {
      const buyBtn = document.createElement('button');
      buyBtn.className = 'secondary';
      buyBtn.style.cssText = 'padding:5px 14px; font-size:0.68rem; margin-top:6px;';
      buyBtn.textContent = T[state.lang].guild_shop_buy_btn;
      buyBtn.onclick = () => window.startBuyGuildTagStyle(item.id, g.tag);
      card.appendChild(buyBtn);
    }
  }
  return card;
}

// popup temática de confirmação — mesmo padrão de #buy-shop-modal (loja
// pessoal, ver startBuyShopItem em js/shop.js): guarda o id pendente numa
// variável de módulo até confirmar ou cancelar.
let pendingGuildTagStyleId = null;
window.startBuyGuildTagStyle = (styleId, guildTag) => {
  const item = GUILD_TAG_STYLES_CATALOG.find(i => i.id === styleId);
  if (!item) return;
  pendingGuildTagStyleId = styleId;
  const preview = $('buy-guild-tag-style-modal-preview');
  preview.className = 'guild-tag-link';
  preview.style.cssText = 'font-size:1.3rem; cursor:default;';
  preview.textContent = `[${guildTag}]`;
  applyGuildTagStyle(preview, styleId);
  $('buy-guild-tag-style-modal-item').textContent = item.name[state.lang];
  $('buy-guild-tag-style-modal-price').innerHTML = item.price > 0
    ? `${T[state.lang].guild_shop_price_label}<span style="font-size:1.35rem; color:var(--neon-yellow); text-shadow:0 0 8px rgba(255,233,60,0.4);">${item.price}</span>${pigmentIconSvg(20)}`
    : `<span style="font-size:1.1rem; color:var(--neon-green);">${T[state.lang].guild_shop_free_label}</span>`;
  $('buy-guild-tag-style-modal').style.display = 'flex';
};
window.closeBuyGuildTagStyleModal = () => {
  $('buy-guild-tag-style-modal').style.display = 'none';
  pendingGuildTagStyleId = null;
};
window.confirmBuyGuildTagStyle = async () => {
  const styleId = pendingGuildTagStyleId;
  const status = $('guild-shop-status');
  closeBuyGuildTagStyleModal();
  if (!styleId) return;
  try {
    await callBuyGuildTagStyle({ styleId });
    renderGuildScreen();
  } catch (e) {
    if (status) status.textContent = (e && e.message) || T[state.lang].guild_err_generic;
  }
};

// popup temática de confirmação pra doar pro Cofre do Clã — mesmo padrão de
// #buy-shop-modal/#buy-guild-tag-style-modal acima, só que quem chama guarda
// o callback de verdade (ver donateBtn.onclick em treasurySection) em vez de
// um id de catálogo, já que doação não tem catálogo, é um valor livre.
let pendingDonateConfirm = null;
window.startDonateToGuildTreasury = (amount, onConfirm) => {
  pendingDonateConfirm = onConfirm;
  $('donate-guild-treasury-modal-amount').innerHTML = `<span style="font-size:1.35rem; color:var(--neon-yellow); text-shadow:0 0 8px rgba(255,233,60,0.4);">${amount}</span>${pigmentIconSvg(20)}`;
  $('donate-guild-treasury-modal').style.display = 'flex';
};
window.closeDonateGuildTreasuryModal = () => {
  $('donate-guild-treasury-modal').style.display = 'none';
  pendingDonateConfirm = null;
};
window.confirmDonateToGuildTreasury = () => {
  const onConfirm = pendingDonateConfirm;
  window.closeDonateGuildTreasuryModal();
  if (onConfirm) onConfirm();
};

/* ================== chat do clã (aba + balãozinho flutuante) ================== */
// as duas formas de acessar o chat (a aba dentro da tela do clã e o balão
// flutuante nas telas principais) compartilham o MESMO listener/estado —
// só muda pra ONDE a lista de mensagens é desenhada (renderChatMessages
// aceita o id do container). ensureChatListener é chamada tanto ao abrir a
// aba quanto pelo balão (refreshGuildChatBubble), e é um no-op se já tiver
// um listener rodando (ver "if (chatUnsub) return").
let chatMessages = [];
let currentChatGuildId = null; // pra saber de qual clã denunciar uma mensagem (ver uiReportGuildMessage)
function ensureChatListener(guildId) {
  currentChatGuildId = guildId;
  ensureGuildMemberNicksCache(guildId);
  ensureTypingListener(guildId);
  if (chatUnsub) return;
  let firstSnapshot = true;
  const q = query(collection(db, 'guilds', guildId, 'chat'), orderBy('at', 'desc'), limit(50));
  chatUnsub = onSnapshot(q, snap => {
    const prevLast = chatMessages.length ? chatMessages[chatMessages.length - 1] : null;
    chatMessages = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
    const newLast = chatMessages.length ? chatMessages[chatMessages.length - 1] : null;
    // som de aviso só numa mensagem NOVA de verdade (não na primeira carga
    // do listener, e não quando a mensagem nova é a que EU acabei de mandar)
    const myUid = state.currentUser && state.currentUser.uid;
    const isGenuinelyNew = !firstSnapshot && newLast && newLast !== prevLast && newLast.uid !== myUid;
    firstSnapshot = false;
    if (isGenuinelyNew && !isMuted()) tone(880, 0.08, 'sine', 0.12);

    if (guildTab === 'chat' && document.querySelector('.screen.active') && document.querySelector('.screen.active').id === 'guild-screen') {
      renderChatMessages('guild-chat-messages');
    }
    if (guildChatPopupOpen) {
      renderChatMessages('guild-chat-popup-messages');
      markChatRead(guildId);
    }
    updateChatBubbleBadge(guildId);
  }, () => {});
}

// readOnly: admin vendo o chat de um clã que não é o próprio (ver
// renderGuildScreen) -- sendGuildMessage no servidor manda pro guildId da
// PRÓPRIA conta (não pro clã aberto na tela), então deixar a caixa de
// digitar visível aqui mandaria a mensagem pro clã errado sem avisar;
// melhor nem mostrar a caixa, só o histórico (a leitura em si já depende de
// um bypass admin nas firestore.rules, ver comentário lá)
function chatSection(g, myUid, readOnly) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%; display:flex; flex-direction:column; gap:8px; position:relative;';
  wrap.innerHTML = `
    <div id="guild-chat-messages" style="display:flex; flex-direction:column; gap:6px; max-height:340px; overflow-y:auto; padding:4px;"></div>
    <div class="muted chat-typing-indicator" id="guild-chat-typing" style="display:none; font-size:0.75rem; padding:0 4px;"></div>
    <div class="chat-mention-list" id="guild-chat-mentions" style="display:none;"></div>
    ${readOnly
      ? `<div class="muted" style="text-align:center; font-size:0.78rem;">${T[state.lang].guild_admin_readonly_hint}</div>`
      : `<div style="display:flex; gap:6px;">
      <input type="text" id="guild-chat-input" maxlength="300" data-i18n-placeholder="guild_chat_ph" placeholder="${T[state.lang].guild_chat_ph}" style="flex:1;" oninput="handleGuildChatInput(this,'guild-chat-mentions')" onkeydown="if(event.key==='Enter') sendGuildChatMessage();">
      <button style="padding:12px 16px;" onclick="sendGuildChatMessage()">${T[state.lang].guild_chat_send}</button>
    </div>`}`;
  setTimeout(() => renderChatMessages('guild-chat-messages'), 0);
  return wrap;
}

// desenha o texto da mensagem destacando @menções a membros de verdade do
// clã (nick sempre sem espaço, ver isValidNickServer — então "@\S+" já
// separa a menção certinho sem precisar de mais nada)
function renderMessageText(container, text) {
  const parts = (text || '').split(/(@\S+)/g);
  parts.forEach(part => {
    if (part.startsWith('@')) {
      const nick = part.slice(1);
      const isMember = guildMemberNicks.some(m => m.nick.toLowerCase() === nick.toLowerCase());
      if (isMember) {
        const span = document.createElement('span');
        span.className = 'chat-mention';
        span.textContent = part;
        container.appendChild(span);
        return;
      }
    }
    if (part) container.appendChild(document.createTextNode(part));
  });
}

// ícone por tipo de evento das mensagens de sistema (ver guildSystemMsgWrite
// em functions/index.js) — texto de verdade (traduzido) vem de
// guild_sys_<tipo>_suffix em js/i18n.js, montado depois do nick clicável
// (ver renderChatMessages abaixo)
// "donate" de propósito fora daqui -- só o ícone do pigmento à direita do
// valor (ver amtSpan em renderChatMessages), sem ícone antes do nick como os
// outros tipos
const GUILD_SYSTEM_EVENT_ICON = { create: '🎉', join: '👋', leave: '🚶', kick: '🚫', leader_transfer: '👑' };
function renderChatMessages(elId) {
  const el = $(elId);
  if (!el) return;
  const myUid = state.currentUser && state.currentUser.uid;
  el.innerHTML = '';
  if (!chatMessages.length) {
    el.innerHTML = `<div class="muted" style="text-align:center;">${T[state.lang].guild_chat_empty}</div>`;
  } else {
    chatMessages.forEach(m => {
      if (m.system) {
        const row = document.createElement('div');
        row.style.cssText = 'align-self:center; display:flex; align-items:center; justify-content:center; gap:6px; flex-wrap:wrap; font-size:0.72rem; color:#8fa0d6; padding:2px 8px; cursor:pointer;';
        const icon = GUILD_SYSTEM_EVENT_ICON[m.eventType] || '';
        if (icon) row.appendChild(document.createTextNode(icon + ' '));
        const nickSpan = document.createElement('span');
        nickSpan.textContent = m.nick || '';
        nickSpan.className = 'nick-click';
        nickSpan.style.fontWeight = '700';
        nickSpan.onclick = (ev) => { ev.stopPropagation(); openProfileByUid(m.uid, m.nick || '', 'guild-screen'); };
        row.appendChild(nickSpan);
        const suffixSpan = document.createElement('span');
        suffixSpan.textContent = T[state.lang][`guild_sys_${m.eventType}_suffix`] || '';
        row.appendChild(suffixSpan);
        // doação: valor + ícone do pigmento em vez da palavra "pigmentos"
        // (mesmo pigmentIconSvg usado no resto do clã, ver import no topo)
        if (m.eventType === 'donate') {
          const amtSpan = document.createElement('span');
          amtSpan.style.cssText = 'display:flex; align-items:center; gap:3px; font-weight:700;';
          amtSpan.innerHTML = `${m.amount || 0}${pigmentIconSvg(12)}`;
          row.appendChild(amtSpan);
        }
        // hora curtinha, sempre visível; data completa aparece ao clicar,
        // mesmo padrão das mensagens normais abaixo
        const timeSpan = document.createElement('span');
        timeSpan.style.cssText = 'color:#6b76a8;';
        timeSpan.textContent = formatMsgTime(m.at);
        row.appendChild(timeSpan);
        const fullDateSpan = document.createElement('span');
        fullDateSpan.style.cssText = 'color:#6b76a8; display:none; width:100%; text-align:center;';
        fullDateSpan.textContent = formatMsgFullDateTime(m.at);
        row.appendChild(fullDateSpan);
        row.onclick = () => { fullDateSpan.style.display = fullDateSpan.style.display === 'none' ? 'block' : 'none'; };
        el.appendChild(row);
        return;
      }
      const bubble = document.createElement('div');
      const mine = m.uid === myUid;
      bubble.style.cssText = `align-self:${mine ? 'flex-end' : 'flex-start'}; max-width:80%; background:${mine ? 'rgba(45,214,255,0.12)' : 'rgba(255,255,255,0.06)'}; border:1px solid ${mine ? 'rgba(45,214,255,0.35)' : 'rgba(255,255,255,0.12)'}; border-radius:10px; padding:6px 10px; cursor:pointer;`;
      const nickEl = document.createElement('div');
      nickEl.style.cssText = 'font-size:0.7rem; font-weight:700; color:#8fa0d6;';
      nickEl.textContent = m.nick || '';
      bubble.appendChild(nickEl);
      const textEl = document.createElement('div');
      textEl.style.cssText = 'font-size:0.9rem; word-break:break-word;';
      renderMessageText(textEl, m.text);
      bubble.appendChild(textEl);
      // hora curtinha, sempre visível
      const timeEl = document.createElement('div');
      timeEl.style.cssText = 'font-size:0.6rem; color:#6b76a8; text-align:right; margin-top:2px;';
      timeEl.textContent = formatMsgTime(m.at);
      bubble.appendChild(timeEl);
      // data completa + denunciar — escondidos até clicar na mensagem (ver
      // onclick abaixo); ambos juntos porque os dois só fazem sentido depois
      // que a pessoa já demonstrou interesse "abrindo" a mensagem
      const infoEl = document.createElement('div');
      infoEl.style.cssText = 'display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-top:2px; display:none;';
      const fullDateSpan = document.createElement('span');
      fullDateSpan.style.cssText = 'font-size:0.62rem; color:#8fa0d6;';
      fullDateSpan.textContent = formatMsgFullDateTime(m.at);
      infoEl.appendChild(fullDateSpan);
      if (!mine) {
        const reportBtn = document.createElement('button');
        reportBtn.className = 'link';
        reportBtn.style.cssText = 'padding:0; font-size:0.62rem; color:var(--neon-red); text-decoration:underline;';
        reportBtn.textContent = T[state.lang].guild_chat_report;
        reportBtn.onclick = (ev) => { ev.stopPropagation(); uiReportGuildMessage(m.id, m.nick || ''); };
        infoEl.appendChild(reportBtn);
      }
      bubble.appendChild(infoEl);
      bubble.onclick = () => { infoEl.style.display = infoEl.style.display === 'none' ? 'flex' : 'none'; };
      el.appendChild(bubble);
    });
  }
  el.scrollTop = el.scrollHeight;
}

/* -------- "digitando..." -------- */
let typingUnsub = null;
let typingTickInterval = null;
let typingData = {};
const TYPING_STALE_MS = 6000;
function ensureTypingListener(guildId) {
  if (typingUnsub) return;
  typingUnsub = onSnapshot(doc(db, 'guildTyping', guildId), snap => {
    typingData = (snap.exists() && snap.data()) || {};
    renderTypingIndicators();
  }, () => {});
  typingTickInterval = setInterval(renderTypingIndicators, 2000);
}
function stopTypingListener() {
  if (typingUnsub) { typingUnsub(); typingUnsub = null; }
  if (typingTickInterval) { clearInterval(typingTickInterval); typingTickInterval = null; }
  typingData = {};
}
function renderTypingIndicators() {
  const myUid = state.currentUser && state.currentUser.uid;
  const now = Date.now();
  const names = Object.entries(typingData)
    .filter(([uid, d]) => uid !== myUid && d.at && typeof d.at.toMillis === 'function' && (now - d.at.toMillis()) < TYPING_STALE_MS)
    .map(([, d]) => d.nick)
    .filter(Boolean);
  const text = names.length ? T[state.lang].guild_typing(names.join(', '), names.length) : '';
  [$('guild-chat-typing'), $('guild-chat-popup-typing')].forEach(el => {
    if (!el) return;
    el.textContent = text;
    el.style.display = text ? '' : 'none';
  });
}
// no máximo 1 aviso a cada ~2.5s enquanto a pessoa digita — chamado a cada
// tecla, mas o debounce evita spammar a function (ver setGuildTyping)
let lastTypingPingAt = 0;
function pingTyping() {
  const now = Date.now();
  if (now - lastTypingPingAt < 2500) return;
  lastTypingPingAt = now;
  callSetGuildTyping().catch(() => {});
}

/* -------- @menção -------- */
// nicks dos membros do clã atual, pra sugerir ao digitar "@" — reaproveita
// currentGuildData quando já carregado (dentro da tela do clã) ou busca uma
// vez só (getDoc simples, não listener) quando o chat abre de fora dela
// (balão flutuante nas outras telas)
let guildMemberNicks = [];
let guildMemberNicksGuildId = null;
async function ensureGuildMemberNicksCache(guildId) {
  if (guildMemberNicksGuildId === guildId && guildMemberNicks.length) return;
  if (currentGuildData && currentGuildData.id === guildId && currentGuildData.members) {
    guildMemberNicks = Object.entries(currentGuildData.members).map(([uid, d]) => ({ uid, nick: d.nick || '' }));
    guildMemberNicksGuildId = guildId;
    return;
  }
  try {
    const snap = await getDoc(doc(db, 'guilds', guildId));
    if (snap.exists()) {
      guildMemberNicks = Object.entries(snap.data().members || {}).map(([uid, d]) => ({ uid, nick: d.nick || '' }));
      guildMemberNicksGuildId = guildId;
    }
  } catch { /* melhor esforço — sem sugestão de @menção não quebra o chat */ }
}
// chamada a cada tecla no campo do chat — dispara o aviso de "digitando" E
// checa se dá pra sugerir uma @menção agora
window.handleGuildChatInput = (inputEl, suggestBoxId) => {
  if (inputEl.value.trim()) pingTyping();
  handleMentionInput(inputEl, suggestBoxId);
};
function handleMentionInput(inputEl, suggestBoxId) {
  const box = $(suggestBoxId);
  if (!box) return;
  const val = inputEl.value;
  const cursor = inputEl.selectionStart;
  const beforeCursor = val.slice(0, cursor);
  const match = beforeCursor.match(/(?:^|\s)@(\S*)$/);
  if (!match) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const partial = match[1].toLowerCase();
  const myUid = state.currentUser && state.currentUser.uid;
  const matches = guildMemberNicks.filter(m => m.uid !== myUid && m.nick.toLowerCase().startsWith(partial)).slice(0, 5);
  if (!matches.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.innerHTML = '';
  box.style.display = '';
  matches.forEach(m => {
    const item = document.createElement('div');
    item.className = 'chat-mention-suggestion';
    item.textContent = `@${m.nick}`;
    item.onclick = () => {
      const newBefore = beforeCursor.replace(/@(\S*)$/, `@${m.nick} `);
      inputEl.value = newBefore + val.slice(cursor);
      inputEl.focus();
      const pos = newBefore.length;
      inputEl.setSelectionRange(pos, pos);
      box.style.display = 'none';
      box.innerHTML = '';
    };
    box.appendChild(item);
  });
}

window.sendGuildChatMessage = async () => {
  const input = $('guild-chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try { await callSendGuildMessage({ text }); } catch (e) { /* melhor esforço — a mensagem só some da caixa se falhar mesmo */ }
};

// denunciar mensagem usa a popup temática #report-guild-message-modal em vez
// do confirm() genérico do navegador — mesmo padrão de #disband-guild-modal.
// guarda messageId/guildId aqui (não dá pra passar direto no onclick do botão
// "Confirmar", que é HTML estático) — reportMsgState só existe entre abrir e
// fechar a popup, nunca fica velho porque cada abertura sobrescreve o anterior
let reportMsgState = null;
function uiReportGuildMessage(messageId, authorNick) {
  if (!currentChatGuildId) return;
  reportMsgState = { messageId, guildId: currentChatGuildId };
  $('report-guild-message-text').textContent = T[state.lang].guild_confirm_report(authorNick);
  $('report-guild-message-modal').style.display = 'flex';
}
window.closeReportGuildMessageModal = () => {
  $('report-guild-message-modal').style.display = 'none';
  reportMsgState = null;
};
window.confirmReportGuildMessage = async () => {
  if (!reportMsgState) return;
  const { messageId, guildId } = reportMsgState;
  closeReportGuildMessageModal();
  try {
    await callReportGuildMessage({ guildId, messageId });
    alert(T[state.lang].guild_report_sent);
  } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
};

/* -------- balãozinho flutuante (tipo o chat do Messenger) -------- */
// telas "principais" do jogo — fora de partida/duelo, onde o balão pode
// ficar por cima sem atrapalhar. Fora dessa lista, o balão some sozinho.
const GUILD_CHAT_BUBBLE_SCREENS = new Set([
  'menu-screen', 'shop-screen', 'ranking-screen', 'replay-screen',
  'profile-screen', 'friends-screen', 'guild-list-screen',
]);
let guildChatPopupOpen = false;

// "visto por último" é só local (localStorage), por conta — não precisa de
// servidor pra isso, é puramente "já espiei essa conversa nesse aparelho"
function guildChatStorageKey(guildId) { return `guildChatLastRead_${guildId}`; }
function loadLastReadChatAt(guildId) {
  try { return parseInt(localStorage.getItem(guildChatStorageKey(guildId)) || '0', 10); } catch { return 0; }
}
function markChatRead(guildId) {
  try { localStorage.setItem(guildChatStorageKey(guildId), String(Date.now())); } catch {}
  updateChatBubbleBadge(guildId);
}
function updateChatBubbleBadge(guildId) {
  const badge = $('guild-chat-bubble-badge');
  if (!badge) return;
  const lastRead = loadLastReadChatAt(guildId);
  const myUid = state.currentUser && state.currentUser.uid;
  const unread = chatMessages.filter(m => m.uid !== myUid && m.at && typeof m.at.toMillis === 'function' && m.at.toMillis() > lastRead).length;
  badge.textContent = unread;
  badge.style.display = (unread > 0 && !guildChatPopupOpen) ? '' : 'none';
}

// chamada sempre que a tela ativa muda (ver MutationObserver no fim do
// arquivo) — decide se o balão aparece e liga/desliga o listener de fundo
function refreshGuildChatBubble() {
  const bubble = $('guild-chat-bubble');
  if (!bubble) return;
  const active = document.querySelector('.screen.active');
  const eligible = !!(active && GUILD_CHAT_BUBBLE_SCREENS.has(active.id) && !state.offline && state.currentUser && state.myData.guildId);
  bubble.style.display = eligible ? 'flex' : 'none';
  if (eligible) {
    ensureChatListener(state.myData.guildId);
    updateChatBubbleBadge(state.myData.guildId);
  } else {
    if (guildChatPopupOpen) window.toggleGuildChatPopup();
  }
}

window.toggleGuildChatPopup = () => {
  guildChatPopupOpen = !guildChatPopupOpen;
  const popup = $('guild-chat-popup');
  popup.style.display = guildChatPopupOpen ? 'flex' : 'none';
  if (guildChatPopupOpen && state.myData.guildId) {
    $('guild-chat-popup-title').textContent = state.myData.guildTag ? `💬 [${state.myData.guildTag}]` : '💬';
    ensureChatListener(state.myData.guildId);
    renderChatMessages('guild-chat-popup-messages');
    renderTypingIndicators();
    markChatRead(state.myData.guildId);
  } else {
    updateChatBubbleBadge(state.myData.guildId);
  }
};

window.sendGuildChatPopupMessage = async () => {
  const input = $('guild-chat-popup-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try { await callSendGuildMessage({ text }); } catch (e) { /* melhor esforço */ }
};

// observa a troca da classe "active" em qualquer .screen (é assim que
// show(), em js/nav.js, navega entre telas) — um MutationObserver evita
// precisar que nav.js importe algo daqui (guilds.js já importa de nav.js;
// o caminho inverso criaria um ciclo de import)
function setupGuildChatBubbleWatcher() {
  const observer = new MutationObserver(() => refreshGuildChatBubble());
  document.querySelectorAll('.screen').forEach(s => observer.observe(s, { attributes: true, attributeFilter: ['class'] }));
}
setupGuildChatBubbleWatcher();

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
// eu lidero o clã que estou? só usado pra decidir se mostra o botão
// "convidar pro clã" no perfil de outra pessoa (ver renderGuildInviteAction
// abaixo) — não reaproveita currentGuildData porque essa variável só existe
// se a pessoa já abriu a TELA do próprio clã nesta sessão; o perfil pode ser
// aberto de qualquer lugar (ranking, amigos etc.), então lê o doc direto
async function amIGuildLeader() {
  const myUid = state.currentUser && state.currentUser.uid;
  const guildId = state.myData.guildId;
  if (!myUid || !guildId) return false;
  try {
    const snap = await getDoc(doc(db, 'guilds', guildId));
    return snap.exists() && snap.data().leaderUid === myUid;
  } catch { return false; }
}

// botão "convidar pro clã" no perfil de outra pessoa — substitui o campo de
// digitar nick que existia na tela do clã (ver comentário acima de
// joinRequestsSection). Só aparece pra quem lidera um clã. Chamada por
// js/profile.js via window (perfil ainda não conhece o domínio de clãs,
// mesmo padrão de window.openGuildFromTag/window.fetchMyFriends)
window.renderGuildInviteAction = async (theirUid, theirNick, theirGuildId) => {
  const el = $('profile-guild-invite-action');
  if (!el) return;
  el.innerHTML = '';
  if (!theirNick || (state.currentUser && theirUid === state.currentUser.uid)) return;
  if (theirGuildId) return; // já está em um clã (o meu ou outro) -- não dá pra convidar
  const isLeader = await amIGuildLeader();
  if (!isLeader) return;
  // sem .card ao redor (aquela borda roxa) — é só o botão sozinho, sem caixa.
  // margin-top negativo pra compensar o gap:12px do flex (.card) + o
  // #profile-friend-status vazio entre esse botão e os de cima (chat/amigo),
  // que juntos deixavam uma folga grande demais só pra esse botão secundário
  const wrap = document.createElement('div');
  wrap.style.cssText = 'text-align:center; margin-top:-14px;';
  const btn = document.createElement('button');
  btn.textContent = T[state.lang].guild_btn_invite;
  // botão bem menor que o padrão (que ocupa o card inteiro) — é uma ação
  // secundária no perfil de outra pessoa, não precisa do mesmo destaque dos
  // botões principais (adicionar amigo, iniciar chat etc.)
  btn.style.cssText = 'padding:6px 16px; font-size:0.75rem;';
  const statusEl = document.createElement('div');
  statusEl.className = 'muted';
  statusEl.style.marginTop = '6px';
  btn.onclick = async () => {
    btn.disabled = true;
    statusEl.textContent = '';
    try {
      await callInviteGuildMember({ nick: theirNick });
      statusEl.textContent = T[state.lang].guild_invite_sent_ok;
    } catch (e) {
      statusEl.textContent = (e && e.message) || T[state.lang].guild_err_generic;
      btn.disabled = false;
    }
  };
  wrap.appendChild(btn);
  wrap.appendChild(statusEl);
  el.appendChild(wrap);
};
async function uiCancelGuildInvite(uid) {
  try { await callCancelGuildInvite({ uid }); } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
}
window.respondGuildInvite = async (accept) => {
  try {
    const res = await callRespondGuildInvite({ accept });
    state.myData.pendingGuildInvite = null;
    if (accept && res.data && res.data.accepted) {
      // já estamos vendo a tela desse clã (só dá pra aceitar de dentro
      // dela) — o listener ao vivo do próprio clã vai atualizar sozinho,
      // isso aqui só garante que o resto do app (menu etc.) saiba na hora
      state.myData.guildId = currentGuildId;
    }
  } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
};
window.uiLeaveGuild = async () => {
  try {
    await callLeaveGuild();
    state.myData.guildId = null;
    state.myData.guildTag = null;
    stopGuildListeners();
    window.showGuildList();
  } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
};
// popup de ações do líder sobre um membro (tornar líder / expulsar), aberta
// ao clicar na linha do membro (ver memberRow acima). guarda uid/nick aqui
// (não dá pra passar direto no onclick dos botões, que são HTML estático) —
// mesmo padrão de reportMsgState mais abaixo, só existe entre abrir e fechar
let guildMemberActionsState = null;
function openGuildMemberActionsModal(uid, nick) {
  guildMemberActionsState = { uid, nick };
  $('guild-member-actions-nick').textContent = nick;
  $('guild-member-actions-modal').style.display = 'flex';
}
window.closeGuildMemberActionsModal = () => {
  $('guild-member-actions-modal').style.display = 'none';
  guildMemberActionsState = null;
};
// tornar líder e expulsar usam popup temática de confirmação (mesmo padrão
// de #disband-guild-modal) em vez do confirm() genérico do navegador. Abrem
// depois de fechar a popup de ações acima (não dá pra ter as duas abertas
// ao mesmo tempo)
let guildTransferState = null;
window.uiInitiateGuildTransferFromModal = () => {
  if (!guildMemberActionsState) return;
  const { uid, nick } = guildMemberActionsState;
  closeGuildMemberActionsModal();
  guildTransferState = { uid };
  $('guild-transfer-confirm-text').textContent = T[state.lang].guild_confirm_transfer(nick);
  $('guild-transfer-confirm-modal').style.display = 'flex';
};
window.closeGuildTransferConfirmModal = () => {
  $('guild-transfer-confirm-modal').style.display = 'none';
  guildTransferState = null;
};
window.confirmGuildTransferMember = async () => {
  if (!guildTransferState) return;
  const { uid } = guildTransferState;
  closeGuildTransferConfirmModal();
  try { await callInitiateGuildLeaderTransfer({ toUid: uid }); } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
};
let guildKickState = null;
window.uiKickGuildMemberFromModal = () => {
  if (!guildMemberActionsState) return;
  const { uid, nick } = guildMemberActionsState;
  closeGuildMemberActionsModal();
  guildKickState = { uid };
  $('guild-kick-confirm-text').textContent = T[state.lang].guild_confirm_kick(nick);
  $('guild-kick-confirm-modal').style.display = 'flex';
};
window.closeGuildKickConfirmModal = () => {
  $('guild-kick-confirm-modal').style.display = 'none';
  guildKickState = null;
};
window.confirmGuildKickMember = async () => {
  if (!guildKickState) return;
  const { uid } = guildKickState;
  closeGuildKickConfirmModal();
  try { await callKickGuildMember({ uid }); } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
};
window.respondGuildTransfer = async (accept) => {
  try { await callRespondGuildLeaderTransfer({ accept }); } catch (e) { alert((e && e.message) || T[state.lang].guild_err_generic); }
};
// desfazer clã é destrutivo/irreversível, então usa a popup temática
// #disband-guild-modal em vez do confirm() genérico do navegador — mesmo
// padrão de #delete-account-modal (ver startDeleteMyAccount em js/auth.js)
window.uiDisbandGuild = () => {
  $('disband-guild-modal').style.display = 'flex';
};
window.closeDisbandGuildModal = () => {
  $('disband-guild-modal').style.display = 'none';
};
window.confirmDisbandGuild = async () => {
  closeDisbandGuildModal();
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
      tagSpan.style.cssText = 'font-family:\'Orbitron\',sans-serif; font-weight:800; color:#fff;';
      applyGuildTagStyle(tagSpan, g.tagStyle);
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
  if (state.offline || !state.currentUser) { badge.style.display = 'none'; return; }
  // convite de clã pendente (recebido) conta mesmo sem estar em nenhum clã
  // ainda — é justamente o que precisa de resposta
  if (!state.myData.guildId) {
    const n = state.myData.pendingGuildInvite ? 1 : 0;
    badge.textContent = n;
    badge.style.display = n > 0 ? '' : 'none';
    return;
  }
  try {
    const snap = await getDoc(doc(db, 'guilds', state.myData.guildId));
    if (!snap.exists()) { badge.style.display = 'none'; return; }
    const g = snap.data();
    const myUid = state.currentUser.uid;
    let n = 0;
    if (g.pendingTransferToUid === myUid) n += 1;
    if (g.leaderUid === myUid) {
      // convites que a própria líder mandou não entram na contagem — ela já
      // sabe que mandou, isso aqui é só pra avisar de coisa NOVA esperando
      const reqSnap = await getDoc(doc(db, 'guildJoinRequests', state.myData.guildId));
      n += Object.keys((reqSnap.exists() && reqSnap.data().incoming) || {}).length;
    }
    badge.textContent = n;
    badge.style.display = n > 0 ? '' : 'none';
  } catch (e) {
    badge.style.display = 'none';
  }
}
