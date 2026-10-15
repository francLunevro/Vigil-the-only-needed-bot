import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './ui.jsx';

// ──────────────────── Command palette (Ctrl+K) ────────────────────
// Port of the vanilla motion-layer palette: a fuzzy-filtered list of every
// nav destination, opened with Ctrl+K / ⌘K, driven entirely by keyboard
// (arrows + enter, Escape closes). Choosing an item navigates via the
// hash router, so deep links and the back button keep working.

export default function CommandPalette({ open, onClose, navigate, sections }) {
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState(0);
    const inputRef = useRef(null);
    const listRef = useRef(null);

    const items = useMemo(() => {
        const q = query.trim().toLowerCase();
        const all = sections.map((s) => ({ id: s.id, label: s.label, group: s.group || '' }));
        if (!q) return all;
        // Subsequence match: "usr" hits "Servers", "cmd heat" hits "Command Heatmap".
        return all.filter((item) => {
            const hay = (item.label + ' ' + item.group).toLowerCase();
            let i = 0;
            for (const ch of q) {
                if (ch === ' ') continue;
                i = hay.indexOf(ch, i);
                if (i === -1) return false;
                i++;
            }
            return true;
        });
    }, [query, sections]);

    // Reset state whenever the palette opens, and focus the input.
    useEffect(() => {
        if (open) {
            setQuery('');
            setSelected(0);
            // Focus after paint so the overlay is in the DOM.
            const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
            return () => clearTimeout(t);
        }
        return undefined;
    }, [open]);

    // Keep the selected row visible while arrowing through the list.
    useEffect(() => {
        const list = listRef.current;
        const row = list && list.children[selected];
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    }, [selected]);

    if (!open) return null;

    function choose(item) {
        if (!item) return;
        navigate(item.id);
        onClose();
    }

    function onKeyDown(e) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelected((s) => Math.min(s + 1, items.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelected((s) => Math.max(s - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(items[selected]);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    }

    return (
        <div className="palette-overlay" onMouseDown={onClose}>
            <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
                <div className="palette-input-row">
                    <Icon name="terminal" size={15} />
                    <input
                        ref={inputRef}
                        value={query}
                        placeholder="Jump to… (Esc to close)"
                        onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
                        spellCheck="false"
                    />
                    <span className="palette-kbd">Ctrl K</span>
                </div>
                <div className="palette-list" ref={listRef}>
                    {items.length === 0 && <div className="palette-empty">No matches</div>}
                    {items.map((item, i) => (
                        <button
                            key={item.id}
                            type="button"
                            className={'palette-item' + (i === selected ? ' sel' : '')}
                            onMouseEnter={() => setSelected(i)}
                            onClick={() => choose(item)}
                        >
                            <span className="palette-label">{item.label}</span>
                            {item.group && <span className="palette-group">{item.group}</span>}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
