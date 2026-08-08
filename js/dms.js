import {
  doc, getDoc, collection, query, where, orderBy, limit, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db, callable } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { formatMsgTime, formatMsgFullDateTime } from './utils.js';
import { fetchMyFriends, openProfileByUid } from './friends.js';
import { lvChip, applyWeeklyPassNickColor } from './levels.js';

// mensagens diretas entre amigos — balãozinho flutuante igual ao do clã (ver
// js/guilds.js), só que 1-pra-1: abre na lista de amigos (bolinha verde =
// online), clicar num amigo abre a conversa com ele. Nenhuma escrita direta
// do navegador (sempre via Cloud Function, ver functions/index.js).
const callSendDirectMessage = callable('sendDirectMessage');
const callMarkDmRead = callable('markDmRead');
const callSetDmTyping = callable('setDmTyping');
const callReportDirectMessage = callable('reportDirectMessage');

function dmChatIdFor(a, b) { return [a, b].sort().join('_'); }

let dmPopupOpen = false;
let dmView = 'list'; // 'list' | 'chat'
let activeFriendUid = null;
let activeChatId = null;
// balãozinho ÚNICO (amigos + clã, ver comentário grande no HTML) -- qual das
// duas conversas está visível dentro da mesma janela agora
let chatPopupTab = 'friends'; // 'friends' | 'guild'

let dmSummaryUnsub = null;
let dmSummaries = {}; // chatId -> { members, nicks, unread, lastMessageAt, lastMessageText }
let dmChatUnsub = null;
let dmMessages = [];

// escuta TODAS as minhas conversas de uma vez (query array-contains-like via
// "members.<meuUid> == true") — dá o total de não lidas pro balãozinho e o
// pontinho vermelho por amigo na lista, sem precisar abrir cada conversa
function ensureDmSummaryListener() {
  if (dmSummaryUnsub || state.offline || !state.currentUser) return;
  const myUid = state.currentUser.uid;
  const q = query(collection(db, 'dms'), where(`members.${myUid}`, '==', true));
  dmSummaryUnsub = onSnapshot(q, snap => {
    dmSummaries = {};
    snap.forEach(d => { dmSummaries[d.id] = d.data(); });
    updateDmBubbleBadge();
    if (dmPopupOpen && dmView === 'list') renderDmFriendsList();
    // reforço: se a conversa aberta agora tem uma linha de resumo mas o
    // listener de mensagens dela ainda não trouxe nada, é bem provável que
    // seja a 1ª mensagem de uma conversa nova cujo listener foi assinado
    // ANTES do doc dms/{chatId} existir (ver ensureDmChatListener/
    // sendDirectMessage) — reabre o listener agora que o doc já existe de
    // verdade, em vez de deixar a pessoa sem ver a própria mensagem até
    // fechar e abrir a conversa de novo
    if (dmPopupOpen && dmView === 'chat' && activeChatId && dmSummaries[activeChatId] && dmMessages.length === 0) {
      ensureDmChatListener(activeChatId);
    }
  }, () => {});
}

function updateDmBubbleBadge() {
  const tabBadge = $('chat-tab-friends-badge');
  const myUid = state.currentUser && state.currentUser.uid;
  let unread = 0;
  if (myUid) Object.values(dmSummaries).forEach(s => { unread += (s.unread && s.unread[myUid]) || 0; });
  const friendsPaneVisible = dmPopupOpen && chatPopupTab === 'friends';
  if (tabBadge) {
    tabBadge.textContent = unread;
    tabBadge.style.display = (unread > 0 && !friendsPaneVisible) ? '' : 'none';
  }
  refreshCombinedChatBadge();
}

// bolinha do balão em si = soma das duas abas (amigos + clã) — chamada tanto
// daqui quanto de updateChatBubbleBadge em js/guilds.js (via window, já que
// a contagem de cada aba é calculada em módulos diferentes); lê o texto já
// escrito nas duas bolinhas de aba em vez de duplicar a conta de não lidas
// de cada uma
function refreshCombinedChatBadge() {
  const badge = $('dm-chat-bubble-badge');
  if (!badge) return;
  const dmUnread = parseInt(($('chat-tab-friends-badge') && $('chat-tab-friends-badge').textContent) || '0', 10) || 0;
  const guildUnread = parseInt(($('chat-tab-guild-badge') && $('chat-tab-guild-badge').textContent) || '0', 10) || 0;
  const total = dmUnread + guildUnread;
  badge.textContent = total;
  badge.style.display = (total > 0 && !dmPopupOpen) ? '' : 'none';
}
window.refreshCombinedChatBadge = refreshCombinedChatBadge;

