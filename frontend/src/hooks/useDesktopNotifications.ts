// frontend/src/hooks/useDesktopNotifications.ts
import { useEffect, useRef } from "react";
import { isTauri } from "@/lib/runtime";

type NotifyArgs = {
    title: string;
    body: string;
    chatId?: number | string;
    icon?: string;
};

let permissionGranted = false;
let pendingChatId: number | string | null = null;

/**
 * Returns the chatId of the most-recent notification, if any.
 * Single-read: subsequent reads return null until a new notification is sent.
 */
export function getPendingChatId(): number | string | null {
    const cid = pendingChatId;
    pendingChatId = null;
    return cid;
}

/**
 * Hook returning a `notify` function. On first mount in Tauri, requests OS permission.
 * No-op on web. On Tauri desktop: shows native notification.
 */
export function useDesktopNotifications() {
    const ready = useRef(false);

    useEffect(() => {
        if (!isTauri()) return;
        let cancelled = false;
        (async () => {
            try {
                const { isPermissionGranted, requestPermission } = await import(
                    "@tauri-apps/plugin-notification"
                );
                let granted = await isPermissionGranted();
                if (!granted) {
                    const res = await requestPermission();
                    granted = res === "granted";
                }
                if (!cancelled) {
                    permissionGranted = granted;
                    ready.current = granted;
                }
            } catch (e) {
                console.warn("[notifications] init failed", e);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const notify = async (args: NotifyArgs) => {
        if (!isTauri() || !permissionGranted) return;
        try {
            const { sendNotification } = await import("@tauri-apps/plugin-notification");
            sendNotification({
                title: args.title,
                body: args.body,
                icon: args.icon,
            });
            if (args.chatId !== undefined && args.chatId !== null) {
                pendingChatId = args.chatId;
            }
        } catch (e) {
            console.warn("[notifications] send failed", e);
        }
    };

    return { notify, ready: ready.current };
}
