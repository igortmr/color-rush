import { state } from './state.js';
import { $ } from './dom.js';
import { show, resetScroll } from './nav.js';
import { track, playCorrectSfxVariant } from './utils.js';
import { callable } from './firebase.js';
import { pigmentIconSvg, applyNickFrame, applyRowTheme, avatarSvg } from './levels.js';

// loja de cosméticos (paga com Pigmentos)
const callBuyShopItem = callable('buyShopItem');
const callSetEquippedItem = callable('setEquippedItem');

/* ================== loja (cosméticos comprados com Pigmentos) ==================
   Catálogo espelha o de functions/index.js (preço/slot são conferidos de novo
   no servidor — o catálogo aqui é só pra desenhar a tela). "equipped*" abaixo
   são os cosméticos ativos AGORA nesta sessão — carregados de state.myData.equipped
   depois do login e aplicados em applyEquippedCosmetics(). */
export const SHOP_ITEMS = [
  { id: 'sfx_splash',    slot: 'sfxCorrect', price: 30,  icon: '🎨', name: 'Som de Acerto: Splash de Tinta', desc: 'Troca o bipe de acerto por um "splash" de tinta.' },
  { id: 'sfx_8bit',      slot: 'sfxCorrect', price: 30,  icon: '👾', name: 'Som de Acerto: Retrô 8-bit',     desc: 'Um bipe estilo fliperama clássico.' },
  { id: 'sfx_bell',      slot: 'sfxCorrect', price: 30,  icon: '🔔', name: 'Som de Acerto: Sininho',         desc: 'Um "ding" de sino cristalino a cada acerto.' },
  { id: 'sfx_laser',     slot: 'sfxCorrect', price: 30,  icon: '🔫', name: 'Som de Acerto: Laser',           desc: 'Um tiro de laser sci-fi a cada acerto.' },
  { id: 'sfx_bubble',    slot: 'sfxCorrect', price: 30,  icon: '🫧', name: 'Som de Acerto: Bolha',           desc: 'Um "blip" de bolha estourando a cada acerto.' },
  { id: 'sfx_synth',     slot: 'sfxCorrect', price: 30,  icon: '🎹', name: 'Som de Acerto: Sintetizador',    desc: 'Um acorde curto de sintetizador retrô a cada acerto.' },
  { id: 'frame_gold',    slot: 'frame',      price: 100, icon: '🖼️', name: 'Moldura Dourada',                desc: 'Uma moldura dourada ao redor do seu nick no ranking e perfil.' },
  { id: 'frame_rainbow', slot: 'frame',      price: 100, icon: '🖼️', name: 'Moldura Arco-íris',              desc: 'Uma moldura multicolorida ao redor do seu nick.' },
  { id: 'confetti_gold', slot: 'confetti',   price: 120, icon: '🎊', name: 'Confete Dourado',                desc: 'Um confete dourado quando você bate um novo recorde.' },
  { id: 'row_ocean',     slot: 'rowTheme',   price: 1000, icon: '🌊', name: 'Linha: Oceano',                  desc: 'Fundo temático de oceano na sua linha do ranking.' },
  { id: 'row_galaxy',    slot: 'rowTheme',   price: 1000, icon: '🌌', name: 'Linha: Galáxia',                 desc: 'Fundo temático de galáxia na sua linha do ranking.' },
  { id: 'row_forest',    slot: 'rowTheme',   price: 1000, icon: '🌲', name: 'Linha: Floresta',                desc: 'Verdes de floresta na sua linha do ranking.' },
  { id: 'row_sunset',    slot: 'rowTheme',   price: 1000, icon: '🌇', name: 'Linha: Pôr do Sol',               desc: 'Degradê de laranja, rosa e roxo, tipo um pôr do sol.' },
  { id: 'row_frost',     slot: 'rowTheme',   price: 1000, icon: '❄️', name: 'Linha: Gelo',                    desc: 'Azul e branco gelados na sua linha do ranking.' },
  { id: 'row_starfield', slot: 'rowTheme',   price: 3000, icon: '✨', name: 'Linha: Céu Estrelado',            desc: 'Fundo escuro cheio de estrelinhas cintilantes — anima sozinho.' },
  { id: 'row_holo',      slot: 'rowTheme',   price: 5000, icon: '🌈', name: 'Linha: RGB',                     desc: 'Degradê iridescente que muda de cor sozinho.' },
  { id: 'row_stripes_gold', slot: 'rowTheme', price: 3000, icon: '🐝', name: 'Linha: Listras Douradas',        desc: 'Listras diagonais douradas e pretas, visual VIP.' },
  { id: 'row_storm',     slot: 'rowTheme',   price: 5000, icon: '⚡', name: 'Linha: Tempestade',               desc: 'Raios brancos riscando um fundo escuro de tempestade — pisca de vez em quando.' },
  { id: 'row_confetti_dots', slot: 'rowTheme', price: 3000, icon: '🎊', name: 'Linha: Confete',                desc: 'Bolinhas coloridas espalhadas, visual de festa.' },
  { id: 'avatar_robot',   slot: 'avatar', price: 110, icon: '🤖', name: 'Avatar: Robô',     desc: 'Um robô neon pra representar você no perfil e no duelo.' },
  { id: 'avatar_ninja',   slot: 'avatar', price: 110, icon: '🥷', name: 'Avatar: Ninja',    desc: 'Um ninja encapuzado pra representar você no perfil e no duelo.' },
  { id: 'avatar_ghost',   slot: 'avatar', price: 110, icon: '👻', name: 'Avatar: Fantasma', desc: 'Um fantasma pra representar você no perfil e no duelo.' },
  { id: 'avatar_cat',     slot: 'avatar', price: 110, icon: '🐱', name: 'Avatar: Gato',     desc: 'Um gato pra representar você no perfil e no duelo.' },
  { id: 'avatar_alien',   slot: 'avatar', price: 110, icon: '👽', name: 'Avatar: Alien',    desc: 'Um alien pra representar você no perfil e no duelo.' },
  { id: 'avatar_flame',   slot: 'avatar', price: 110, icon: '🔥', name: 'Avatar: Chama',    desc: 'Uma chama pra representar você no perfil e no duelo.' },
  { id: 'avatar_crystal', slot: 'avatar', price: 110, icon: '💎', name: 'Avatar: Cristal',  desc: 'Um cristal pra representar você no perfil e no duelo.' },
  { id: 'avatar_star',    slot: 'avatar', price: 110, icon: '⭐', name: 'Avatar: Estrela',  desc: 'Uma estrela pra representar você no perfil e no duelo.' },
];
const SHOP_ITEMS_BY_ID = Object.fromEntries(SHOP_ITEMS.map(it => [it.id, it]));
export const SHOP_SLOTS = [
  { slot: 'sfxCorrect', label: '🔊 Som de Acerto' },
  { slot: 'frame',      label: '🖼️ Moldura do Nick' },
  { slot: 'confetti',   label: '🎊 Confete de Recorde' },
  { slot: 'rowTheme',   label: '📊 Linha do Ranking' },
  { slot: 'avatar',     label: '🧑 Avatar' },
];
// só "Linha do Ranking" fica visível na loja por enquanto — as outras
// categorias já existem no catálogo (e no servidor) mas ainda não foram
// lançadas. A loja em si só aparece pra admin (ver renderMenuPigmentosBar),
// então dá pra deixar isso sem risco; quando o resto estiver pronto, é só
// trocar esse filtro por SHOP_SLOTS de novo.
const VISIBLE_SHOP_SLOTS = SHOP_SLOTS.filter(s => s.slot === 'rowTheme');
// exportadas como bindings ao vivo (o import sempre reflete o valor atual,
// nativo de ES modules) — lidas em game-teste.js por domínios que ainda não
// são módulos próprios (sons, confete, avatar no menu/duelo)
export let equippedSfx = null, equippedFrame = null, equippedConfetti = null, equippedAvatar = null;
export function applyEquippedCosmetics() {
  const eq = (state.myData && state.myData.equipped) || {};
  equippedSfx = eq.sfxCorrect || null;
  equippedFrame = eq.frame || null;
  equippedConfetti = eq.confetti || null;
  equippedAvatar = eq.avatar || null;
}

