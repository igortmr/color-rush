import {
  doc, getDoc, setDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { db } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { track } from './utils.js';
import { modeLabel } from './levels.js';
import { mode, score } from './game-core.js';
import { buildShareImageBlob } from './share-image.js';

/* ================== indicação (referral) ================== */
// captura ?ref=<código curto> da URL de compartilhamento e guarda até o cadastro terminar
let referrerCode = new URLSearchParams(location.search).get('ref') || null;
if (referrerCode) {
  try { sessionStorage.setItem('colorRushRef', referrerCode); } catch {}
} else {
  try { referrerCode = sessionStorage.getItem('colorRushRef'); } catch {}
}
if (location.search) history.replaceState({}, '', location.pathname); // limpa ?ref= / ?v= da URL visível

// lido/escrito tanto por aqui (crédito automático ao compartilhar) quanto por
// js/auth.js (proceedAfterLogin) e js/nick.js (saveNick) — os dois também
// precisam limpar o código depois de creditar, por isso getter/setter em vez
// de exportado direto (ver comentário equivalente em screenBackStack, js/nav.js)
export function getReferrerCode() { return referrerCode; }
export function clearReferrerCode() {
  referrerCode = null;
  try { sessionStorage.removeItem('colorRushRef'); } catch {}
}

const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I/L, pra não confundir
export async function generateUniqueRefCode() {
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += REF_CHARS[Math.floor(Math.random() * REF_CHARS.length)];
    const snap = await getDoc(doc(db, 'refcodes', code));
    if (!snap.exists()) return code;
  }
  return Math.random().toString(36).slice(2, 8).toUpperCase(); // fallback improvável
}
async function ensureRefCode() {
  if (state.myData.refCode) return state.myData.refCode;
  try {
    const code = await generateUniqueRefCode();
    await setDoc(doc(db, 'refcodes', code), { uid: state.currentUser.uid });
    await setDoc(doc(db, 'scores', state.currentUser.uid), { refCode: code, updatedAt: serverTimestamp() }, { merge: true });
    state.myData.refCode = code;
  } catch {}
  return state.myData.refCode;
}

/* ================== compartilhar ================== */
// monta o link de compartilhamento — ?ref= só existe pra quem tem conta (conta pro
// badge Divulgador) e &state.lang= só é incluído quando o idioma não é o padrão (pt), pra
// quem clicar já abrir o site traduzido em vez de cair sempre em português
async function buildShareLink() {
  let link = `${location.origin}${location.pathname}`;
  const params = [];
  if (!state.offline && state.currentUser) {
    const code = await ensureRefCode();
    if (code) params.push(`ref=${code}`);
  }
  if (state.lang !== 'pt') params.push(`state.lang=${state.lang}`);
  if (params.length) link += `?${params.join('&')}`;
  return link;
}

window.shareScore = async () => {
  track('share', { content_type: 'score', mode });
  const modeName = modeLabel(mode);
  const rec = $('new-record').classList.contains('show') ? T[state.lang].share_new_record_suffix : '';
  const link = await buildShareLink();
  const text = T[state.lang].share_text(score, modeName, rec, link);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // gera o cartão de pontuação em canvas (ver js/share-image.js) — se algo
  // der errado (ex.: navegador antigo sem toBlob), cai pro compartilhamento
  // só com texto, que já funcionava antes dessa imagem existir
  let file = null;
  try {
    const blob = await buildShareImageBlob(score);
    if (blob) file = new File([blob], 'color-rush.jpg', { type: 'image/jpeg' });
  } catch {}

  try {
    if (isMobile && navigator.share) {
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ text, files: [file] });
          return;
        } catch {
          // usuário cancelou o share nativo (ou o navegador recusou o
          // arquivo) — não cai pro texto puro nesse caso pra não abrir um
          // segundo compartilhamento logo depois de fechar o primeiro
          return;
        }
      }
      await navigator.share({ text });
    } else {
      if (file) {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'color-rush.jpg';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
      }
      openShareTextModal(text);
    }
  } catch {}
};

// popup temática do computador (sem Web Share API) — mostra o texto pronto
// pra conferir/selecionar manualmente ou copiar com um clique (ver
// #share-text-modal em index.html)
window.openShareTextModal = (text) => {
  $('share-text-modal-box').value = text;
  $('share-text-modal-status').textContent = '';
  $('share-text-modal').style.display = 'flex';
};
window.closeShareTextModal = () => {
  $('share-text-modal').style.display = 'none';
};
window.copyShareTextModal = async () => {
  try {
    await navigator.clipboard.writeText($('share-text-modal-box').value);
    $('share-text-modal-status').textContent = T[state.lang].share_copied;
    setTimeout(() => { $('share-text-modal-status').textContent = ''; }, 3000);
  } catch {}
};

/* ================== convidar amigos (sem precisar terminar partida) ================== */
window.inviteFriends = async (statusElId = 'invite-status') => {
  track('share', { content_type: 'invite' });
  const link = await buildShareLink();
  const text = T[state.lang].invite_text(link);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const statusEl = $(statusElId);
  try {
    if (isMobile && navigator.share) {
      await navigator.share({ text });
    } else {
      await navigator.clipboard.writeText(text);
      if (statusEl) {
        // esses status ficam "display:none" quando vazios (ver HTML) — só
        // um textContent sozinho deixava um espaço fantasma reservado pelo
        // gap do flex mesmo sem nenhum texto aparecendo (esticava, por
        // exemplo, o espaço entre o nick e o botão de amizade no perfil)
        statusEl.style.display = '';
        statusEl.textContent = T[state.lang].share_copied;
        setTimeout(() => { statusEl.textContent = ''; statusEl.style.display = 'none'; }, 3000);
      }
    }
  } catch {}
};

// copia só o código puro (não o link inteiro) — pra passar de viva voz/
// WhatsApp e o amigo colar direto no campo de indicação da tela de nick (ver
// ref-code-input/syncRefCodeField)
window.copyRefCode = async (statusElId) => {
  if (!state.myData.refCode) return;
  try {
    await navigator.clipboard.writeText(state.myData.refCode);
    const el = $(statusElId);
    if (el) {
      el.style.display = ''; // ver comentário equivalente em inviteFriends
      el.textContent = T[state.lang].share_copied;
      setTimeout(() => { el.textContent = ''; el.style.display = 'none'; }, 3000);
    }
  } catch {}
};
