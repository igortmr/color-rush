import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { resetScroll } from './nav.js';
import { callable } from './firebase.js';
import { ALL_MODES } from './constants.js';
import { lvChip, levelFromXp, myXp, totalXpForLevel } from './levels.js';
import { invalidateScoresCache } from './ranking-cache.js';

// ferramentas de admin (só funcionam de verdade pra quem tem admin:true —
// ver requireAdmin em functions/index.js; qualquer outra conta que tentar
// chamar recebe permission-denied do servidor)
const callAdminGetUserDetails = callable('adminGetUserDetails');
const callAdminSetBanned = callable('adminSetBanned');
const callAdminResetScores = callable('adminResetScores');
const callAdminSetNick = callable('adminSetNick');
const callAdminSetXp = callable('adminSetXp');
const callBackfillPendingPigmentos = callable('backfillPendingPigmentos');
const callAdminRecomputeScoresSnapshot = callable('adminRecomputeScoresSnapshot');
const callBackfillReplayDurations = callable('backfillReplayDurations');
const callAdminGetFlaggedAccounts = callable('adminGetFlaggedAccounts');
const callAdminListPendingDeletions = callable('adminListPendingDeletions');
const callAdminCancelAccountDeletion = callable('adminCancelAccountDeletion');
const callAdminForcePurgeAccount = callable('adminForcePurgeAccount');

