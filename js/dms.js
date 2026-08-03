import {
  doc, getDoc, collection, query, where, orderBy, limit, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db, callable } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { formatMsgTime, formatMsgFullDateTime } from './utils.js';
import { fetchMyFriends } from './friends.js';

// mensagens diretas entre amigos — balãozinho flutuante igual ao do clã (ver
// js/guilds.js), só que 1-pra-1: abre na lista de amigos (bolinha verde =
// online), clicar num amigo abre a conversa com ele. Nenhuma escrita direta
// do navegador (sempre via Cloud Function, ver functions/index.js).
const callSendDirectMessage = callable('sendDirectMessage');
const callMarkDmRead = callable('markDmRead');

function dmChatIdFor(a, b) { return [a, b].sort().join('_'); }

let dmPopupOpen = false;
let dmView = 'list'; // 'list' | 'chat'
let activeFriendUid = null;
let activeChatId = null;

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
  }, () => {});
}

function updateDmBubbleBadge() {
  const badge = $('dm-chat-bubble-badge');
  if (!badge) return;
  const myUid = state.currentUser && state.currentUser.uid;
  let unread = 0;
  if (myUid) Object.values(dmSummaries).forEach(s => { unread += (s.unread && s.unread[myUid]) || 0; });
  badge.textContent = unread;
  badge.style.display = (unread > 0 && !dmPopupOpen) ? '' : 'none';
}

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
  entries.sort((a, b) => (a[1].nick || '').localeCompare(b[1].nick || ''));
  const statuses = await Promise.all(entries.map(async ([uid]) => {
    try {
      const snap = await getDoc(doc(db, 'scores', uid));
      const data = snap.exists() ? snap.data() : {};
      const lastActiveAt = data.lastActiveAt && typeof data.lastActiveAt.toMillis === 'function' ? data.lastActiveAt.toMillis() : 0;
      return (Date.now() - lastActiveAt) < DM_ONLINE_THRESHOLD_MS;
    } catch { return false; }
  }));
  if (dmView !== 'list') return;
  el.innerHTML = '';
  entries.forEach(([uid, data], i) => el.appendChild(dmFriendRow(uid, data.nick || '', statuses[i])));
}

function dmFriendRow(uid, nick, online) {
  const row = document.createElement('div');
  row.className = 'dm-friend-row';
  const dot = document.createElement('span');
  dot.className = 'dm-online-dot' + (online ? ' online' : '');
  row.appendChild(dot);
  const nickSpan = document.createElement('span');
  nickSpan.className = 'nick';
  nickSpan.textContent = nick;
  row.appendChild(nickSpan);
  const chatId = dmChatIdFor(state.currentUser.uid, uid);
  const summary = dmSummaries[chatId];
  const unread = summary && summary.unread && summary.unread[state.currentUser.uid];
  if (unread > 0) {
    const unreadDot = document.createElement('span');
    unreadDot.className = 'dm-unread-dot';
    row.appendChild(unreadDot);
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

// bolha de mensagem — mesmo padrão visual do chat de clã (ver
// renderChatMessages em js/guilds.js): hora curtinha sempre visível, data
// completa (sem repetir a hora) só ao clicar. Sem nick acima da bolha (só
// duas pessoas na conversa, óbvio quem é quem pelo lado) e sem denunciar
// (conversa privada 1-pra-1, fora do escopo do balãozinho por enquanto)
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
      const fullDateEl = document.createElement('div');
      fullDateEl.style.cssText = 'font-size:0.62rem; color:#8fa0d6; text-align:right; margin-top:2px; display:none;';
      fullDateEl.textContent = formatMsgFullDateTime(m.at);
      bubble.appendChild(fullDateEl);
      bubble.onclick = () => { fullDateEl.style.display = fullDateEl.style.display === 'none' ? 'block' : 'none'; };
      el.appendChild(bubble);
    });
  }
  el.scrollTop = el.scrollHeight;
}

function openDmConversation(uid, nick) {
  activeFriendUid = uid;
  activeChatId = dmChatIdFor(state.currentUser.uid, uid);
  dmView = 'chat';
  $('dm-chat-popup-title').textContent = nick;
  $('dm-chat-back-btn').style.display = '';
  $('dm-chat-list-view').style.display = 'none';
  $('dm-chat-conversation-view').style.display = 'flex';
  ensureDmChatListener(activeChatId);
  renderDmMessages();
  markDmChatRead();
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

window.toggleDmChatPopup = () => {
  dmPopupOpen = !dmPopupOpen;
  const popup = $('dm-chat-popup');
  popup.style.display = dmPopupOpen ? 'flex' : 'none';
  if (dmPopupOpen) {
    dmView = 'list';
    activeFriendUid = null;
    activeChatId = null;
    $('dm-chat-back-btn').style.display = 'none';
    $('dm-chat-popup-title').textContent = T[state.lang].dm_chat_title;
    $('dm-chat-list-view').style.display = 'flex';
    $('dm-chat-conversation-view').style.display = 'none';
    ensureDmSummaryListener();
    renderDmFriendsList();
    updateDmBubbleBadge();
  } else {
    if (dmChatUnsub) { dmChatUnsub(); dmChatUnsub = null; }
    updateDmBubbleBadge();
  }
};

window.backToDmFriendsList = () => {
  dmView = 'list';
  activeFriendUid = null;
  activeChatId = null;
  if (dmChatUnsub) { dmChatUnsub(); dmChatUnsub = null; }
  $('dm-chat-back-btn').style.display = 'none';
  $('dm-chat-popup-title').textContent = T[state.lang].dm_chat_title;
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
  openDmConversation(uid, nick);
};

/* -------- balãozinho flutuante (mesmo padrão do chat de clã) -------- */
const DM_CHAT_BUBBLE_SCREENS = new Set([
  'menu-screen', 'shop-screen', 'ranking-screen', 'replay-screen',
  'profile-screen', 'friends-screen', 'guild-list-screen', 'guild-screen',
]);

// quando os dois balõezinhos (clã + amigos) ficam visíveis ao mesmo tempo,
// este aqui sobe pra cima do de clã em vez de sobrepor (ver .chat-bubble/
// .chat-popup em css/style.css) — depende do balão de clã já ter sido
// atualizado nesse mesmo ciclo, por isso js/dms.js é importado DEPOIS de
// js/guilds.js em js/bootstrap.js
function refreshDmChatBubble() {
  const bubble = $('dm-chat-bubble');
  if (!bubble) return;
  const active = document.querySelector('.screen.active');
  const eligible = !!(active && DM_CHAT_BUBBLE_SCREENS.has(active.id) && !state.offline && state.currentUser);
  bubble.style.display = eligible ? 'flex' : 'none';
  const guildBubble = $('guild-chat-bubble');
  const guildVisible = !!(guildBubble && guildBubble.style.display !== 'none');
  bubble.style.bottom = guildVisible ? '88px' : '20px';
  const popup = $('dm-chat-popup');
  if (popup) popup.style.bottom = guildVisible ? '156px' : '88px';
  if (eligible) {
    ensureDmSummaryListener();
    updateDmBubbleBadge();
  } else if (dmPopupOpen) {
    window.toggleDmChatPopup();
  }
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
  dmSummaries = {};
  dmMessages = [];
  activeChatId = null;
  activeFriendUid = null;
  dmPopupOpen = false;
  const popup = $('dm-chat-popup');
  if (popup) popup.style.display = 'none';
};