// "online" é aproximado a partir de lastActiveAt (batimento a cada ~5min
// enquanto a aba fica aberta, ver startActivityHeartbeat em js/auth.js) —
// não é presença em tempo real, mas dá pra saber se a pessoa usou o jogo há
// pouco. scores/{uid} é público (ver firestore.rules), então dá pra ler
// direto sem passar por Cloud Function; feito na hora (não usa o cache de
// 5min de fetchAllScores) pra bolinha ficar o mais atual possível.
const DM_ONLINE_THRESHOLD_MS = 6 * 60 * 1000;

async function renderDmFriendsList() {
  const el = $('dm-chat-list-view');
  if (!el) return;
  el.innerHTML = `<div class="muted" style="text-align:center; padding:14px;">${T[state.lang].loading_text}</div>`;
  const friends = await fetchMyFriends();
  const entries = Object.entries(friends);
  if (dmView !== 'list') return; // trocou de aba enquanto isso carregava
  if (!entries.length) {
    el.innerHTML = `<div class="muted" style="text-align:center; padding:14px;">${T[state.lang].dm_chat_empty_friends}</div>`;
    return;
  }
  // aproveita a mesma leitura de scores/{uid} (já feita pra saber quem está
  // online) pra trazer nível e admin também, sem gerar leitura extra —
  // usados no chip de nível e no botão de desafiar (ver dmFriendRow abaixo)
  const results = await Promise.all(entries.map(async ([uid]) => {
    try {
      const snap = await getDoc(doc(db, 'scores', uid));
      const data = snap.exists() ? snap.data() : {};
      // quem ativou "ficar invisível" no próprio perfil (ver
      // toggleHideOnlineStatus em js/profile.js) nunca aparece com a
      // bolinha verde aqui, mesmo se estiver de fato ativo agora
      const lastActiveAt = data.lastActiveAt && typeof data.lastActiveAt.toMillis === 'function' ? data.lastActiveAt.toMillis() : 0;
      const online = data.hideOnlineStatus !== true && (Date.now() - lastActiveAt) < DM_ONLINE_THRESHOLD_MS;
      return { online, xp: data.xp || 0, admin: data.admin === true, weeklyPassExpiresAt: data.weeklyPassExpiresAt || null };
    } catch { return { online: false, xp: 0, admin: false, weeklyPassExpiresAt: null }; }
  }));
  if (dmView !== 'list') return;
  // online primeiro, depois ordem alfabética dentro de cada grupo
  const rows = entries.map(([uid, data], i) => ({ uid, nick: data.nick || '', ...results[i] }));
  rows.sort((a, b) => (b.online - a.online) || a.nick.localeCompare(b.nick));
  el.innerHTML = '';
  rows.forEach(r => el.appendChild(dmFriendRow(r.uid, r.nick, r.online, r.xp, r.admin, r.weeklyPassExpiresAt)));
}

function dmFriendRow(uid, nick, online, xp, isAdmin, weeklyPassExpiresAt) {
  const row = document.createElement('div');
  row.className = 'dm-friend-row';
  const dot = document.createElement('span');
  dot.className = 'dm-online-dot' + (online ? ' online' : '');
  row.appendChild(dot);
  row.insertAdjacentHTML('beforeend', lvChip(xp || 0)); // nível, mesmo padrão de friendRow em js/friends.js
  const nickSpan = document.createElement('span');
  nickSpan.className = 'nick';
  nickSpan.textContent = nick;
  applyWeeklyPassNickColor(nickSpan, { weeklyPassExpiresAt });
  row.appendChild(nickSpan);
  const chatId = dmChatIdFor(state.currentUser.uid, uid);
  const summary = dmSummaries[chatId];
  const unread = summary && summary.unread && summary.unread[state.currentUser.uid];
  if (unread > 0) {
    const unreadDot = document.createElement('span');
    unreadDot.className = 'dm-unread-dot';
    row.appendChild(unreadDot);
  }
  // desafiar pro duelo — só pra quem está online agora (não faz sentido
  // desafiar alguém offline pra uma partida ao vivo). Ícone só, bem pequeno;
  // reaproveita window.openChallengeModeModal (js/pvp.js), mesma function
  // chamada pelo botão "⚔️ Desafiar" da tela de amigos (ver friendRow em
  // js/friends.js)
  if (online) {
    const challengeBtn = document.createElement('button');
    challengeBtn.className = 'secondary';
    challengeBtn.textContent = '⚔️';
    challengeBtn.title = T[state.lang].btn_challenge;
    challengeBtn.style.cssText = 'padding:2px 5px; font-size:0.65rem; line-height:1; flex-shrink:0;';
    challengeBtn.onclick = (ev) => { ev.stopPropagation(); window.openChallengeModeModal(uid, nick, xp || 0, isAdmin === true); };
    row.appendChild(challengeBtn);
  }
  row.onclick = () => openDmConversation(uid, nick);
  return row;
}