/* ================== painel de admin (perfil de outra pessoa) ================== */
// texto fixo em português de propósito — essa parte da tela só aparece pra
// quem tem admin:true (só você), então não precisa dos outros idiomas
function fmtDateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export async function renderAdminPanel(uid, currentNick, stats) {
  const box = $('admin-panel-body');
  if (!box) return;

  let details;
  try {
    details = (await callAdminGetUserDetails({ uid })).data;
  } catch (e) {
    box.textContent = 'Erro ao carregar dados de admin: ' + (e.message || e);
    return;
  }

  box.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'text-align:left; display:flex; flex-direction:column; gap:10px; width:100%;';

  // último login
  const loginRow = document.createElement('div');
  loginRow.innerHTML = '<b>Última vez online:</b> ';
  loginRow.appendChild(document.createTextNode(details.lastActiveAt ? fmtDateTime(details.lastActiveAt) : 'nunca registrado'));
  wrap.appendChild(loginRow);

  // últimos duelos (PvP) — nick do adversário sempre via textContent (nunca
  // interpolado no HTML), mesmo cuidado usado no resto da tela de perfil
  const matchesTitle = document.createElement('div');
  matchesTitle.innerHTML = '<b>Últimos duelos (PvP):</b>';
  wrap.appendChild(matchesTitle);
  const matchesList = document.createElement('div');
  matchesList.style.cssText = 'display:flex; flex-direction:column; gap:2px;';
  if (!details.matches.length) {
    const row = document.createElement('div');
    row.className = 'muted';
    row.textContent = 'Nenhum duelo concluído ainda.';
    matchesList.appendChild(row);
  } else {
    details.matches.forEach(m => {
      const row = document.createElement('div');
      row.className = 'muted';
      const resultLabel = m.result === 'win' ? '🏆 Vitória' : m.result === 'loss' ? '💀 Derrota' : '🤝 Empate';
      row.appendChild(document.createTextNode(fmtDateTime(m.finishedAt) + ' — vs '));
      const b = document.createElement('b');
      b.textContent = m.opponentNick || '?';
      row.appendChild(b);
      row.appendChild(document.createTextNode(' — ' + resultLabel));
      matchesList.appendChild(row);
    });
  }
  wrap.appendChild(matchesList);

  // lista de amigos
  const friendsTitle = document.createElement('div');
  friendsTitle.innerHTML = `<b>Amigos (${details.friends.length}):</b>`;
  wrap.appendChild(friendsTitle);
  const friendsList = document.createElement('div');
  friendsList.style.cssText = 'display:flex; flex-direction:column; gap:2px;';
  if (!details.friends.length) {
    const row = document.createElement('div');
    row.className = 'muted';
    row.textContent = 'Sem amigos ainda.';
    friendsList.appendChild(row);
  } else {
    details.friends.forEach(f => {
      const row = document.createElement('div');
      row.className = 'muted';
      row.appendChild(document.createTextNode('👤 '));
      const b = document.createElement('b');
      b.textContent = f.nick || '?';
      row.appendChild(b);
      if (f.since) row.appendChild(document.createTextNode(' — desde ' + fmtDateTime(f.since)));
      friendsList.appendChild(row);
    });
  }
  wrap.appendChild(friendsList);

  // histórico de IPs/locais dessa conta (ver checkIpAndFlag em
  // functions/index.js) — só pra revisão manual, não marca nada sozinho.
  // Cada IP é uma linha própria de propósito (não uma frase corrida), pra
  // ficar fácil comparar visualmente com o histórico de outra conta suspeita.
  const ipTitle = document.createElement('div');
  ipTitle.innerHTML = `<b>Histórico de IPs (${(details.ipHistory || []).length}):</b>`;
  wrap.appendChild(ipTitle);
  const ipList = document.createElement('div');
  ipList.style.cssText = 'display:flex; flex-direction:column; gap:2px;';
  if (!details.ipHistory || !details.ipHistory.length) {
    const row = document.createElement('div');
    row.className = 'muted';
    row.textContent = 'Nenhum IP registrado ainda.';
    ipList.appendChild(row);
  } else {
    details.ipHistory.forEach(h => {
      const row = document.createElement('div');
      row.className = 'muted';
      const place = [h.city, h.country].filter(Boolean).join(', ') || '(local desconhecido)';
      row.textContent = `🌐 ${h.ip} — ${place} — ${fmtDateTime(h.at)}`;
      ipList.appendChild(row);
    });
  }
  wrap.appendChild(ipList);

  // editar nick + banir/desbanir — ambos validados de novo no servidor
  // (adminSetNick / adminSetBanned), isso aqui só monta a UI
  const toolsBox = document.createElement('div');
  toolsBox.style.cssText = 'border-top:1px solid rgba(255,255,255,0.1); padding-top:10px; display:flex; flex-direction:column; gap:8px;';

  const nickRow = document.createElement('div');
  nickRow.style.cssText = 'display:flex; gap:8px;';
  const nickInput = document.createElement('input');
  nickInput.type = 'text';
  nickInput.value = currentNick || '';
  nickInput.style.flex = '1';
  nickRow.appendChild(nickInput);
  const saveBtn = document.createElement('button');
  saveBtn.className = 'secondary';
  saveBtn.style.flex = 'none';
  saveBtn.textContent = 'Salvar nick';
  nickRow.appendChild(saveBtn);
  toolsBox.appendChild(nickRow);
  const nickStatus = document.createElement('div');
  nickStatus.className = 'muted';
  toolsBox.appendChild(nickStatus);

  saveBtn.onclick = async () => {
    const nick = nickInput.value.trim();
    nickStatus.textContent = '';
    if (nick.length < 3 || nick.length > 16 || /\s/.test(nick)) {
      nickStatus.textContent = 'Nick inválido (3 a 16 caracteres, sem espaço).';
      return;
    }
    saveBtn.disabled = true;
    try {
      await callAdminSetNick({ uid, nick });
      nickStatus.textContent = '✅ Nick atualizado.';
      stats.nick = nick;
      $('profile-nick-text').textContent = T[state.lang].profile_nick_label(nick);
      $('profile-nick-lv').innerHTML = ' ' + lvChip(stats.xp || 0);
    } catch (e) {
      nickStatus.textContent = '❌ ' + (e.message || 'Erro ao salvar.');
    } finally {
      saveBtn.disabled = false;
    }
  };

  const banBtn = document.createElement('button');
  const paintBanBtn = banned => {
    banBtn.textContent = banned ? '✅ Remover banimento' : '🚫 Banir esta conta';
    banBtn.style.cssText = banned
      ? 'border-color:var(--neon-green); color:var(--neon-green); background:#0a0e1e;'
      : 'border-color:var(--neon-red); color:#ff8bab; background:#0a0e1e;';
  };
  paintBanBtn(details.banned);
  toolsBox.appendChild(banBtn);
  const banStatus = document.createElement('div');
  banStatus.className = 'muted';
  toolsBox.appendChild(banStatus);

  banBtn.onclick = async () => {
    const next = !details.banned;
    if (next && !confirm('Banir esta conta? A pessoa não vai mais conseguir gravar pontuação nem jogar PvP.')) return;
    banBtn.disabled = true;
    banStatus.textContent = '';
    try {
      await callAdminSetBanned({ uid, banned: next });
      details.banned = next;
      paintBanBtn(next);
      banStatus.textContent = next ? '🚫 Conta banida.' : '✅ Banimento removido.';
    } catch (e) {
      banStatus.textContent = '❌ ' + (e.message || 'Erro.');
    } finally {
      banBtn.disabled = false;
    }
  };

  // zera a pontuação dos 6 modos de jogo (e o total geral, que é a soma
  // deles) mais a tentativa de hoje do desafio diário — não mexe em
  // dailyWins (Salão da Fama), XP/nível, indicações, Pigmentos nem itens da
  // loja. Sem "desfazer" (ao contrário do banimento): a confirmação é
  // sempre exigida, já que não tem como voltar atrás depois.
  const resetScoresBtn = document.createElement('button');
  resetScoresBtn.className = 'secondary';
  resetScoresBtn.style.cssText = 'border-color:var(--neon-red); color:#ff8bab; background:#0a0e1e;';
  resetScoresBtn.textContent = '🗑️ Zerar pontuações desta conta';
  toolsBox.appendChild(resetScoresBtn);
  const resetScoresStatus = document.createElement('div');
  resetScoresStatus.className = 'muted';
  toolsBox.appendChild(resetScoresStatus);

  resetScoresBtn.onclick = async () => {
    if (!confirm(`Zerar as pontuações de ${currentNick || 'esta conta'} nos 6 modos de jogo (Clássico, Reverso, Formas, Formas Reverso, Trio, Caos) e a tentativa de hoje do desafio diário? Isso NÃO afeta o Salão da Fama, XP/nível, indicações, Pigmentos ou itens da loja. Não pode ser desfeito.`)) return;
    resetScoresBtn.disabled = true;
    resetScoresStatus.textContent = '';
    try {
      await callAdminResetScores({ uid });
      ALL_MODES.forEach(m => { stats[m] = 0; });
      stats.total = 0;
      resetScoresStatus.textContent = '✅ Pontuações zeradas nos 6 modos e na tentativa de hoje do desafio diário.';
    } catch (e) {
      resetScoresStatus.textContent = '❌ ' + (e.message || 'Erro.');
    } finally {
      resetScoresBtn.disabled = false;
    }
  };

  wrap.appendChild(toolsBox);
  box.appendChild(wrap);
  // o painel carrega depois do resto do perfil (é uma chamada assíncrona à
  // parte) e deixa a tela mais alta — sem isso, o mesmo bug de rolagem presa
  // já corrigido no ranking/amigos podia voltar a acontecer aqui
  resetScroll('profile-screen');
}

