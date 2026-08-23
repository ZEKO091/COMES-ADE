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

function preferredLanguage(): string {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && STT_LANGUAGES.some((item) => item.id === stored)) return stored;
  const nav = (navigator.language || 'es').slice(0, 2).toLowerCase();
  return STT_LANGUAGES.some((item) => item.id === nav) ? nav : 'es';
}

export function getSelectedMicrophoneId(): string {
  return window.localStorage.getItem(MIC_STORAGE_KEY)?.trim() ?? '';
}

export function setSelectedMicrophoneId(id: string): void {
  const value = id.trim();
  if (value) window.localStorage.setItem(MIC_STORAGE_KEY, value);
  else window.localStorage.removeItem(MIC_STORAGE_KEY);
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

  let devices = await navigator.mediaDevices.enumerateDevices();
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
  return types.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

function stopListeningMeter(): void {
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
  const context = new AudioCtx();
  meterContext = context;
  const source = context.createMediaStreamSource(media);
  const analyser = context.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.55;
  source.connect(analyser);
  const samples = new Uint8Array(analyser.frequencyBinCount);
  const tick = (): void => {
    analyser.getByteFrequencyData(samples);
    const count = bars.length;
    for (let index = 0; index < count; index += 1) {
      const sampleIndex = Math.floor((index / count) * samples.length);
      const amplitude = (samples[sampleIndex] ?? 0) / 255;
      bars[index].style.transform = `scaleY(${0.12 + amplitude * 0.88})`;
    }
    meterRaf = window.requestAnimationFrame(tick);
  };
  void context.resume().then(tick).catch(() => undefined);
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
  lang.innerHTML = STT_LANGUAGES.map((item) => `<option value="${item.id}">${item.label}</option>`).join('');
  lang.value = preferredLanguage();
  lang.addEventListener('change', () => {
    window.localStorage.setItem(STORAGE_KEY, lang.value);
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
    mic.classList.remove('is-recording');
    mic.setAttribute('aria-pressed', 'false');
    mic.title = t('chrome.dictationTitle');
  };

  const finish = async (): Promise<void> => {
    const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
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
      if (!text) {
        toast(t('toast.noSpeech'), true);
        return;
      }
      appendTranscript(input, text, resize);
    } catch (error) {
      toast(String(error).replace(/^Error:\s*/, ''), true);
    } finally {
      transcribing = false;
      mic.disabled = false;
      mic.title = t('chrome.dictationTitle');
    }
  };

  mic.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (transcribing) return;
    const blocked = canStart?.();
    if (blocked) {
      toast(blocked, true);
      return;
    }
    if (recording && recorder && recorder.state !== 'inactive') {
      recorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast(t('toast.micWebview'), true);
      return;
    }
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
        if (recorder && recorder.state !== 'inactive') recorder.stop();
      }, MAX_RECORD_MS);
    } catch (error) {
      stopTracks();
      toast(t('toast.micFail', { error: String(error) }), true);
    }
  });
}
