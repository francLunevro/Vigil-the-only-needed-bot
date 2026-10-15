import { createContext, useCallback, useContext, useMemo, useState } from 'react';

// Toasts replace the vanilla dashboard's global `showToast()` DOM hack with a
// real React context — any screen can report success/failure without reaching
// into the document.

const ToastContext = createContext(() => {});

export function useToast() {
    return useContext(ToastContext);
}

export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);

    const push = useCallback((message, isError = false) => {
        const id = Date.now() + Math.random();
        setToasts((list) => [...list, { id, message, isError }]);
        setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 3000);
    }, []);

    const value = useMemo(() => push, [push]);

    return (
        <ToastContext.Provider value={value}>
            {children}
            <div className="toast-stack" role="status" aria-live="polite">
                {toasts.map((t) => (
                    <div key={t.id} className={'toast' + (t.isError ? ' toast-err' : '')}>{t.message}</div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}
