import {
  doc, getDoc, writeBatch, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db, callable } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { track } from './utils.js';
import { submitPendingScore } from './profile.js';
import { startPvpListener } from './pvp.js';
import { getReferrerCode, clearReferrerCode, generateUniqueRefCode } from './share.js';

const callCreditReferral = callable('creditReferral');

/* ================== nick ================== */
// sincroniza o campo de código de indicação na tela de nick com o código
// capturado de ?ref= na URL (ver share.js). Veio de link: trava o campo (não
// dá pra "roubar" a indicação de outra pessoa trocando o valor). Não veio de
// link: deixa livre pra digitar o código de um amigo manualmente.
export function syncRefCodeField() {
  const row = $('ref-code-row');
  const input = $('ref-code-input');
  if (!row || !input) return;
  const referrerCode = getReferrerCode();
  // já veio por link de convite: crédito automático (ver saveNick), esconde o
  // campo de vez — não faz sentido pedir de novo o que já foi capturado
  row.style.display = referrerCode ? 'none' : 'flex';
  if (!referrerCode) input.value = '';
}
// zera a caixinha de consentimento (guideline 5.1.2) toda vez que a tela de
// nick é mostrada — precisa ser marcada de novo a cada visita, não fica
// "lembrada" de uma tentativa anterior
export function resetNickConsent() {
  const cb = $('nick-consent-checkbox');
  if (cb) cb.checked = false;
  const btn = $('nick-confirm-btn');
  if (btn) btn.disabled = true;
}
window.updateNickConfirmState = () => {
  const cb = $('nick-consent-checkbox');
  const btn = $('nick-confirm-btn');
  if (cb && btn) btn.disabled = !cb.checked;
};
window.saveNick = async () => {
  const nick = $('nick-input').value.trim();
  $('nick-error').textContent = '';
  // reforço além do botão desabilitado (que já impede o clique via UI) — só
  // por garantia, caso algo force o clique sem a caixinha marcada
  if (!$('nick-consent-checkbox').checked) {
    $('nick-error').textContent = T[state.lang].err_nick_consent;
    return;
  }
  if (nick.length < 3 || nick.length > 16) {
    $('nick-error').textContent = T[state.lang].err_nick_length;
    return;
  }
  if (/\s/.test(nick)) {
    $('nick-error').textContent = T[state.lang].err_nick_spaces;
    return;
  }
  const nickKey = nick.toLowerCase(); // "Igor" e "IGOR" contam como o mesmo nick
  try {
    const taken = await getDoc(doc(db, 'nicks', nickKey));
    if (taken.exists()) {
      $('nick-error').textContent = T[state.lang].err_nick_taken;
      return;
    }
    const refCode = await generateUniqueRefCode();

    const batch = writeBatch(db);
    batch.set(doc(db, 'nicks', nickKey), { uid: state.currentUser.uid });
    batch.set(doc(db, 'refcodes', refCode), { uid: state.currentUser.uid });
    batch.set(doc(db, 'scores', state.currentUser.uid), {
      nick,
      refCode,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    await batch.commit();
    track('sign_up');
    state.myData.nick = nick;
    state.myData.refCode = refCode;

    // credita a indicação para quem trouxe esse jogador (feito no servidor,
    // já que é uma escrita no documento de OUTRO usuário). referrerCode (de um
    // link ?ref=) tem prioridade; sem link, usa o que a pessoa digitou à mão
    // no campo — um código inválido/inexistente simplesmente não credita nada
    // (ver creditReferral em functions/index.js), sem erro pra pessoa.
    const typedRefCode = ($('ref-code-input').value || '').trim().toUpperCase();
    const codeToCredit = getReferrerCode() || typedRefCode || null;
    if (codeToCredit) {
      try { await callCreditReferral({ refCode: codeToCredit }); } catch {}
      clearReferrerCode();
    }

    await submitPendingScore();
    startPvpListener();
    window.showMenu();
  } catch (e) { $('nick-error').textContent = T[state.lang].err_nick_save(e.message); }
};