// botão "🛍️ LOJA" do menu — a loja ainda tá em teste, então o botão fica
// oculto pra todo mundo, menos pra quem loga como admin
export function renderMenuPigmentosBar() {
  const shopBtn = $('menu-quick-shop-btn');
  if (!shopBtn) return;
  shopBtn.style.display = (!state.offline && state.currentUser && state.myData.nick && state.myData.admin === true) ? '' : 'none';
}
// saldo de Pigmentos no topo da tela, entre o nick e a caixa de entrada — só
// o número + ícone colorido, sem texto/link (o acesso à loja continua sendo
// só pela barra do menu, acima)
export function renderUserPigmentos() {
  const el = $('user-pigmentos-bar');
  if (!el) return;
  if (state.offline || !state.currentUser || !state.myData.nick) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'inline-flex';
  $('user-pigmentos-num').textContent = state.myData.pigmentos || 0;
  $('user-pigmentos-icon').innerHTML = pigmentIconSvg(16);
}

window.showShop = () => {
  if (state.offline || !state.currentUser || !state.myData.nick) { window.goSignup(); return; }
  track('shop_open');
  $('shop-status').textContent = '';
  show('shop-screen');
  renderShop();
};

function renderShop() {
  $('shop-balance-icon').innerHTML = pigmentIconSvg(20);
  $('shop-balance-num').textContent = state.myData.pigmentos || 0;
  const owned = new Set(state.myData.ownedItems || []);
  const equipped = state.myData.equipped || {};

  const body = $('shop-body');
  body.innerHTML = '';
  VISIBLE_SHOP_SLOTS.forEach(({ slot, label }) => {
    const section = document.createElement('div');
    section.className = 'card';
    section.style.textAlign = 'left';

    const title = document.createElement('h2');
    title.style.cssText = "font-family:'Orbitron',sans-serif; font-size:0.95rem; margin-bottom:2px;";
    title.textContent = label;
    section.appendChild(title);

    section.appendChild(shopDefaultRow(slot, equipped[slot]));
    SHOP_ITEMS.filter(it => it.slot === slot).forEach(item => {
      section.appendChild(shopItemRow(item, owned.has(item.id), equipped[slot] === item.id));
    });

    body.appendChild(section);
  });
  resetScroll('shop-screen');
}

