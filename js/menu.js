import { $ } from './dom.js';
import { state } from './state.js';
import { show, resetScreenBackStack } from './nav.js';
import { T } from './i18n.js';
import { isMuted } from './utils.js';
import { MODE_UNLOCK, avatarOrDefaultIcon, xpInfo, myXp, modeUnlocked, applyGuildTagStyle } from './levels.js';
import { refreshBadgeNotifDot } from './badges.js';
import { fetchMyFriendRequests } from './friends.js';
import { myRecord } from './game-core.js';
import { refreshInboxBadge, updateDailyMenuCard } from './daily-challenge.js';
import { equippedAvatar, renderMenuPigmentosBar, renderUserPigmentos } from './shop.js';
import { refreshGuildMenuBadge } from './guilds.js';
import { updateGuildBattleCard } from './guild-battle.js';

/* ================== menu ================== */
window.showMenu = () => {
  $('record-classic').textContent = myRecord('classic');
  $('record-reverse').textContent = myRecord('reverse');
  $('record-shapes').textContent = myRecord('shapes');
  $('record-shapes-reverse').textContent = myRecord('shapes-reverse');
  $('record-trio').textContent = myRecord('trio');
  $('record-caos').textContent = myRecord('caos');
  $('record-mosaic').textContent = myRecord('mosaic');
  $('mute-btn').classList.toggle('on', !isMuted());
  $('mute-btn').querySelector('.tgl-icon').textContent = isMuted() ? '🔇' : '🔊';

  // nível e barra de XP (só aparece pra quem tem conta)
  $('menu-xp-wrap').style.display = state.offline ? 'none' : '';
  const xi = xpInfo(myXp());
  $('menu-xp-lv').textContent = `Lv ${xi.lv}`;
  $('menu-xp-nums').textContent = `${xi.into}/${xi.need}`;
  $('menu-xp-fill').style.width = Math.min(100, (xi.into / xi.need) * 100) + '%';

  // amigos precisam de conta — botão some jogando sem login; a bolinha
  // vermelha avisa quando tem pedido de amizade esperando resposta
  $('menu-quick-friends-btn').style.display = state.offline ? 'none' : '';
  if (!state.offline && state.currentUser) {
    fetchMyFriendRequests().then(reqs => {
      const n = Object.keys(reqs.incoming || {}).length;
      const badge = $('menu-quick-friends-badge');
      badge.textContent = n;
      badge.style.display = n > 0 ? '' : 'none';
    }).catch(() => {});
  }
  refreshInboxBadge();
  updateDailyMenuCard();
  updateGuildBattleCard();
  renderMenuPigmentosBar();
  renderUserPigmentos();
  refreshBadgeNotifDot();

  // clãs também precisam de conta — mesma lógica de amigos, mas a
  // bolinha aqui cobre solicitações de entrada pendentes (se eu for
  // líder) OU um convite de liderança esperando resposta
  $('menu-quick-guild-btn').style.display = state.offline ? 'none' : '';
  if (!state.offline && state.currentUser) refreshGuildMenuBadge();

  // bloqueio dos modos por nível
  for (const [m, minLv] of Object.entries(MODE_UNLOCK)) {
    const locked = !modeUnlocked(m);
    $('card-' + m).classList.toggle('locked', locked);
    const lockEl = $('lock-' + m);
    lockEl.style.display = locked ? '' : 'none';
    if (locked) lockEl.textContent = T[state.lang].unlock_at(minLv);
  }
  if (state.offline) {
    $('user-label').textContent = T[state.lang].offline_label;
    $('menu-logout-btn').textContent = T[state.lang].entrar_label;
  } else {
    // avatar (markup fixo/confiável) vai por innerHTML; o nick sempre por
    // textContent/createTextNode (pode ter qualquer caractere não-espaço)
    const labelEl = $('user-label');
    labelEl.innerHTML = '';
    labelEl.insertAdjacentHTML('beforeend', avatarOrDefaultIcon(equippedAvatar, 32) + ' ');
    labelEl.appendChild(document.createTextNode(T[state.lang].user_greeting(state.myData.nick || '')));
    // sigla do clã (se tiver) do lado do nick, na tela principal — clicável,
    // mesmo padrão de buildRankRowNick em js/ranking-cache.js
    // (window.openGuildFromTag, ver js/guilds.js); stopPropagation pra não
    // também disparar o showProfile() do botão em volta
    if (state.myData.guildTag && state.myData.guildId) {
      const tagSpan = document.createElement('span');
      tagSpan.textContent = ` [${state.myData.guildTag}]`;
      tagSpan.className = 'guild-tag-link';
      applyGuildTagStyle(tagSpan, state.myData.guildTagStyle);
      tagSpan.onclick = (ev) => { ev.stopPropagation(); window.openGuildFromTag(state.myData.guildId, 'menu-screen'); };
      labelEl.appendChild(tagSpan);
    }
    $('menu-logout-btn').textContent = T[state.lang].sair_label;
  }
  // menu é a "raiz" da navegação — zera a pilha de "voltar" (ver
  // pushScreenAndShow/popScreenBack) toda vez que ela é mostrada de
  // verdade, pra nunca ir acumulando entradas órfãs de sessões de
  // perfil/ranking anteriores
  resetScreenBackStack();
  show('menu-screen');
};