// bloco de ferramentas soltas no PRÓPRIO perfil (não no painel de outra
// pessoa acima) — chamado por js/profile.js dentro de renderProfile() quando
// state.myData.admin === true
export function renderAdminToolsHtml() {
  return `
      <div class="card" style="text-align:left;">
        <b>🛠️ Admin — ferramentas gerais</b>
        <p class="muted" style="margin-top:6px;">Recalcula pendingPigmentos de todo mundo a partir do que ainda está na caixa de entrada de cada um. Seguro rodar mais de uma vez.</p>
        <button class="secondary" onclick="runBackfillPendingPigmentos(this)">Rodar backfill de pigmentos pendentes</button>
        <div class="muted" id="backfill-status" style="margin-top:6px;"></div>
      </div>
      <div class="card" style="text-align:left;">
        <b>🛠️ Admin — preencher duração de partidas retroativas</b>
        <p class="muted" style="margin-top:6px;">Preenche a duração das partidas que já bateram recorde antes dessa medição existir (usa a sessão salva do recorde atual — start/fim já gravados). O ranking passou a desempatar por "menos tempo gasto" em vez de "quem pontuou primeiro"; sem isso, todo recorde antigo continua no critério velho. Seguro rodar mais de uma vez.</p>
        <button class="secondary" onclick="runBackfillReplayDurations(this)">Rodar backfill de duração</button>
        <div class="muted" id="backfill-duration-status" style="margin-top:6px;"></div>
      </div>
      <div class="card" style="text-align:left;">
        <b>🛠️ Admin — atualizar ranking agora</b>
        <p class="muted" style="margin-top:6px;">Recalcula o retrato do ranking (scoresSnapshot) na hora, em vez de esperar até 5min pelo agendamento automático. Útil pra testar mudanças recém-implantadas nas functions.</p>
        <button class="secondary" onclick="runAdminRecomputeSnapshot(this)">Recalcular ranking agora</button>
        <div class="muted" id="recompute-snapshot-status" style="margin-top:6px;"></div>
      </div>
      <div class="card" style="text-align:left;">
        <b>🚩 Contas Suspeitas</b>
        <p class="muted" style="margin-top:6px;">Lista os alertas mais recentes de possível compartilhamento de conta: mesmo IP em duas contas diferentes, ou uma conta "pulando" de local rápido demais (ver checkIpAndFlag em functions/index.js). Não bloqueia nada sozinho — é só pra você decidir manualmente o que fazer.</p>
        <button class="secondary" onclick="runAdminGetFlaggedAccounts(this)">Carregar contas suspeitas</button>
        <div id="flagged-accounts-list" style="margin-top:6px;"></div>
      </div>
      <div class="card" style="text-align:left;">
        <b>🕒 Pedidos de Exclusão de Conta</b>
        <p class="muted" style="margin-top:6px;">Contas que pediram exclusão e ainda estão dentro da carência de 15 dias (exigência da Apple — ver deleteMyAccount em functions/index.js). "Desfazer" reativa o login e cancela o pedido; "Excluir agora" apaga os dados na hora, sem esperar o resto da carência.</p>
        <button class="secondary" onclick="runAdminListPendingDeletions(this)">Carregar pedidos de exclusão</button>
        <div id="pending-deletions-list" style="margin-top:6px;"></div>
      </div>
      <div class="card" style="text-align:left;">
        <b>🛠️ Admin — editar meu nível</b>
        <p class="muted" style="margin-top:6px;">Define seu XP direto pro mínimo do nível escolhido. Só afeta a sua própria conta — validado de novo no servidor (ver adminSetXp em functions/index.js).</p>
        <div style="display:flex; gap:8px; margin-top:6px;">
          <input type="number" id="admin-set-level-input" min="1" max="500" step="1" value="${levelFromXp(myXp())}" style="flex:1;">
          <button class="secondary" style="flex:none;" onclick="runAdminSetOwnLevel(this)">Definir nível</button>
        </div>
        <div class="muted" id="admin-set-level-status" style="margin-top:6px;"></div>
      </div>`;
}

