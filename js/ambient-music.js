// música ambiente de fundo — só teste.html por enquanto (ver script no fim
// de teste.html, que é quem importa/liga isso, decide QUANDO abaixa/religa
// e tem o painel de configurações que mexe em musicEnabled/musicVolume;
// index.html não importa este arquivo). 100% sintetizada via Web Audio
// (mesmo padrão do resto dos sons do jogo, ver "sons (Web Audio, sem
// arquivos)" em bootstrap.js) — sem nenhum arquivo de áudio, então sem
// risco nenhum de direito autoral: cada nota é gerada na hora por
// osciladores, não uma gravação de terceiro.
//
// Grade rítmica de verdade (BPM fixo): PAD segura a harmonia, um PULSO DE
// BAIXO marca o tempo a cada 2 batidas e um ARPEJO cruzado (contratempo)
// corre por cima. Progressão C-G-Am-F (I-V-vi-IV), a mesma fórmula
// "animada"/anthemic de synthwave e pop em geral.
import { audioContext } from './utils.js';

const BPM = 128;
const BEAT_SEC = 60 / BPM;
const BEATS_PER_CHORD = 8; // 2 compassos (4/4) por acorde
const CHORDS = [
  [261.63, 329.63, 392.00], // C  (C4 E4 G4)
  [196.00, 246.94, 293.66], // G  (G3 B3 D4)
  [220.00, 261.63, 329.63], // Am (A3 C4 E4)
  [174.61, 220.00, 261.63], // F  (F3 A3 C4)
];
// índice dentro do acorde (0=raiz,1=terça,2=quinta) que o arpejo visita a
// cada batida — raiz-terça-quinta-terça repetido dá aquele "bounce" simples
const ARP_PATTERN = [0, 1, 2, 1];

const PAD_PEAK_GAIN = 0.026;  // por oscilador (3 por nota) — ver playPadChord
const BASS_PEAK_GAIN = 0.07;
const ARP_PEAK_GAIN = 0.05;
const GAIN_RAMP_SEC = 0.15;   // rampa de volume ao abaixar/religar — evita estalo
const DUCK_FACTOR = 0.28;     // volume durante a partida = volume normal × isso (abaixa, não muda)
const SCHEDULE_LOOKAHEAD_SEC = 1;
const SCHEDULE_INTERVAL_MS = 200;

let started = false;
let stopped = true; // true até o scheduler realmente começar a rodar — ver startAmbientMusic/applyGainState
let masterGain = null;
let beatIndex = 0;
let nextBeatAt = 0;

// liga/desliga e volume (0..1) — independentes do mute geral de efeitos
// (isMuted() em utils.js): é exatamente esse o pedido, dar pra ouvir só a
// música, só os efeitos, os dois ou nenhum. Local, com o mesmo padrão de
// persistência do resto do áudio do jogo (ver colorRushMuted/
// colorRushSfxVolume em utils.js).
// desligada por padrão (só liga quem entrar no painel de configurações e
// ligar por conta própria — ver localStorage.getItem abaixo: só fica true
// se alguém já salvou '1' explicitamente algum dia)
let musicEnabled = false;
try { musicEnabled = localStorage.getItem('colorRushMusicEnabled') === '1'; } catch {}
let musicVolume = 0.55;
try {
  const stored = parseFloat(localStorage.getItem('colorRushMusicVolume'));
  if (Number.isFinite(stored) && stored >= 0 && stored <= 1) musicVolume = stored;
} catch {}

export function isMusicEnabled() { return musicEnabled; }
export function setMusicEnabled(v) {
  musicEnabled = v;
  try { localStorage.setItem('colorRushMusicEnabled', v ? '1' : '0'); } catch {}
  if (started) applyGainState();
}
export function getMusicVolume() { return musicVolume; }
export function setMusicVolume(v) {
  musicVolume = Math.max(0, Math.min(1, v));
  try { localStorage.setItem('colorRushMusicVolume', String(musicVolume)); } catch {}
  if (started) applyGainState();
}

// motivos independentes de PARAR de vez (some o scheduler junto, não só o
// volume — ver applyGainState) — hoje só 'hidden' (aba em 2º plano, ver
// teste.html). Um Set, não um bool só, pelo mesmo motivo do duckReasons
// abaixo: precisa sobreviver a sobreposição sem um cancelar o outro à toa.
const stopReasons = new Set();
// motivos independentes de ABAIXAR o volume sem parar o scheduler — hoje só
// 'match' (partida em andamento, ver teste.html): a música continua tocando
// baixinho em vez de sumir, dá pra "continuar ouvindo" (pedido).
const duckReasons = new Set();

function ensureMasterGain() {
  if (masterGain) return masterGain;
  const ctx = audioContext();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0; // applyGainState (chamado logo depois, ver startAmbientMusic) ajusta pro valor certo
  masterGain.connect(ctx.destination);
  return masterGain;
}

function rampGainTo(target) {
  if (!masterGain) return;
  const ctx = audioContext();
  masterGain.gain.linearRampToValueAtTime(target, ctx.currentTime + GAIN_RAMP_SEC);
}

