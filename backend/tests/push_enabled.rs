//! lib/config.ts `PUSH_ENABLED = envInt("KB_PUSH", 1, 0) !== 0`: KB_PUSH=0 switches push off.
//! Alone in its binary: it sets the environment.

use unimaps::config::PUSH_ENABLED;

#[test]
fn kb_push_zero_is_off() {
    // SAFETY: the only test in this binary, set before anything reads the environment
    unsafe { std::env::set_var("KB_PUSH", "0") };
    assert!(!*PUSH_ENABLED);
}