// botão avulso no PRÓPRIO perfil (não no painel de outra pessoa acima) —
// dispara o backfill único de pendingPigmentos (ver comentário da function
// no functions/index.js). Idempotente: pode clicar mais de uma vez à vontade.
window.runBackfillPendingPigmentos = async (btn) => {
  const status = $('backfill-status');
  btn.disabled = true;
  if (status) status.textContent = 'Rodando...';
  try {
    const res = await callBackfillPendingPigmentos();
    if (status) status.textContent = `✅ Concluído — ${res.data.usersUpdated} conta(s) atualizada(s).`;
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || 'Erro ao rodar backfill.');
  } finally {
    btn.disabled = false;
  }
};

// preenche <modo>DurationMs/bestScoreDurationMs de recordes/pontuações
// retroativas — ver backfillReplayDurations em functions/index.js. Rodar
// uma vez só; idempotente, então clicar de novo por engano não faz mal
// (só reprocessa o que ainda estiver faltando).
window.runBackfillReplayDurations = async (btn) => {
  const status = $('backfill-duration-status');
  btn.disabled = true;
  if (status) status.textContent = 'Rodando...';
  try {
    const res = await callBackfillReplayDurations();
    const d = res.data;
    if (status) status.textContent = `✅ Concluído — ${d.scoresUpdated} recorde(s) e ${d.dailyUpdated} pontuação(ões) do diário atualizados. Sem dado suficiente pra calcular: ${d.scoresFieldsSkipped} recorde(s) e ${d.dailySkipped} do diário (ficam no critério antigo).`;
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || 'Erro ao rodar backfill.');
  } finally {
    btn.disabled = false;
  }
};