// opção "padrão" de cada slot — sempre disponível, sem custo, volta o visual original
function shopDefaultRow(slot, currentEquipped) {
  const row = document.createElement('div');
  row.className = 'shop-item-row';

  const info = document.createElement('div');
  info.className = 'shop-item-info';
  const name = document.createElement('div');
  name.className = 'shop-item-name';
  name.textContent = '— Padrão —';
  const desc = document.createElement('div');
  desc.className = 'muted';
  desc.style.textAlign = 'left';
  desc.textContent = 'Visual original, sem cosmético.';
  info.appendChild(name);
  info.appendChild(desc);
  row.appendChild(info);

  const isActive = !currentEquipped;
  const btn = document.createElement('button');
  btn.style.cssText = 'padding:8px 16px; font-size:0.8rem; white-space:nowrap;';
  if (isActive) {
    btn.textContent = 'EQUIPADO';
    btn.disabled = true;
    btn.style.opacity = '0.6';
  } else {
    btn.className = 'secondary';
    btn.textContent = 'USAR';
    btn.onclick = () => equipShopItem(slot, null);
  }
  row.appendChild(btn);
  return row;
}

// prévia de cada item, direto na linha da loja — funciona mesmo sem
// comprar/equipar nada, pra pessoa decidir se vale a pena antes de gastar
// Pigmentos. Som chama a variante direto (bypassa o que estiver equipado
// agora); moldura monta um nick de exemplo com a moldura aplicada; confete
// dispara a mesma explosão que aparece ao bater recorde.
function shopItemPreview(item) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:6px;';
  if (item.slot === 'sfxCorrect') {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.style.cssText = 'padding:4px 12px; font-size:0.72rem;';
    btn.textContent = '🔊 Ouvir';
    btn.onclick = (e) => { e.stopPropagation(); playCorrectSfxVariant(item.id, 5); };
    wrap.appendChild(btn);
  } else if (item.slot === 'frame') {
    const sample = document.createElement('span');
    sample.textContent = 'SeuNick';
    sample.style.cssText = 'font-weight:700; font-size:0.85rem;';
    applyNickFrame(sample, { equipped: { frame: item.id } });
    wrap.appendChild(sample);
  } else if (item.slot === 'confetti') {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.style.cssText = 'padding:4px 12px; font-size:0.72rem;';
    btn.textContent = '🎉 Testar';
    // spawnConfettiVariant vem de game-teste.js (domínio de efeitos visuais,
    // ainda não é um módulo próprio — fase futura), exposta lá só pra essa ponte
    btn.onclick = (e) => { e.stopPropagation(); window.spawnConfettiVariant(item.id); };
    wrap.appendChild(btn);
  } else if (item.slot === 'rowTheme') {
    // mini tabela real (não só uma div) pra reaproveitar exatamente o mesmo
    // seletor CSS "tbody tr.row-theme-x" usado na tabela de ranking de verdade
    const mini = document.createElement('table');
    mini.style.cssText = 'width:100%; border-collapse:collapse; margin-top:2px;';
    const tbody = document.createElement('tbody');
    const tr = document.createElement('tr');
    applyRowTheme(tr, { equipped: { rowTheme: item.id } });
    tr.innerHTML = '<td class="pos" style="padding:6px 8px;">1</td><td style="padding:6px 8px; font-weight:700;">SeuNick</td><td class="pts" style="padding:6px 8px;">1234</td>';
    tbody.appendChild(tr);
    mini.appendChild(tbody);
    wrap.appendChild(mini);
  } else if (item.slot === 'avatar') {
    // sempre visível (não precisa clicar em nada pra "testar" um desenho fixo)
    wrap.innerHTML = avatarSvg(item.id, 100); // 2.5x o tamanho antigo (40), só na prévia da loja
  }
  return wrap;
}

