import { STT_LANGUAGES } from './stt-languages';
import { t } from './i18n';

const STORAGE_KEY = 'comesade.stt-language';
const MIC_STORAGE_KEY = 'comesade.microphone-id';
const MAX_RECORD_MS = 30_000;

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let stream: MediaStream | null = null;
let recording = false;
let transcribing = false;
let stopTimer: number | null = null;
let meterContext: AudioContext | null = null;
let meterRaf = 0;
let meterGeneration = 0;
let starting = false;
let stopping = false;

function readStoredValue(key: string): string {
  try {
    return window.localStorage.getItem(key)?.trim() ?? '';
  } catch {
    return '';
  }
}

function writeStoredValue(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in restricted WebViews.
  }
}

function preferredLanguage(): string {
  const stored = readStoredValue(STORAGE_KEY);
  if (stored && STT_LANGUAGES.some((item) => item.id === stored)) return stored;
  const nav = (navigator.language || 'es').slice(0, 2).toLowerCase();
  return STT_LANGUAGES.some((item) => item.id === nav) ? nav : 'es';
}

export function getSelectedMicrophoneId(): string {
  return readStoredValue(MIC_STORAGE_KEY);
}

export function setSelectedMicrophoneId(id: string): void {
  writeStoredValue(MIC_STORAGE_KEY, id.trim());
}

export type MicrophoneOption = { id: string; label: string };

export async function listMicrophones(): Promise<MicrophoneOption[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const mapDevices = (devices: MediaDeviceInfo[]): MicrophoneOption[] => devices
    .filter((device) => device.kind === 'audioinput')
    .map((device, index) => ({
      id: device.deviceId,
      label: device.label.trim() || t('toast.micLabel', { n: index + 1 }),
    }))
    .filter((device) => device.id);

  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
  const unlabeled = devices.some((device) => device.kind === 'audioinput' && !device.label);
  if (unlabeled && navigator.mediaDevices.getUserMedia) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((track) => track.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      // Permission denied: keep whatever enumerateDevices already returned.
    }
  }
  return mapDevices(devices);
}

function microphoneConstraints(): MediaTrackConstraints {
  const deviceId = getSelectedMicrophoneId();
  const constraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    channelCount: 1,
    sampleRate: 16_000,
  };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  return constraints;
}

function appendTranscript(input: HTMLTextAreaElement, text: string, resize: () => void): void {
  const value = input.value;
  const glue = !value || /\s$/.test(value) ? '' : ' ';
  input.value = `${value}${glue}${text}`.trimStart();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  resize();
  input.focus();
}

function mimeType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return types.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

function stopListeningMeter(): void {
  meterGeneration += 1;
  if (meterRaf) {
    window.cancelAnimationFrame(meterRaf);
    meterRaf = 0;
  }
  if (meterContext) {
    void meterContext.close().catch(() => undefined);
    meterContext = null;
  }
}

function startListeningMeter(media: MediaStream, barsHost: HTMLElement | null): void {
  stopListeningMeter();
  const bars = barsHost ? Array.from(barsHost.querySelectorAll<HTMLElement>('i')) : [];
  if (!bars.length) return;
  const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  try {
    context = new AudioCtx();
    const source = context.createMediaStreamSource(media);
    analyser = context.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.55;
    source.connect(analyser);
  } catch {
    if (context) void context.close().catch(() => undefined);
    return;
  }
  if (!context || !analyser) return;
  const audioContext = context;
  const audioAnalyser = analyser;
  meterContext = audioContext;
  const generation = meterGeneration;
  const samples = new Uint8Array(audioAnalyser.frequencyBinCount);
  const tick = (): void => {
    if (meterGeneration !== generation || meterContext !== audioContext) return;
    try {
      audioAnalyser.getByteFrequencyData(samples);
    } catch {
      stopListeningMeter();
      return;
    }
    const count = bars.length;
    for (let index = 0; index < count; index += 1) {
      const sampleIndex = Math.floor((index / count) * samples.length);
      const amplitude = (samples[sampleIndex] ?? 0) / 255;
      bars[index].style.transform = `scaleY(${0.12 + amplitude * 0.88})`;
    }
    meterRaf = window.requestAnimationFrame(tick);
  };
  void audioContext.resume().then(() => {
    if (meterGeneration === generation && meterContext === audioContext) tick();
  }).catch(() => undefined);
}

