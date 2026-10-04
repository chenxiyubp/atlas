// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::ffi::{c_char, c_int, c_void};

const RTLD_LAZY: c_int = 0x1;
const AVFOUNDATION_PATH: &[u8] =
    b"/System/Library/Frameworks/AVFoundation.framework/AVFoundation\0";
const AUDIO_MEDIA_TYPE_SYMBOL: &[u8] = b"AVMediaTypeAudio\0";
const CAPTURE_DEVICE_CLASS: &[u8] = b"AVCaptureDevice\0";
const AUTHORIZATION_SELECTOR: &[u8] = b"authorizationStatusForMediaType:\0";

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_msgSend();
}

extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlclose(handle: *mut c_void) -> c_int;
}

pub(super) fn status() -> u32 {
    // SAFETY: All C strings below are statically NUL-terminated. The framework
    // handle stays open until after the Objective-C message has returned.
    unsafe {
        let framework = dlopen(AVFOUNDATION_PATH.as_ptr().cast(), RTLD_LAZY);
        if framework.is_null() {
            return 3;
        }

        let result = query_status(framework).unwrap_or(3);
        let _ = dlclose(framework);
        result
    }
}

unsafe fn query_status(framework: *mut c_void) -> Option<u32> {
    let class = objc_getClass(CAPTURE_DEVICE_CLASS.as_ptr().cast());
    let selector = sel_registerName(AUTHORIZATION_SELECTOR.as_ptr().cast());
    let media_type_symbol = dlsym(framework, AUDIO_MEDIA_TYPE_SYMBOL.as_ptr().cast());
    if class.is_null() || selector.is_null() || media_type_symbol.is_null() {
        return None;
    }

    // `AVMediaTypeAudio` is an exported NSString pointer, so dlsym returns the
    // address of that pointer rather than the NSString object itself.
    let media_type = media_type_symbol.cast::<*mut c_void>().read();
    if media_type.is_null() {
        return None;
    }

    type AuthorizationStatusMessage =
        unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> isize;
    // objc_msgSend is variadic at the ABI level. Giving this call site its exact
    // signature is required on aarch64; invoking an untyped declaration would
    // be undefined behavior.
    let send =
        std::mem::transmute::<*const (), AuthorizationStatusMessage>(objc_msgSend as *const ());
    let status = send(class, selector, media_type);
    u32::try_from(status).ok().filter(|value| *value <= 3)
}