function shopItemRow(item, isOwned, isEquipped) {
  const row = document.createElement('div');
  row.className = 'shop-item-row';

  const info = document.createElement('div');
  info.className = 'shop-item-info';
  const name = document.createElement('div');
  name.className = 'shop-item-name';
  name.textContent = `${item.icon} ${item.name}`;
  const desc = document.createElement('div');
  desc.className = 'muted';
  desc.style.textAlign = 'left';
  desc.textContent = item.desc;
  info.appendChild(name);
  info.appendChild(desc);
  info.appendChild(shopItemPreview(item));
  row.appendChild(info);

  const btn = document.createElement('button');
  btn.style.cssText = 'padding:8px 16px; font-size:0.8rem; white-space:nowrap;';
  if (isEquipped) {
    btn.textContent = 'EQUIPADO';
    btn.disabled = true;
    btn.style.opacity = '0.6';
  } else if (isOwned) {
    btn.className = 'secondary';
    btn.textContent = 'USAR';
    btn.onclick = () => equipShopItem(item.slot, item.id);
  } else {
    btn.className = 'secondary';
    btn.insertAdjacentHTML('beforeend', pigmentIconSvg(14));
    const priceSpan = document.createElement('span');
    priceSpan.textContent = ' ' + item.price;
    btn.appendChild(priceSpan);
    if ((state.myData.pigmentos || 0) < item.price) btn.style.opacity = '0.55';
    btn.onclick = () => buyShopItemUi(item.id);
  }
  row.appendChild(btn);
  return row;
}

window.buyShopItemUi = async (itemId) => {
  $('shop-status').textContent = '';
  try {
    const res = await callBuyShopItem({ itemId });
    if (res.data && typeof res.data.pigmentos === 'number') state.myData.pigmentos = res.data.pigmentos;
    state.myData.ownedItems = [...(state.myData.ownedItems || []), itemId];
    renderShop();
    renderMenuPigmentosBar();
    renderUserPigmentos();
  } catch (e) {
    $('shop-status').textContent = e.message || 'Não foi possível comprar agora.';
  }
};

window.equipShopItem = async (slot, itemId) => {
  $('shop-status').textContent = '';
  try {
    await callSetEquippedItem({ slot, itemId: itemId || null });
    if (!state.myData.equipped) state.myData.equipped = {};
    if (itemId) state.myData.equipped[slot] = itemId; else delete state.myData.equipped[slot];
    applyEquippedCosmetics();
    renderShop();
  } catch (e) {
    $('shop-status').textContent = e.message || 'Não foi possível trocar agora.';
  }
};