export function bindComposerSpeech(options: {
  input: HTMLTextAreaElement;
  mic: HTMLButtonElement;
  lang: HTMLSelectElement;
  resize: () => void;
  toast: (message: string, error?: boolean) => void;
  canStart?: () => string | null;
  transcribe: (blob: Blob, language: string) => Promise<string>;
  listening?: HTMLElement | null;
  listeningBars?: HTMLElement | null;
}): void {
  const { input, mic, lang, resize, toast, canStart, transcribe, listening, listeningBars } = options;
  lang.innerHTML = STT_LANGUAGES.map((item) => `<option value="${item.id}">${item.id === 'auto' ? t('lang.autoShort') : item.label}</option>`).join('');
  lang.value = preferredLanguage();
  lang.addEventListener('change', () => {
    writeStoredValue(STORAGE_KEY, lang.value);
  });

  const setListening = (active: boolean): void => {
    document.querySelector('#native-agent-panel')?.classList.toggle('is-listening', active);
    if (!listening) return;
    listening.hidden = !active;
    if (!active && listeningBars) {
      listeningBars.querySelectorAll<HTMLElement>('i').forEach((bar) => {
        bar.style.transform = 'scaleY(0.12)';
      });
    }
  };

  const clearStopTimer = (): void => {
    if (stopTimer !== null) {
      window.clearTimeout(stopTimer);
      stopTimer = null;
    }
  };

  const stopTracks = (): void => {
    clearStopTimer();
    stopListeningMeter();
    setListening(false);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    recorder = null;
    chunks = [];
    recording = false;
    stopping = false;
    mic.classList.remove('is-recording');
    mic.setAttribute('aria-pressed', 'false');
    mic.title = t('chrome.dictationTitle');
  };

  const finish = async (): Promise<void> => {
    const currentRecorder = recorder;
    const blob = new Blob(chunks, { type: currentRecorder?.mimeType || 'audio/webm' });
    stopTracks();
    if (blob.size < 800) {
      toast(t('toast.noAudio'), true);
      return;
    }
    transcribing = true;
    mic.disabled = true;
    mic.title = t('chrome.dictationTranscribing');
    toast(t('toast.transcribing'));
    try {
      const text = await transcribe(blob, lang.value);
      const transcript = text.trim();
      if (!transcript) {
        toast(t('toast.noSpeech'), true);
        return;
      }
      appendTranscript(input, transcript, resize);
    } catch (error) {
      const detail = String(error).replace(/^Error:\s*/, '').trim() || t('common.error');
      toast(t('toast.sttFail', { error: detail }), true);
    } finally {
      transcribing = false;
      mic.disabled = false;
      mic.title = t('chrome.dictationTitle');
    }
  };

  mic.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (transcribing || starting || stopping) return;
    const blocked = canStart?.();
    if (blocked) {
      toast(blocked, true);
      return;
    }
    if (recording && recorder && recorder.state !== 'inactive') {
      stopping = true;
      recorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast(t('toast.micWebview'), true);
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      toast(t('toast.micWebview'), true);
      return;
    }
    starting = true;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints() });
      } catch (error) {
        if (!getSelectedMicrophoneId()) throw error;
        setSelectedMicrophoneId('');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1, sampleRate: 16_000 },
        });
      }
      const type = mimeType();
      recorder = type
        ? new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 64_000 })
        : new MediaRecorder(stream);
      chunks = [];
      recorder.ondataavailable = (dataEvent) => {
        if (dataEvent.data.size) chunks.push(dataEvent.data);
      };
      recorder.onerror = () => {
        if (recorder) recorder.onstop = null;
        toast(t('toast.micRecordFail'), true);
        stopTracks();
      };
      recorder.onstop = () => {
        void finish();
      };
      recorder.start(250);
      recording = true;
      mic.classList.add('is-recording');
      mic.setAttribute('aria-pressed', 'true');
      mic.title = t('chrome.dictationStop');
      setListening(true);
      startListeningMeter(stream, listeningBars ?? null);
      stopTimer = window.setTimeout(() => {
        if (recorder && recorder.state !== 'inactive') {
          stopping = true;
          recorder.stop();
        }
      }, MAX_RECORD_MS);
    } catch (error) {
      stopTracks();
      toast(t('toast.micFail', { error: String(error) }), true);
    } finally {
      starting = false;
    }
  });
}
