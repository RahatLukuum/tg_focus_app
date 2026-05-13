// frontend/src/components/DeepLinkHandler.tsx
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { isTauri } from "@/lib/runtime";
import { getPendingChatId } from "@/hooks/useDesktopNotifications";

/**
 * Listens for window focus events (Tauri only).
 * When the window gains focus, checks if there is a pending chatId from
 * a desktop notification and navigates to the corresponding chat route.
 *
 * Must be rendered inside a Router context so that `useNavigate` is available.
 * Renders nothing — purely a side-effect component.
 */
function DeepLinkHandler() {
    const navigate = useNavigate();

    useEffect(() => {
        if (!isTauri()) return;

        let unlisten: (() => void) | undefined;

        (async () => {
            try {
                const { getCurrentWindow } = await import("@tauri-apps/api/window");
                const w = getCurrentWindow();
                unlisten = await w.onFocusChanged(({ payload: focused }) => {
                    if (focused) {
                        const chatId = getPendingChatId();
                        if (chatId !== null && chatId !== undefined) {
                            navigate(`/chat/${chatId}`);
                        }
                    }
                });
            } catch (e) {
                console.warn("[deep-link] init failed", e);
            }
        })();

        return () => {
            unlisten?.();
        };
    }, [navigate]);

    return null;
}

export default DeepLinkHandler;
