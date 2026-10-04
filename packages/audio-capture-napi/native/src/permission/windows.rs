// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::ffi::c_void;
use std::ptr;

type Hkey = *mut c_void;

const ERROR_SUCCESS: i32 = 0;
const KEY_QUERY_VALUE: u32 = 0x0001;
const REG_SZ: u32 = 1;
const HKEY_CURRENT_USER: Hkey = 0x8000_0001_usize as Hkey;
const MICROPHONE_KEY: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

#[link(name = "Advapi32")]
extern "system" {
    #[link_name = "RegOpenKeyExW"]
    fn reg_open_key_ex_w(
        key: Hkey,
        sub_key: *const u16,
        options: u32,
        desired_access: u32,
        result: *mut Hkey,
    ) -> i32;
    #[link_name = "RegQueryValueExW"]
    fn reg_query_value_ex_w(
        key: Hkey,
        value_name: *const u16,
        reserved: *mut u32,
        value_type: *mut u32,
        data: *mut u8,
        data_length: *mut u32,
    ) -> i32;
    #[link_name = "RegCloseKey"]
    fn reg_close_key(key: Hkey) -> i32;
}

pub(super) fn status() -> u32 {
    read_consent().map_or(3, |value| {
        if value.eq_ignore_ascii_case("deny") {
            2
        } else {
            3
        }
    })
}

fn read_consent() -> Option<String> {
    let sub_key = wide_string(MICROPHONE_KEY);
    let value_name = wide_string("Value");
    let mut key: Hkey = ptr::null_mut();

    // SAFETY: Windows receives valid NUL-terminated UTF-16 strings and a valid
    // out-pointer. A successfully opened key is closed on every later path.
    let open_result = unsafe {
        reg_open_key_ex_w(
            HKEY_CURRENT_USER,
            sub_key.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut key,
        )
    };
    if open_result != ERROR_SUCCESS || key.is_null() {
        return None;
    }

    let result = read_string_value(key, &value_name);
    // SAFETY: `key` was successfully returned by RegOpenKeyExW above.
    unsafe {
        let _ = reg_close_key(key);
    }
    result
}

fn read_string_value(key: Hkey, value_name: &[u16]) -> Option<String> {
    let mut value_type = 0_u32;
    let mut byte_length = 0_u32;
    // SAFETY: This first query intentionally supplies a null data pointer to
    // obtain the required byte count.
    let size_result = unsafe {
        reg_query_value_ex_w(
            key,
            value_name.as_ptr(),
            ptr::null_mut(),
            &mut value_type,
            ptr::null_mut(),
            &mut byte_length,
        )
    };
    if size_result != ERROR_SUCCESS || value_type != REG_SZ || byte_length < 2 {
        return None;
    }

    let unit_count = usize::try_from(byte_length).ok()?.checked_add(1)? / 2;
    let mut buffer = vec![0_u16; unit_count];
    // SAFETY: The byte length came from RegQueryValueExW, and `buffer` has at
    // least that many bytes of writable storage.
    let read_result = unsafe {
        reg_query_value_ex_w(
            key,
            value_name.as_ptr(),
            ptr::null_mut(),
            &mut value_type,
            buffer.as_mut_ptr().cast(),
            &mut byte_length,
        )
    };
    if read_result != ERROR_SUCCESS || value_type != REG_SZ {
        return None;
    }

    let string_length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16(&buffer[..string_length]).ok()
}

fn wide_string(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
