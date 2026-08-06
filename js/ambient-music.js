// música ambiente de fundo — só teste.html por enquanto (ver script no fim
// de teste.html, que é quem importa e liga isso; index.html não importa
// este arquivo). 100% sintetizada via Web Audio (mesmo padrão do resto dos
// sons do jogo, ver "sons (Web Audio, sem arquivos)" em bootstrap.js) — sem
// nenhum arquivo de áudio, então sem risco nenhum de direito autoral: cada
// nota é gerada na hora por osciladores, não uma gravação de terceiro.
//
// Um "pad" (acordes longos e suaves, 3 osciladores levemente desafinados
// por nota pra dar um ar de coro/sintetizador quente) mais um arpejo
// esparso por cima (uma nota solta de vez em quando, uma oitava acima, só
// pra dar um pouco de movimento sem virar melodia de verdade). Progressão
// simples em Lá menor (Am-F-C-G), bem lenta e baixinha — é fundo, não
// protagonista.
import { audioContext, isMuted } from './utils.js';

const CHORDS = [
  [220.00, 261.63, 329.63], // Am
  [174.61, 220.00, 261.63], // F
  [261.63, 329.63, 392.00], // C
  [196.00, 246.94, 293.66], // G
];
const CHORD_SECONDS = 7;   // quanto tempo cada acorde fica soando
const ARP_SECONDS = 1.7;   // intervalo entre notas soltas do arpejo
const PAD_PEAK_GAIN = 0.035; // por oscilador (3 por nota) — ver playPadNote
const ARP_PEAK_GAIN = 0.05;
const SCHEDULE_LOOKAHEAD = 1; // agenda o que vai tocar no próximo 1s
const SCHEDULE_INTERVAL_MS = 400;

let started = false;
let stopped = false;
let masterGain = null;
let chordIndex = 0;
let nextChordAt = 0;
let nextArpAt = 0;
let arpStepInChord = 0;

function ensureMasterGain() {
  if (masterGain) return masterGain;
  const ctx = audioContext();
  masterGain = ctx.createGain();
  masterGain.gain.value = isMuted() ? 0 : 1;
  masterGain.connect(ctx.destination);
  return masterGain;
}

// 3 osciladores por nota (afinação levemente diferente cada um) somados no
// mesmo envelope = timbre "coral", mais quente que um oscilador só; attack
// lento (1.5s) pra entrar suave, sem esse ataque perceptível
function playPadNote(freq, startTime, duration) {
  const ctx = audioContext();
  [0, -6, 6].forEach((detune) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.detune.value = detune;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(PAD_PEAK_GAIN, startTime + 1.5);
    gain.gain.linearRampToValueAtTime(0, startTime + duration);
    osc.connect(gain); gain.connect(masterGain);
    osc.start(startTime); osc.stop(startTime + duration + 0.1);
  });
}

function playArpNote(freq, startTime) {
  const ctx = audioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(ARP_PEAK_GAIN, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + 1.4);
  osc.connect(gain); gain.connect(masterGain);
  osc.start(startTime); osc.stop(startTime + 1.5);
}

// silencia/religa instantâneo (mesmo com notas já agendadas tocando) — o
// mute geral do jogo (isMuted()/toggleMute em bootstrap.js) não é reativo
// (é só uma variável), então precisa ficar checando aqui; rampa curta de
// 0.15s em vez de salto seco pra não estalar
function syncMuteState() {
  const ctx = audioContext();
  const target = isMuted() ? 0 : 1;
  if (masterGain.gain.value !== target) {
    masterGain.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.15);
  }
}

function scheduler() {
  if (stopped) return;
  const ctx = audioContext();
  const now = ctx.currentTime;
  syncMuteState();

  if (nextChordAt <= now + SCHEDULE_LOOKAHEAD) {
    const chord = CHORDS[chordIndex % CHORDS.length];
    const startAt = Math.max(nextChordAt, now + 0.05);
    chord.forEach((freq) => playPadNote(freq, startAt, CHORD_SECONDS + 1));
    nextChordAt = startAt + CHORD_SECONDS;
    chordIndex++;
    arpStepInChord = 0;
  }
  if (nextArpAt <= now + SCHEDULE_LOOKAHEAD) {
    const currentChord = CHORDS[(chordIndex - 1 + CHORDS.length) % CHORDS.length];
    const note = currentChord[arpStepInChord % currentChord.length] * 2; // uma oitava acima do pad
    const startAt = Math.max(nextArpAt, now + 0.05);
    playArpNote(note, startAt);
    nextArpAt = startAt + ARP_SECONDS;
    arpStepInChord++;
  }
  setTimeout(scheduler, SCHEDULE_INTERVAL_MS);
}

// chamar de dentro de um gesto do usuário (clique/toque) — navegador não
// deixa tocar áudio sozinho antes disso; ver listener 'pointerdown'/
// 'keydown' com {once:true} no fim do teste.html
export function startAmbientMusic() {
  if (started) return;
  started = true;
  ensureMasterGain();
  const ctx = audioContext();
  nextChordAt = ctx.currentTime;
  nextArpAt = ctx.currentTime + 2;
  scheduler();
}

// pausa/despausa sem perder o lugar na progressão (só para/retoma o
// scheduler; nextChordAt/nextArpAt continuam de onde pararam, e como são
// comparados com ctx.currentTime na volta, o scheduler recalcula o "agora"
// sozinho em vez de tentar tocar tudo que passou de uma vez)
export function pauseAmbientMusic() { stopped = true; }
export function resumeAmbientMusic() {
  if (!started || !stopped) return;
  stopped = false;
  scheduler();
}
