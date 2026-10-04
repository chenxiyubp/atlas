// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock, TryLockError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

const START_TIMEOUT: Duration = Duration::from_secs(5);

static OPERATION_LOCK: Mutex<()> = Mutex::new(());
static HANDLE: OnceLock<Mutex<Option<PlaybackHandle>>> = OnceLock::new();

struct PlaybackQueue {
    samples: VecDeque<i16>,
    trailing_byte: Option<u8>,
}

pub(crate) struct PlaybackHandle {
    stop_tx: mpsc::Sender<()>,
    cancelled: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    worker: JoinHandle<()>,
    queue: Arc<Mutex<PlaybackQueue>>,
}

pub(crate) fn start(sample_rate: u32, channels: u32) -> bool {
    let _operation = lock_recover(&OPERATION_LOCK);
    stop_current();

    if sample_rate == 0 {
        return false;
    }
    let Ok(channels) = u16::try_from(channels) else {
        return false;
    };
    if channels == 0 {
        return false;
    }

    let queue = Arc::new(Mutex::new(PlaybackQueue {
        samples: VecDeque::new(),
        trailing_byte: None,
    }));
    let (stop_tx, stop_rx) = mpsc::channel();
    let (status_tx, status_rx) = mpsc::sync_channel(1);
    let cancelled = Arc::new(AtomicBool::new(false));
    let running = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let worker_running = Arc::clone(&running);
    let worker_queue = Arc::clone(&queue);
    let worker = match thread::Builder::new()
        .name("audio-capture-output".to_owned())
        .spawn(move || {
            playback_worker(
                stop_rx,
                status_tx,
                worker_cancelled,
                worker_running,
                worker_queue,
                sample_rate,
                channels,
            );
        }) {
        Ok(worker) => worker,
        Err(_) => return false,
    };

    match status_rx.recv_timeout(START_TIMEOUT) {
        Ok(true) => {
            *lock_recover(handle_slot()) = Some(PlaybackHandle {
                stop_tx,
                cancelled,
                running,
                worker,
                queue,
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
            drop(worker);
            false
        }
    }
}

pub(crate) fn write(data: &[u8]) {
    if data.is_empty() {
        return;
    }

    let queue = lock_recover(handle_slot())
        .as_ref()
        .filter(|handle| handle.running.load(Ordering::Acquire))
        .map(|handle| Arc::clone(&handle.queue));
    let Some(queue) = queue else {
        return;
    };
    let mut queue = lock_recover(&queue);
    let mut offset = 0;

    if let Some(low_byte) = queue.trailing_byte.take() {
        if let Some(high_byte) = data.first() {
            queue
                .samples
                .push_back(i16::from_le_bytes([low_byte, *high_byte]));
            offset = 1;
        } else {
            queue.trailing_byte = Some(low_byte);
            return;
        }
    }

    let mut pairs = data[offset..].chunks_exact(2);
    for pair in &mut pairs {
        queue
            .samples
            .push_back(i16::from_le_bytes([pair[0], pair[1]]));
    }
    queue.trailing_byte = pairs.remainder().first().copied();
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

fn handle_slot() -> &'static Mutex<Option<PlaybackHandle>> {
    HANDLE.get_or_init(|| Mutex::new(None))
}

fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn playback_worker(
    stop_rx: mpsc::Receiver<()>,
    status_tx: mpsc::SyncSender<bool>,
    cancelled: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    queue: Arc<Mutex<PlaybackQueue>>,
    sample_rate: u32,
    channels: u16,
) {
    let host = cpal::default_host();
    let Some(device) = host.default_output_device() else {
        let _ = status_tx.send(false);
        return;
    };
    let Ok(default_config) = device.default_output_config() else {
        let _ = status_tx.send(false);
        return;
    };
    let sample_format = default_config.sample_format();
    let config = cpal::StreamConfig {
        channels,
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    let stream =
        match build_output_stream(&device, &config, sample_format, queue, Arc::clone(&running)) {
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
    if status_tx.send(true).is_err() {
        running.store(false, Ordering::Release);
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
}

fn build_output_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    queue: Arc<Mutex<PlaybackQueue>>,
    running: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    match sample_format {
        cpal::SampleFormat::I8 => build_typed_output_stream::<i8>(device, config, queue, running),
        cpal::SampleFormat::I16 => build_typed_output_stream::<i16>(device, config, queue, running),
        cpal::SampleFormat::I32 => build_typed_output_stream::<i32>(device, config, queue, running),
        cpal::SampleFormat::I64 => build_typed_output_stream::<i64>(device, config, queue, running),
        cpal::SampleFormat::U8 => build_typed_output_stream::<u8>(device, config, queue, running),
        cpal::SampleFormat::U16 => build_typed_output_stream::<u16>(device, config, queue, running),
        cpal::SampleFormat::U32 => build_typed_output_stream::<u32>(device, config, queue, running),
        cpal::SampleFormat::U64 => build_typed_output_stream::<u64>(device, config, queue, running),
        cpal::SampleFormat::F32 => build_typed_output_stream::<f32>(device, config, queue, running),
        cpal::SampleFormat::F64 => build_typed_output_stream::<f64>(device, config, queue, running),
        _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
    }
}

fn build_typed_output_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    queue: Arc<Mutex<PlaybackQueue>>,
    running: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample + OutputSample,
{
    let error_running = Arc::clone(&running);
    device.build_output_stream(
        config,
        move |output: &mut [T], _| {
            if running.load(Ordering::Relaxed) {
                fill_output(output, &queue);
            } else {
                output.fill(T::from_pcm(0));
            }
        },
        move |_| error_running.store(false, Ordering::Release),
        None,
    )
}

#[inline]
fn fill_output<T: OutputSample>(output: &mut [T], queue: &Mutex<PlaybackQueue>) {
    match queue.try_lock() {
        Ok(mut queue) => fill_from_queue(output, &mut queue.samples),
        Err(TryLockError::Poisoned(poisoned)) => {
            fill_from_queue(output, &mut poisoned.into_inner().samples);
        }
        Err(TryLockError::WouldBlock) => output.fill(T::from_pcm(0)),
    }
}

#[inline]
fn fill_from_queue<T: OutputSample>(output: &mut [T], samples: &mut VecDeque<i16>) {
    for destination in output {
        *destination = T::from_pcm(samples.pop_front().unwrap_or(0));
    }
}

trait OutputSample: Copy + Send + 'static {
    fn from_pcm(sample: i16) -> Self;
}

impl OutputSample for i8 {
    #[inline]
    fn from_pcm(sample: i16) -> Self {
        (sample >> 8) as i8
    }
}

impl OutputSample for i16 {
    #[inline]
    fn from_pcm(sample: i16) -> Self {
        sample
    }
}

impl OutputSample for i32 {
    #[inline]
    fn from_pcm(sample: i16) -> Self {
        i32::from(sample) << 16
    }
}

impl OutputSample for i64 {
    #[inline]
    fn from_pcm(sample: i16) -> Self {
        i64::from(sample) << 48
    }
}

impl OutputSample for u8 {
    #[inline]
    fn from_pcm(sample: i16) -> Self {
        ((i32::from(sample) + 32_768) >> 8) as u8
    }
}

impl OutputSample for u16 {
    #[inline]
    fn from_pcm(sample: i16) -> Self {
        (i32::from(sample) + 32_768) as u16
    }
}

impl OutputSample for u32 {
    #[inline]
    fn from_pcm(sample: i16) -> Self {
        ((i64::from(sample) + 32_768) as u32) << 16
    }
}

impl OutputSample for u64 {
    #[inline]
    fn from_pcm(sample: i16) -> Self {
        ((i64::from(sample) + 32_768) as u64) << 48
    }
}

impl OutputSample for f32 {
    #[inline]
    fn from_pcm(sample: i16) -> Self {
        f32::from(sample) / 32_768.0
    }
}

impl OutputSample for f64 {
    #[inline]
    fn from_pcm(sample: i16) -> Self {
        f64::from(sample) / 32_768.0
    }
}