// outra ferramenta avulsa só pra admin, mesmo raciocínio da de cima — define
// o XP da PRÓPRIA conta pro mínimo do nível digitado (ver totalXpForLevel).
// Só atualiza o essencial na tela (chip de nível no cabeçalho + state.myData.xp),
// sem chamar renderProfile() de novo — isso reconstruiria o card inteiro e
// apagaria a mensagem de status antes da pessoa conseguir ler.
// força o recálculo do retrato de ranking (scoresSnapshot) na hora, em vez de
// esperar os até 5min do agendamento — útil pra ver na hora o efeito de uma
// mudança recém-implantada em functions/index.js (ex.: admin entrar/sair do
// ranking) sem precisar esperar o próximo ciclo automático
window.runAdminRecomputeSnapshot = async (btn) => {
  const status = $('recompute-snapshot-status');
  btn.disabled = true;
  if (status) status.textContent = 'Recalculando...';
  try {
    const res = await callAdminRecomputeScoresSnapshot();
    invalidateScoresCache(); // invalida o cache local de 5min pra próxima leitura já vir atualizada
    if (status) status.textContent = `✅ Retrato atualizado — ${res.data.userCount} conta(s), ${res.data.chunkCount} pedaço(s).`;
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || 'Erro ao recalcular.');
  } finally {
    btn.disabled = false;
  }
};