// alvo de volume "de verdade" agora, considerando tudo: desligada de
// propósito, parada de vez (aba oculta), abaixada (partida) ou volume
// normal — nessa ordem de prioridade
function targetGain() {
  if (!musicEnabled || stopReasons.size > 0) return 0;
  if (duckReasons.size > 0) return musicVolume * DUCK_FACTOR;
  return musicVolume;
}

// aplica o volume-alvo na hora (rampa curta) e liga/desliga o SCHEDULER
// (não só o volume) conforme stopReasons/musicEnabled — precisa parar de
// verdade de agendar notas novas quando a aba está oculta (economiza
// recursos) ou a música tá desligada, mas continua rodando normalmente
// enquanto só "abaixada" (duckReasons), senão ela pararia de avançar e
// "voltaria do zero" toda vez que uma partida termina, em vez de continuar
// de onde estava
function applyGainState() {
  rampGainTo(targetGain());
  const shouldRun = musicEnabled && stopReasons.size === 0;
  if (shouldRun && stopped) {
    stopped = false;
    nextBeatAt = audioContext().currentTime;
    scheduler();
  } else if (!shouldRun) {
    stopped = true;
  }
}

// 3 osciladores por nota (afinação levemente diferente cada um) somados no
// mesmo envelope = timbre "coral", mais quente que um oscilador só
function playPadChord(chord, startTime, beats) {
  const ctx = audioContext();
  const duration = beats * BEAT_SEC;
  chord.forEach((freq) => {
    [0, -6, 6].forEach((detune) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(PAD_PEAK_GAIN, startTime + 0.3); // ataque rápido — entra na hora
      gain.gain.linearRampToValueAtTime(0, startTime + duration);
      osc.connect(gain); gain.connect(masterGain);
      osc.start(startTime); osc.stop(startTime + duration + 0.1);
    });
  });
}

// pulso curto e percussivo na fundamental (1 oitava abaixo do pad) — o que
// dá a sensação de "batida" marcando o tempo
function playBassPulse(freq, startTime) {
  const ctx = audioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq / 2;
  gain.gain.setValueAtTime(BASS_PEAK_GAIN, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + BEAT_SEC * 1.6);
  osc.connect(gain); gain.connect(masterGain);
  osc.start(startTime); osc.stop(startTime + BEAT_SEC * 1.7);
}

function playArpNote(freq, startTime) {
  const ctx = audioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(ARP_PEAK_GAIN, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + BEAT_SEC * 0.9);
  osc.connect(gain); gain.connect(masterGain);
  osc.start(startTime); osc.stop(startTime + BEAT_SEC);
}

function scheduler() {
  if (stopped) return;
  const ctx = audioContext();
  const now = ctx.currentTime;

  while (nextBeatAt < now + SCHEDULE_LOOKAHEAD_SEC) {
    const chordIdx = Math.floor(beatIndex / BEATS_PER_CHORD) % CHORDS.length;
    const beatInChord = beatIndex % BEATS_PER_CHORD;
    const chord = CHORDS[chordIdx];

    if (beatInChord === 0) playPadChord(chord, nextBeatAt, BEATS_PER_CHORD);
    if (beatInChord % 2 === 0) playBassPulse(chord[0], nextBeatAt);
    // contratempo (meia batida depois） + 1 oitava acima do pad — separa o
    // arpejo do resto texturalmente, em vez de tocar em cima do pulso
    const arpFreq = chord[ARP_PATTERN[beatIndex % ARP_PATTERN.length] % chord.length] * 2;
    playArpNote(arpFreq, nextBeatAt + BEAT_SEC / 2);

    nextBeatAt += BEAT_SEC;
    beatIndex++;
  }
  setTimeout(scheduler, SCHEDULE_INTERVAL_MS);
}

// chamar de dentro de um gesto do usuário (clique/toque) — navegador não
// deixa tocar áudio sozinho antes disso; ver listener 'pointerdown'/
// 'keydown' com {once:true} no fim do teste.html.
export function startAmbientMusic() {
  if (started) return;
  started = true;
  ensureMasterGain();
  beatIndex = 0;
  applyGainState();
}

// para de vez (some o scheduler) — hoje só usado pra aba em 2º plano
// ('hidden', ver teste.html). reason: string livre; cada motivo só cancela
// a SI PRÓPRIO, a música só volta quando NENHUM motivo restar (evita que
// tirar um motivo religue com o outro ainda valendo — ver stopReasons).
export function pauseAmbientMusic(reason = 'default') {
  stopReasons.add(reason);
  if (started) applyGainState();
}
export function resumeAmbientMusic(reason = 'default') {
  if (!started) return;
  stopReasons.delete(reason);
  applyGainState();
}

// abaixa o volume (não para o scheduler) — usado durante a partida
// ('match', ver teste.html), pra dar pra "continuar ouvindo" só mais baixo
// em vez de sumir. Mesma lógica de motivos independentes do pause acima.
export function duckAmbientMusic(reason = 'default') {
  duckReasons.add(reason);
  if (started) applyGainState();
}
export function unduckAmbientMusic(reason = 'default') {
  if (!started) return;
  duckReasons.delete(reason);
  applyGainState();
}
