// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, JsFunction, JsUnknown};

use crate::resample::SincResampler;
use crate::ring::SpscRing;

const OUTPUT_SAMPLE_RATE: usize = 16_000;
const OUTPUT_CHUNK_SAMPLES: usize = 800;
const SILENCE_SAMPLES: usize = OUTPUT_SAMPLE_RATE * 2;
const SILENCE_THRESHOLD: f64 = 0.03;
const START_TIMEOUT: Duration = Duration::from_secs(5);

type DataThreadsafeFunction = ThreadsafeFunction<Vec<u8>, ErrorStrategy::Fatal>;
type EndThreadsafeFunction = ThreadsafeFunction<(), ErrorStrategy::Fatal>;

static OPERATION_LOCK: Mutex<()> = Mutex::new(());
static HANDLE: OnceLock<Mutex<Option<RecordingHandle>>> = OnceLock::new();

pub(crate) struct RecordingHandle {
    stop_tx: mpsc::Sender<()>,
    cancelled: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    worker: JoinHandle<()>,
}

pub(crate) fn start(env: Env, on_data: JsFunction, on_end: JsFunction) -> bool {
    let _operation = lock_recover(&OPERATION_LOCK);
    stop_current();

    let mut data_callback: DataThreadsafeFunction = match on_data
        .create_threadsafe_function(0, |ctx: ThreadSafeCallContext<Vec<u8>>| {
            Ok(vec![Buffer::from(ctx.value)])
        }) {
        Ok(callback) => callback,
        Err(_) => return false,
    };
    if data_callback.unref(&env).is_err() {
        return false;
    }

    let mut end_callback: EndThreadsafeFunction = match on_end.create_threadsafe_function(
        0,
        |_ctx: ThreadSafeCallContext<()>| -> napi::Result<Vec<JsUnknown>> { Ok(Vec::new()) },
    ) {
        Ok(callback) => callback,
        Err(_) => return false,
    };
    if end_callback.unref(&env).is_err() {
        return false;
    }

    let (stop_tx, stop_rx) = mpsc::channel();
    let (status_tx, status_rx) = mpsc::sync_channel(1);
    let cancelled = Arc::new(AtomicBool::new(false));
    let running = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let worker_running = Arc::clone(&running);
    let worker = match thread::Builder::new()
        .name("audio-capture-input".to_owned())
        .spawn(move || {
            recording_worker(
                stop_rx,
                status_tx,
                worker_cancelled,
                worker_running,
                data_callback,
                end_callback,
            );
        }) {
        Ok(worker) => worker,
        Err(_) => return false,
    };

    match status_rx.recv_timeout(START_TIMEOUT) {
        Ok(true) => {
            *lock_recover(handle_slot()) = Some(RecordingHandle {
                stop_tx,
                cancelled,
                running,
                worker,
            });
            true
        }
        Ok(false) => {
            cancelled.store(true, Ordering::Release);
            let _ = stop_tx.send(());
            let _ = worker.join();
            false
        }
        Err(_) => {
            cancelled.store(true, Ordering::Release);
            running.store(false, Ordering::Release);
            let _ = stop_tx.send(());
            // A platform call that exceeded the bounded startup wait must not
            // make the synchronous N-API call wait indefinitely. The worker
            // observes `cancelled` before publishing a live stream.
            drop(worker);
            false
        }
    }
}

pub(crate) fn stop() {
    let _operation = lock_recover(&OPERATION_LOCK);
    stop_current();
}

pub(crate) fn is_active() -> bool {
    lock_recover(handle_slot())
        .as_ref()
        .is_some_and(|handle| handle.running.load(Ordering::Acquire))
}

fn stop_current() {
    let handle = lock_recover(handle_slot()).take();
    if let Some(handle) = handle {
        handle.running.store(false, Ordering::Release);
        handle.cancelled.store(true, Ordering::Release);
        let _ = handle.stop_tx.send(());
        let _ = handle.worker.join();
    }
}

fn handle_slot() -> &'static Mutex<Option<RecordingHandle>> {
    HANDLE.get_or_init(|| Mutex::new(None))
}

fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn recording_worker(
    stop_rx: mpsc::Receiver<()>,
    status_tx: mpsc::SyncSender<bool>,
    cancelled: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    data_callback: DataThreadsafeFunction,
    end_callback: EndThreadsafeFunction,
) {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        let _ = status_tx.send(false);
        return;
    };
    let Ok(supported_config) = device.default_input_config() else {
        let _ = status_tx.send(false);
        return;
    };

    let sample_format = supported_config.sample_format();
    let config: cpal::StreamConfig = supported_config.into();
    if config.channels == 0 || config.sample_rate.0 == 0 {
        let _ = status_tx.send(false);
        return;
    }

    let ring_capacity = ((config.sample_rate.0 as usize) / 10).clamp(1, 131_072);
    let Some(ring) = SpscRing::new(ring_capacity) else {
        let _ = status_tx.send(false);
        return;
    };
    let ring = Arc::new(ring);

    let stream = match build_input_stream(
        &device,
        &config,
        sample_format,
        Arc::clone(&ring),
        Arc::clone(&running),
    ) {
        Ok(stream) => stream,
        Err(_) => {
            let _ = status_tx.send(false);
            return;
        }
    };

    if cancelled.load(Ordering::Acquire) {
        let _ = status_tx.send(false);
        return;
    }

    running.store(true, Ordering::Release);
    if stream.play().is_err() {
        running.store(false, Ordering::Release);
        let _ = status_tx.send(false);
        return;
    }

    let input_rate = config.sample_rate.0;
    let pump_running = Arc::clone(&running);
    let pump = match thread::Builder::new()
        .name("audio-capture-napi-pump".to_owned())
        .spawn(move || {
            recording_pump(ring, input_rate, pump_running, data_callback, end_callback);
        }) {
        Ok(pump) => pump,
        Err(_) => {
            running.store(false, Ordering::Release);
            let _ = status_tx.send(false);
            return;
        }
    };

    if status_tx.send(true).is_err() {
        running.store(false, Ordering::Release);
        let _ = pump.join();
        return;
    }

    while running.load(Ordering::Acquire) && !cancelled.load(Ordering::Acquire) {
        match stop_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }

    running.store(false, Ordering::Release);
    drop(stream);
    let _ = pump.join();
}

fn build_input_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    ring: Arc<SpscRing<f32>>,
    running: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    match sample_format {
        cpal::SampleFormat::I8 => build_typed_input_stream::<i8>(device, config, ring, running),
        cpal::SampleFormat::I16 => build_typed_input_stream::<i16>(device, config, ring, running),
        cpal::SampleFormat::I32 => build_typed_input_stream::<i32>(device, config, ring, running),
        cpal::SampleFormat::I64 => build_typed_input_stream::<i64>(device, config, ring, running),
        cpal::SampleFormat::U8 => build_typed_input_stream::<u8>(device, config, ring, running),
        cpal::SampleFormat::U16 => build_typed_input_stream::<u16>(device, config, ring, running),
        cpal::SampleFormat::U32 => build_typed_input_stream::<u32>(device, config, ring, running),
        cpal::SampleFormat::U64 => build_typed_input_stream::<u64>(device, config, ring, running),
        cpal::SampleFormat::F32 => build_typed_input_stream::<f32>(device, config, ring, running),
        cpal::SampleFormat::F64 => build_typed_input_stream::<f64>(device, config, ring, running),
        _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
    }
}

fn build_typed_input_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    ring: Arc<SpscRing<f32>>,
    running: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample + InputSample,
{
    let channels = usize::from(config.channels);
    let error_running = Arc::clone(&running);
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            if running.load(Ordering::Relaxed) {
                capture_input(data, channels, &ring);
            }
        },
        move |_| error_running.store(false, Ordering::Release),
        None,
    )
}

