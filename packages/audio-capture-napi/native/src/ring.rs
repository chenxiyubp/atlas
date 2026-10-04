// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicUsize, Ordering};

/// A bounded single-producer/single-consumer ring.
///
/// The CPAL input callback is the sole producer and the recording pump is the
/// sole consumer. Storage is allocated before the stream starts, so `push`
/// and `pop` neither allocate nor take a lock.
pub(crate) struct SpscRing<T: Copy + Default> {
    slots: Box<[UnsafeCell<T>]>,
    read: AtomicUsize,
    write: AtomicUsize,
}

// SAFETY: Only the producer writes the slot at `write`, only the consumer
// reads the slot at `read`, and the acquire/release atomics publish each slot
// before it can be observed by the other thread.
unsafe impl<T: Copy + Default + Send> Send for SpscRing<T> {}
// SAFETY: The SPSC access discipline described above permits shared references
// to the ring across exactly one producer and one consumer.
unsafe impl<T: Copy + Default + Send> Sync for SpscRing<T> {}

impl<T: Copy + Default> SpscRing<T> {
    pub(crate) fn new(usable_capacity: usize) -> Option<Self> {
        let slot_count = usable_capacity.checked_add(1)?;
        let mut slots = Vec::new();
        slots.try_reserve_exact(slot_count).ok()?;
        slots.resize_with(slot_count, || UnsafeCell::new(T::default()));
        Some(Self {
            slots: slots.into_boxed_slice(),
            read: AtomicUsize::new(0),
            write: AtomicUsize::new(0),
        })
    }

    /// Returns false when the bounded ring is full. Dropping a fresh capture
    /// sample is preferable to blocking the platform's real-time audio thread.
    #[inline]
    pub(crate) fn push(&self, value: T) -> bool {
        let write = self.write.load(Ordering::Relaxed);
        let next = self.increment(write);
        if next == self.read.load(Ordering::Acquire) {
            return false;
        }

        // SAFETY: In SPSC use, only the producer accesses the current write
        // slot until the release-store below publishes it to the consumer.
        unsafe {
            *self.slots[write].get() = value;
        }
        self.write.store(next, Ordering::Release);
        true
    }

    #[inline]
    pub(crate) fn pop(&self) -> Option<T> {
        let read = self.read.load(Ordering::Relaxed);
        if read == self.write.load(Ordering::Acquire) {
            return None;
        }

        // SAFETY: The acquire-load above observes the producer's release, and
        // only the consumer accesses the current read slot until it advances.
        let value = unsafe { *self.slots[read].get() };
        self.read.store(self.increment(read), Ordering::Release);
        Some(value)
    }

    #[inline]
    fn increment(&self, index: usize) -> usize {
        if index + 1 == self.slots.len() {
            0
        } else {
            index + 1
        }
    }
}