function ensureDmChatListener(chatId) {
  if (dmChatUnsub) { dmChatUnsub(); dmChatUnsub = null; }
  dmMessages = [];
  const q = query(collection(db, 'dms', chatId, 'messages'), orderBy('at', 'desc'), limit(50));
  dmChatUnsub = onSnapshot(q, snap => {
    dmMessages = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
    if (dmPopupOpen && dmView === 'chat' && activeChatId === chatId) renderDmMessages();
  }, () => {});
}

/* -------- "digitando..." (mesmo padrão do chat de clã, ver
   ensureTypingListener/pingTyping em js/guilds.js), só que por conversa
   (dmTyping/{chatId}) em vez de por clã -------- */
let dmTypingUnsub = null;
let dmTypingTickInterval = null;
let dmTypingData = {};
const DM_TYPING_STALE_MS = 6000;
function ensureDmTypingListener(chatId) {
  if (dmTypingUnsub) { dmTypingUnsub(); dmTypingUnsub = null; }
  dmTypingData = {};
  dmTypingUnsub = onSnapshot(doc(db, 'dmTyping', chatId), snap => {
    dmTypingData = (snap.exists() && snap.data()) || {};
    renderDmTypingIndicator();
  }, () => {});
  if (!dmTypingTickInterval) dmTypingTickInterval = setInterval(renderDmTypingIndicator, 2000);
}
function stopDmTypingListener() {
  if (dmTypingUnsub) { dmTypingUnsub(); dmTypingUnsub = null; }
  if (dmTypingTickInterval) { clearInterval(dmTypingTickInterval); dmTypingTickInterval = null; }
  dmTypingData = {};
}
function renderDmTypingIndicator() {
  const el = $('dm-chat-typing');
  if (!el) return;
  const entry = activeFriendUid && dmTypingData[activeFriendUid];
  const isTyping = !!(entry && entry.at && typeof entry.at.toMillis === 'function' && (Date.now() - entry.at.toMillis()) < DM_TYPING_STALE_MS);
  el.textContent = isTyping ? T[state.lang].dm_typing(entry.nick || '') : '';
  el.style.display = isTyping ? '' : 'none';
}
// no máximo 1 aviso a cada ~2.5s enquanto a pessoa digita — chamado a cada
// tecla, mas o debounce evita spammar a function (ver setDmTyping)
let lastDmTypingPingAt = 0;
window.pingDmTyping = (inputEl) => {
  if (!inputEl.value.trim() || !activeFriendUid) return;
  const now = Date.now();
  if (now - lastDmTypingPingAt < 2500) return;
  lastDmTypingPingAt = now;
  callSetDmTyping({ toUid: activeFriendUid }).catch(() => {});
};

