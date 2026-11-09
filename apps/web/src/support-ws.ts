import type { TokenProvider } from './auth.ts';
export function subscribeSupport(getToken: TokenProvider, sessionId: string | undefined, receive: (value: unknown) => void, onStatus: (connected: boolean) => void = () => {}) {
    let active = true, socket: WebSocket, timer: ReturnType<typeof setTimeout>;
    function connect() {
        if (!active) return;
        const url = new URL('/api/v1/ws', location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        if (sessionId) url.searchParams.set('sessionId', sessionId);
        try { socket = new WebSocket(url); }
        catch { onStatus(false); timer = setTimeout(connect, 3000); return; }
        const current = socket;
        socket.onopen = async () => {
            try {
                const token = await getToken();
                if (active && current === socket && current.readyState === WebSocket.OPEN)
                    current.send(JSON.stringify({ type: 'auth', idToken: token }));
            } catch { current.close(); }
        };
        socket.onmessage = event => { if (!active || current !== socket) return; try { receive(JSON.parse(event.data)); onStatus(true); } catch { current.close(); } };
        socket.onclose = () => { if (active && current === socket) { onStatus(false); timer = setTimeout(connect, 3000); } };
        socket.onerror = () => current.close();
    }
    connect();
    return () => { active = false; clearTimeout(timer); socket?.close(); };
}