#[inline]
fn capture_input<T: InputSample>(data: &[T], channels: usize, ring: &SpscRing<f32>) {
    for frame in data.chunks_exact(channels) {
        let sum = frame.iter().fold(0.0_f64, |accumulator, sample| {
            accumulator + sample.normalized()
        });
        let mono = sum / channels as f64;
        let mono = if mono.is_finite() {
            mono.clamp(-1.0, 1.0) as f32
        } else {
            0.0
        };
        let _ = ring.push(mono);
    }
}

fn recording_pump(
    ring: Arc<SpscRing<f32>>,
    input_rate: u32,
    running: Arc<AtomicBool>,
    data_callback: DataThreadsafeFunction,
    end_callback: EndThreadsafeFunction,
) {
    let Some(mut resampler) = SincResampler::new(input_rate) else {
        running.store(false, Ordering::Release);
        return;
    };
    let mut chunk = Vec::with_capacity(OUTPUT_CHUNK_SAMPLES);
    let mut speech_observed = false;
    let mut silent_samples = 0_usize;

    while running.load(Ordering::Acquire) {
        let mut did_work = false;
        for _ in 0..8_192 {
            let Some(sample) = ring.pop() else {
                break;
            };
            did_work = true;
            resampler.push(sample);
            while let Some(output) = resampler.next_sample() {
                chunk.push(output);
                if chunk.len() == OUTPUT_CHUNK_SAMPLES {
                    let should_end = emit_chunk(
                        &chunk,
                        &data_callback,
                        &mut speech_observed,
                        &mut silent_samples,
                    );
                    chunk.clear();
                    if should_end {
                        let _ = end_callback.call((), ThreadsafeFunctionCallMode::NonBlocking);
                        running.store(false, Ordering::Release);
                        break;
                    }
                }
            }
            if !running.load(Ordering::Acquire) {
                break;
            }
        }

        if !did_work && running.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(2));
        }
    }
}

fn emit_chunk(
    chunk: &[i16],
    callback: &DataThreadsafeFunction,
    speech_observed: &mut bool,
    silent_samples: &mut usize,
) -> bool {
    let mut bytes = Vec::with_capacity(chunk.len() * 2);
    let square_sum = chunk.iter().fold(0.0_f64, |sum, sample| {
        bytes.extend_from_slice(&sample.to_le_bytes());
        let normalized = f64::from(*sample) / 32_768.0;
        sum + normalized * normalized
    });
    let _ = callback.call(bytes, ThreadsafeFunctionCallMode::NonBlocking);

    let level = (square_sum / chunk.len() as f64).sqrt();
    if level >= SILENCE_THRESHOLD {
        *speech_observed = true;
        *silent_samples = 0;
        return false;
    }
    if !*speech_observed {
        return false;
    }

    *silent_samples = silent_samples.saturating_add(chunk.len());
    *silent_samples >= SILENCE_SAMPLES
}

trait InputSample: Copy + Send + 'static {
    fn normalized(self) -> f64;
}

macro_rules! impl_signed_input_sample {
    ($sample:ty, $scale:expr) => {
        impl InputSample for $sample {
            #[inline]
            fn normalized(self) -> f64 {
                self as f64 / $scale
            }
        }
    };
}

macro_rules! impl_unsigned_input_sample {
    ($sample:ty, $midpoint:expr) => {
        impl InputSample for $sample {
            #[inline]
            fn normalized(self) -> f64 {
                (self as f64 - $midpoint) / $midpoint
            }
        }
    };
}

impl_signed_input_sample!(i8, 128.0);
impl_signed_input_sample!(i16, 32_768.0);
impl_signed_input_sample!(i32, 2_147_483_648.0);
impl_signed_input_sample!(i64, 9_223_372_036_854_775_808.0);
impl_unsigned_input_sample!(u8, 128.0);
impl_unsigned_input_sample!(u16, 32_768.0);
impl_unsigned_input_sample!(u32, 2_147_483_648.0);
impl_unsigned_input_sample!(u64, 9_223_372_036_854_775_808.0);

impl InputSample for f32 {
    #[inline]
    fn normalized(self) -> f64 {
        f64::from(self)
    }
}

impl InputSample for f64 {
    #[inline]
    fn normalized(self) -> f64 {
        self
    }
}