// bolha de mensagem — mesmo padrão visual do chat de clã (ver
// renderChatMessages em js/guilds.js): hora curtinha sempre visível, clicar
// na mensagem expande a data completa (sem repetir a hora, ver
// formatMsgFullDateTime em js/utils.js) + o botão de denunciar (só nas
// mensagens da outra pessoa, nunca nas próprias)
function renderDmMessages() {
  const el = $('dm-chat-messages');
  if (!el) return;
  const myUid = state.currentUser && state.currentUser.uid;
  el.innerHTML = '';
  if (!dmMessages.length) {
    el.innerHTML = `<div class="muted" style="text-align:center;">${T[state.lang].dm_chat_no_messages}</div>`;
  } else {
    dmMessages.forEach(m => {
      const bubble = document.createElement('div');
      const mine = m.uid === myUid;
      bubble.style.cssText = `align-self:${mine ? 'flex-end' : 'flex-start'}; max-width:80%; background:${mine ? 'rgba(45,214,255,0.12)' : 'rgba(255,255,255,0.06)'}; border:1px solid ${mine ? 'rgba(45,214,255,0.35)' : 'rgba(255,255,255,0.12)'}; border-radius:10px; padding:6px 10px; cursor:pointer;`;
      const textEl = document.createElement('div');
      textEl.style.cssText = 'font-size:0.9rem; word-break:break-word;';
      textEl.textContent = m.text || '';
      bubble.appendChild(textEl);
      const timeEl = document.createElement('div');
      timeEl.style.cssText = 'font-size:0.6rem; color:#6b76a8; text-align:right; margin-top:2px;';
      timeEl.textContent = formatMsgTime(m.at);
      bubble.appendChild(timeEl);
      // data completa + denunciar — escondidos até clicar na mensagem, mesmo
      // padrão do chat de clã (ver renderChatMessages em js/guilds.js)
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
        reportBtn.onclick = (ev) => { ev.stopPropagation(); uiReportDmMessage(m.id, m.nick || ''); };
        infoEl.appendChild(reportBtn);
      }
      bubble.appendChild(infoEl);
      bubble.onclick = () => { infoEl.style.display = infoEl.style.display === 'none' ? 'flex' : 'none'; };
      el.appendChild(bubble);
    });
  }
  el.scrollTop = el.scrollHeight;
}

// denunciar mensagem direta usa a mesma popup temática do chat de clã (ver
// #report-guild-message-modal em js/guilds.js), só que sua própria instância
// (#report-dm-message-modal) — guarda messageId/chatId aqui até a pessoa
// confirmar ou cancelar, mesmo padrão de reportMsgState em js/guilds.js
let reportDmMsgState = null;
function uiReportDmMessage(messageId, authorNick) {
  if (!activeChatId) return;
  reportDmMsgState = { messageId, chatId: activeChatId };
  $('report-dm-message-text').textContent = T[state.lang].guild_confirm_report(authorNick);
  $('report-dm-message-modal').style.display = 'flex';
}
window.closeReportDmMessageModal = () => {
  $('report-dm-message-modal').style.display = 'none';
  reportDmMsgState = null;
};
window.confirmReportDmMessage = async () => {
  if (!reportDmMsgState) return;
  const { messageId, chatId } = reportDmMsgState;
  closeReportDmMessageModal();
  try {
    await callReportDirectMessage({ chatId, messageId });
    alert(T[state.lang].guild_report_sent);
  } catch (e) { alert((e && e.message) || T[state.lang].friend_action_error); }
};

function openDmConversation(uid, nick) {
  activeFriendUid = uid;
  activeChatId = dmChatIdFor(state.currentUser.uid, uid);
  dmView = 'chat';
  setDmChatTitle(uid, nick);
  updateChatPopupHead();
  $('dm-chat-list-view').style.display = 'none';
  $('dm-chat-conversation-view').style.display = 'flex';
  ensureDmChatListener(activeChatId);
  ensureDmTypingListener(activeChatId);
  renderDmMessages();
  markDmChatRead();
}

// título da conversa: nível + nick clicável (abre o perfil da pessoa) — só
// recebemos uid/nick de quem chama (dmFriendRow / window.openDmChatWithFriend),
// então o nível vem de uma leitura avulsa em scores/{uid} (doc público, mesmo
// padrão de renderDmFriendsList acima). Nick aparece na hora com o textContent
// simples; o chip de nível é trocado depois que a leitura resolver.
async function setDmChatTitle(uid, nick) {
  const el = $('dm-chat-popup-title');
  el.textContent = nick;
  let xp = 0;
  let weeklyPassExpiresAt = null;
  try {
    const snap = await getDoc(doc(db, 'scores', uid));
    const data = snap.exists() ? snap.data() : {};
    xp = data.xp || 0;
    weeklyPassExpiresAt = data.weeklyPassExpiresAt || null;
  } catch {}
  if (activeFriendUid !== uid || dmView !== 'chat') return; // trocou de conversa enquanto isso carregava
  el.innerHTML = '';
  el.insertAdjacentHTML('beforeend', lvChip(xp));
  const nickSpan = document.createElement('span');
  nickSpan.className = 'nick-click';
  nickSpan.style.marginLeft = '6px';
  nickSpan.textContent = nick;
  nickSpan.onclick = () => openProfileByUid(uid, nick, 'friends-screen');
  applyWeeklyPassNickColor(nickSpan, { weeklyPassExpiresAt });
  el.appendChild(nickSpan);
}

