// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

pub(crate) fn status() -> u32 {
    platform_status()
}

#[cfg(target_os = "macos")]
fn platform_status() -> u32 {
    macos::status()
}

#[cfg(target_os = "windows")]
fn platform_status() -> u32 {
    windows::status()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_status() -> u32 {
    3
}