// mostra os alertas mais recentes de checkIpAndFlag (functions/index.js) —
// texto fixo em português de propósito, igual o resto do painel de admin
window.runAdminGetFlaggedAccounts = async (btn) => {
  const list = $('flagged-accounts-list');
  btn.disabled = true;
  if (list) list.innerHTML = '<div class="muted">Carregando...</div>';
  try {
    const res = await callAdminGetFlaggedAccounts();
    const events = (res.data && res.data.events) || [];
    if (!events.length) {
      if (list) list.innerHTML = '<div class="muted">Nenhum alerta registrado ainda.</div>';
    } else if (list) {
      list.innerHTML = events.map(ev => {
        const nickSafe = (ev.nick || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        let detailText;
        if (ev.reason === 'ip_compartilhado_entre_contas') {
          const otherSafe = (ev.otherNick || '(sem nick)').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
          detailText = `mesmo IP que <b>${otherSafe}</b> (${ev.details.ip || '?'})`;
        } else {
          const from = ev.details.fromCity || ev.details.fromCountry || '?';
          const to = ev.details.toCity || ev.details.toCountry || '?';
          const mins = ev.details.elapsedMs ? Math.round(ev.details.elapsedMs / 60000) : '?';
          detailText = `pulou de <b>${from}</b> pra <b>${to}</b> (${ev.details.distanceKm || '?'}km) em ${mins}min`;
        }
        return `<div class="card" style="text-align:left; padding:10px 14px;">
          <div><b>${nickSafe}</b> — ${detailText}</div>
          <div class="muted" style="margin-top:4px;">${fmtDateTime(ev.at)}</div>
        </div>`;
      }).join('');
    }
  } catch (e) {
    if (list) list.innerHTML = '❌ ' + (e.message || 'Erro ao carregar.');
  } finally {
    btn.disabled = false;
  }
};

// lista os pedidos de exclusão dentro da carência de 15 dias, com botão pra
// desfazer (reativa login) ou acelerar (apaga os dados na hora) cada um —
// ver adminListPendingDeletions/adminCancelAccountDeletion/
// adminForcePurgeAccount em functions/index.js
window.runAdminListPendingDeletions = async (btn) => {
  const list = $('pending-deletions-list');
  btn.disabled = true;
  if (list) list.innerHTML = '<div class="muted">Carregando...</div>';
  try {
    const res = await callAdminListPendingDeletions();
    const requests = (res.data && res.data.requests) || [];
    if (!requests.length) {
      if (list) list.innerHTML = '<div class="muted">Nenhum pedido de exclusão pendente.</div>';
    } else if (list) {
      list.innerHTML = requests.map(r => {
        const esc = s => (s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        const msLeft = (r.scheduledPurgeAt || 0) - Date.now();
        const daysLeft = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
        const timeLabel = msLeft <= 0 ? 'já venceu — purga automática deve rodar em breve' : `${daysLeft} dia(s) restante(s)`;
        return `<div class="card" style="text-align:left; padding:10px 14px;">
          <div><b>${esc(r.nick)}</b>${r.email ? ' — ' + esc(r.email) : ''}</div>
          <div class="muted" style="margin-top:2px;">Pedido em ${fmtDateTime(r.requestedAt)} — ${timeLabel} (exclusão automática em ${fmtDateTime(r.scheduledPurgeAt)})</div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <button class="secondary" style="flex:1;" onclick="runAdminCancelAccountDeletion('${r.uid}', this)">↩️ Desfazer</button>
            <button class="secondary" style="flex:1; border-color:var(--neon-red); color:#ff8bab;" onclick="runAdminForcePurgeAccount('${r.uid}', this)">🗑️ Excluir agora</button>
          </div>
          <div class="muted pending-deletion-status" style="margin-top:6px;"></div>
        </div>`;
      }).join('');
    }
  } catch (e) {
    if (list) list.innerHTML = '❌ ' + (e.message || 'Erro ao carregar.');
  } finally {
    btn.disabled = false;
  }
};

window.runAdminCancelAccountDeletion = async (uid, btn) => {
  if (!confirm('Cancelar o pedido de exclusão e reativar o login dessa conta?')) return;
  const row = btn.closest('.card');
  const status = row && row.querySelector('.pending-deletion-status');
  btn.disabled = true;
  try {
    await callAdminCancelAccountDeletion({ uid });
    if (row) row.remove();
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || 'Erro.');
    btn.disabled = false;
  }
};

window.runAdminForcePurgeAccount = async (uid, btn) => {
  if (!confirm('Excluir esta conta AGORA, sem esperar o resto da carência? Isso apaga todos os dados na hora e não pode ser desfeito.')) return;
  const row = btn.closest('.card');
  const status = row && row.querySelector('.pending-deletion-status');
  btn.disabled = true;
  try {
    await callAdminForcePurgeAccount({ uid });
    if (row) row.remove();
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || 'Erro.');
    btn.disabled = false;
  }
};

window.runAdminSetOwnLevel = async (btn) => {
  const input = $('admin-set-level-input');
  const status = $('admin-set-level-status');
  const lv = parseInt(input.value, 10);
  if (status) status.textContent = '';
  if (!Number.isFinite(lv) || lv < 1 || lv > 500) {
    if (status) status.textContent = '❌ Nível inválido (1 a 500).';
    return;
  }
  const xp = totalXpForLevel(lv);
  btn.disabled = true;
  try {
    await callAdminSetXp({ uid: state.currentUser.uid, xp });
    state.myData.xp = xp;
    $('profile-nick-lv').innerHTML = ' ' + lvChip(myXp());
    if (status) status.textContent = `✅ Nível definido pra ${lv}.`;
  } catch (e) {
    if (status) status.textContent = '❌ ' + (e.message || 'Erro ao salvar.');
  } finally {
    btn.disabled = false;
  }
};