async function markDmChatRead() {
  if (!activeChatId) return;
  const chatId = activeChatId;
  // otimista: zera local na hora (sem esperar o servidor), pro pontinho
  // vermelho da lista sumir assim que a pessoa abre a conversa
  if (dmSummaries[chatId]) {
    const myUid = state.currentUser.uid;
    dmSummaries[chatId] = { ...dmSummaries[chatId], unread: { ...dmSummaries[chatId].unread, [myUid]: 0 } };
    updateDmBubbleBadge();
  }
  try { await callMarkDmRead({ chatId }); } catch {}
}

// alterna entre as abas Amigos/Clã dentro da MESMA janela — as duas
// conversas coexistem (o listener de cada uma continua rodando mesmo com a
// aba não visível, ver refreshDmChatBubble/refreshGuildChatBubble abaixo),
// isso aqui só troca qual pane está desenhado e marca como lida a que ficou
// visível
window.setChatPopupTab = (tab) => {
  if (tab === chatPopupTab) return;
  chatPopupTab = tab;
  setChatPopupPane(tab);
  updateChatPopupHead();
  if (tab === 'guild') {
    if (window.openGuildChatPane) window.openGuildChatPane();
  } else if (dmView === 'chat') {
    markDmChatRead();
  } else {
    updateDmBubbleBadge();
  }
};

// desenha o pane certo (amigos ou clã) -- separado de setChatPopupTab pra
// também ser chamado na abertura do balão (sempre volta pra aba amigos, ver
// toggleDmChatPopup) sem disparar a lógica de "marcar como lida" de novo
function setChatPopupPane(tab) {
  $('chat-popup-tab-friends').classList.toggle('active', tab === 'friends');
  $('chat-popup-tab-guild').classList.toggle('active', tab === 'guild');
  $('chat-popup-pane-friends').style.display = tab === 'friends' ? 'flex' : 'none';
  $('chat-popup-pane-guild').style.display = tab === 'guild' ? 'flex' : 'none';
  const hasGuild = !!state.myData.guildId;
  $('chat-popup-guild-empty').style.display = (tab === 'guild' && !hasGuild) ? '' : 'none';
  $('guild-chat-pane-content').style.display = (tab === 'guild' && hasGuild) ? 'flex' : 'none';
}

// abas (Amigos/Clã) OU título de conversa (voltar + nick) no cabeçalho —
// nunca os dois ao mesmo tempo, só um cabe no espaço do balãozinho
function updateChatPopupHead() {
  const inConversation = chatPopupTab === 'friends' && dmView === 'chat';
  $('chat-popup-tabs').style.display = inConversation ? 'none' : 'flex';
  $('dm-chat-conversation-title-wrap').style.display = inConversation ? 'flex' : 'none';
}

window.toggleDmChatPopup = () => {
  dmPopupOpen = !dmPopupOpen;
  const popup = $('dm-chat-popup');
  popup.style.display = dmPopupOpen ? 'flex' : 'none';
  if (dmPopupOpen) {
    chatPopupTab = 'friends'; // sempre abre pela aba de amigos, mesmo padrão de antes
    dmView = 'list';
    activeFriendUid = null;
    activeChatId = null;
    $('dm-chat-list-view').style.display = 'flex';
    $('dm-chat-conversation-view').style.display = 'none';
    setChatPopupPane('friends');
    updateChatPopupHead();
    ensureDmSummaryListener();
    renderDmFriendsList();
    updateDmBubbleBadge();
  } else {
    if (dmChatUnsub) { dmChatUnsub(); dmChatUnsub = null; }
    stopDmTypingListener();
    updateDmBubbleBadge();
  }
};

