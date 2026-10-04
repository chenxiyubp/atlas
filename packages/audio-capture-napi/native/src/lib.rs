// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

mod permission;
mod playback;
mod record;
mod resample;
mod ring;

use std::panic::{catch_unwind, AssertUnwindSafe};

use napi::bindgen_prelude::Buffer;
use napi::{Env, JsFunction};
use napi_derive::napi;

#[napi]
pub fn start_recording(env: Env, on_data: JsFunction, on_end: JsFunction) -> bool {
    catch_unwind(AssertUnwindSafe(|| record::start(env, on_data, on_end))).unwrap_or(false)
}

#[napi]
pub fn stop_recording() {
    let _ = catch_unwind(record::stop);
}

#[napi]
pub fn is_recording() -> bool {
    catch_unwind(record::is_active).unwrap_or(false)
}

#[napi]
pub fn start_playback(sample_rate: u32, channels: u32) -> bool {
    catch_unwind(|| playback::start(sample_rate, channels)).unwrap_or(false)
}

#[napi]
pub fn write_playback_data(data: Buffer) {
    let _ = catch_unwind(AssertUnwindSafe(|| playback::write(&data)));
}

#[napi]
pub fn stop_playback() {
    let _ = catch_unwind(playback::stop);
}

#[napi]
pub fn is_playing() -> bool {
    catch_unwind(playback::is_active).unwrap_or(false)
}

#[napi]
pub fn microphone_authorization_status() -> u32 {
    catch_unwind(permission::status).unwrap_or(3)
}
