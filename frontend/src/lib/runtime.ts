/**
 * Returns true if running inside Tauri desktop shell.
 */
export function isTauri(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