window.backToDmFriendsList = () => {
  dmView = 'list';
  activeFriendUid = null;
  activeChatId = null;
  if (dmChatUnsub) { dmChatUnsub(); dmChatUnsub = null; }
  stopDmTypingListener();
  updateChatPopupHead();
  $('dm-chat-conversation-view').style.display = 'none';
  $('dm-chat-list-view').style.display = 'flex';
  renderDmFriendsList();
};

window.sendDmChatMessage = async () => {
  const input = $('dm-chat-input');
  const text = input.value.trim();
  if (!text || !activeFriendUid) return;
  input.value = '';
  try { await callSendDirectMessage({ toUid: activeFriendUid, text }); } catch (e) { /* melhor esforço, igual ao chat de clã */ }
};

// abre o balãozinho já direto na conversa com alguém — chamado pelo botão
// "iniciar chat" no perfil de um amigo (ver friendActionNode em
// js/friends.js, exposta via window porque o perfil ainda não conhece o
// domínio de DMs, mesmo padrão de window.openGuildFromTag)
window.openDmChatWithFriend = (uid, nick) => {
  if (!state.currentUser || state.offline) return;
  if (!dmPopupOpen) {
    dmPopupOpen = true;
    $('dm-chat-popup').style.display = 'flex';
    ensureDmSummaryListener();
  }
  chatPopupTab = 'friends';
  setChatPopupPane('friends');
  openDmConversation(uid, nick);
};

/* -------- balãozinho flutuante ÚNICO (amigos + clã) -------- */
// união das telas em que cada balão aparecia separado antes -- o balão
// mostra a aba de amigos em QUALQUER uma dessas telas, mesmo pra quem não
// tem clã (a aba "Clã" só mostra o aviso de "sem clã" nesse caso, ver
// setChatPopupPane)
const DM_CHAT_BUBBLE_SCREENS = new Set([
  'menu-screen', 'shop-screen', 'ranking-screen', 'replay-screen',
  'profile-screen', 'friends-screen', 'guild-list-screen', 'guild-screen',
]);

function refreshDmChatBubble() {
  const bubble = $('dm-chat-bubble');
  if (!bubble) return;
  const active = document.querySelector('.screen.active');
  const eligible = !!(active && DM_CHAT_BUBBLE_SCREENS.has(active.id) && !state.offline && state.currentUser);
  bubble.style.display = eligible ? 'flex' : 'none';
  if (eligible) {
    ensureDmSummaryListener();
    updateDmBubbleBadge();
  } else if (dmPopupOpen) {
    window.toggleDmChatPopup();
  }
  // garante o listener/badge do clã também, DEPOIS do balão já resolvido
  // acima (chamada explícita em vez de depender de ordem de MutationObserver
  // — ver refreshGuildChatBubble em js/guilds.js)
  if (window.refreshGuildChatBubble) window.refreshGuildChatBubble();
}

// mesmo MutationObserver de refreshGuildChatBubble em js/guilds.js — observa
// a troca da classe "active" em qualquer .screen (é assim que show(), em
// js/nav.js, navega entre telas)
function setupDmChatBubbleWatcher() {
  const observer = new MutationObserver(() => refreshDmChatBubble());
  document.querySelectorAll('.screen').forEach(s => observer.observe(s, { attributes: true, attributeFilter: ['class'] }));
}
setupDmChatBubbleWatcher();

// chamado no logout (ver doLogout em js/auth.js, mesmo padrão de
// window.stopGuildListeners) — sem isso, trocar de conta na mesma aba (sem
// recarregar a página) deixaria o listener de resumo de conversas da conta
// ANTERIOR rodando: ensureDmSummaryListener vê dmSummaryUnsub já setado e
// nunca assina de novo pro uid da conta nova, vazando as conversas de quem
// saiu pra dentro da sessão de quem entrou
window.stopDmListeners = () => {
  if (dmSummaryUnsub) { dmSummaryUnsub(); dmSummaryUnsub = null; }
  if (dmChatUnsub) { dmChatUnsub(); dmChatUnsub = null; }
  stopDmTypingListener();
  dmSummaries = {};
  dmMessages = [];
  activeChatId = null;
  activeFriendUid = null;
  dmPopupOpen = false;
  const popup = $('dm-chat-popup');
  if (popup) popup.style.display = 'none';
};
